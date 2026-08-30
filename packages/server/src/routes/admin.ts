import type { Hono } from "hono"
import { randomBytes } from "node:crypto"
import { z } from "zod"
import type { MiraDB } from "../storage/db.js"

const ownerSchema = z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9._-]+$/, "owner must be alphanumeric, dot, underscore or hyphen")
const MAX_KEYS = 100

export function mountAdminRoutes(
  app: Hono<{ Variables: { requestId: string } }>,
  deps: {
    db: MiraDB
    REQUIRED_TOKEN: string
    API_KEY_OWNERS: Map<string, string>
    resolveOwner: (t: string) => string | undefined
    bearerOf: (h: string | undefined) => string
    sessionOwnerCache: Map<string, { owner: string | null; ts: number }>
  },
) {
  const { db, REQUIRED_TOKEN, API_KEY_OWNERS, resolveOwner, bearerOf, sessionOwnerCache } = deps

  // Admin = the master MIRA_TOKEN (owner "default"). In open/dev mode (no
  // REQUIRED_TOKEN) the endpoints are reachable without auth, matching the
  // server's "auth disabled" posture.
  const isAdmin = (c: { req: { header: (n: string) => string | undefined } }): boolean => {
    if (!REQUIRED_TOKEN) return true
    return resolveOwner(bearerOf(c.req.header("Authorization"))) === "default"
  }
  const deny = (c: { json: (b: unknown, s: number) => Response }) => c.json({ error: "unauthorized" }, 401)

  let tableEnsured = false
  const ensureTable = () => {
    if (tableEnsured) return
    db.sqlite.exec(`CREATE TABLE IF NOT EXISTS api_keys (
      key TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      created_by TEXT NOT NULL DEFAULT 'default'
    ); CREATE INDEX IF NOT EXISTS api_keys_owner_idx ON api_keys(owner);`)
    tableEnsured = true
  }

  // Mint a scoped API key for a user (admin only). Returns the raw key once.
  app.post("/admin/api-keys", async c => {
    if (!isAdmin(c)) return deny(c)
    let body: { owner?: unknown } = {}
    try { body = (await c.req.json()) as { owner?: unknown } } catch {}
    const parsed = ownerSchema.safeParse(typeof body.owner === "string" ? body.owner : "user")
    if (!parsed.success) return c.json({ error: "invalid owner", issues: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`) }, 400)
    const owner = parsed.data
    ensureTable()
    const count = (db.sqlite.prepare("SELECT COUNT(*) as n FROM api_keys").get() as { n: number }).n
    if (count >= MAX_KEYS) return c.json({ error: `key limit reached (${MAX_KEYS}) — revoke unused keys first` }, 429)
    const key = randomBytes(48).toString("hex")
    db.sqlite
      .prepare("INSERT INTO api_keys (key, owner, created_at, created_by) VALUES (?, ?, ?, ?)")
      .run(key, owner, Date.now(), "default")
    API_KEY_OWNERS.set(key, owner)
    console.log(`[admin] mint key for owner="${owner}" preview=${key.slice(0,6)}…${key.slice(-4)}`)
    return c.json({ key, owner }, 201)
  })

  // List issued keys (admin only). Raw keys are masked; revoke by full key.
  app.get("/admin/api-keys", async c => {
    if (!isAdmin(c)) return deny(c)
    ensureTable()
    const rows = db.sqlite
      .prepare("SELECT key, owner, created_at, created_by FROM api_keys ORDER BY created_at DESC")
      .all() as Array<{ key: string; owner: string; created_at: number; created_by: string }>
    const issued = rows.map(r => ({
      owner: r.owner,
      created_at: r.created_at,
      created_by: r.created_by,
      key_preview: `${r.key.slice(0, 6)}…${r.key.slice(-4)}`,
    }))
    return c.json({ count: rows.length, issued })
  })

  // Revoke a key (admin only).
  app.delete("/admin/api-keys/:key", async c => {
    if (!isAdmin(c)) return deny(c)
    const key = c.req.param("key")
    if (!key || key.length < 32) return c.json({ error: "not found" }, 404)
    ensureTable()
    const existing = db.sqlite.prepare("SELECT 1 FROM api_keys WHERE key = ?").get(key) as { "1": number } | undefined
    db.sqlite.prepare("DELETE FROM api_keys WHERE key = ?").run(key)
    API_KEY_OWNERS.delete(key)
    sessionOwnerCache.clear()
    if (existing) console.log(`[admin] revoke key preview=${key.slice(0,6)}…${key.slice(-4)}`)
    return c.json({ ok: true, key: existing ? `${key.slice(0,6)}…${key.slice(-4)}` : "not found" })
  })
}
