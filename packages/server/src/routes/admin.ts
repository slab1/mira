import type { Hono } from "hono"
import { randomBytes } from "node:crypto"
import { z } from "zod"
import type { MiraDB } from "../storage/db.js"
import type { JsonValue, MiraConfig } from "../types/index.js"
import { getConfig, saveConfig, mergeModelCatalog, removeProviderModelFromConfig, type ModelCatalogEntry } from "../config/index.js"

const ownerSchema = z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9._-]+$/, "owner must be alphanumeric, dot, underscore or hyphen")
const MAX_KEYS = 100

// ── Curated model catalog payloads ────────────────────────────────
const modelEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  limit: z.object({ context: z.number().positive(), output: z.number().positive() }).optional(),
  enabled: z.boolean().optional(),
  deprecated: z.boolean().optional(),
  pricing: z.object({ prompt: z.number().nonnegative(), completion: z.number().nonnegative() }).optional(),
  capabilities: z.array(z.string()).optional(),
}).passthrough()
const modelEntriesSchema = z.array(modelEntrySchema)
const modelPatchSchema = z.object({
  name: z.string().optional(),
  limit: z.object({ context: z.number().positive(), output: z.number().positive() }).optional(),
  enabled: z.boolean().optional(),
  deprecated: z.boolean().optional(),
  pricing: z.object({ prompt: z.number().nonnegative(), completion: z.number().nonnegative() }).optional(),
  capabilities: z.array(z.string()).optional(),
}).passthrough()

export function mountAdminRoutes(
  app: Hono<{ Variables: { requestId: string } }>,
  deps: {
    db: MiraDB
    REQUIRED_TOKEN: string
    API_KEY_OWNERS: Map<string, string>
    resolveOwner: (t: string) => string | undefined
    bearerOf: (h: string | undefined) => string
    sessionOwnerCache: Map<string, { owner: string | null; ts: number }>
    /** Live model source for catalog sync (auto-fetch when payload omits models) */
    gateway?: { listProviderModels?: (providerId: string) => Promise<Array<{ id: string; name: string; context: number }>> }
    /** Config write target dir — tests pass a tmpdir; default is process.cwd() */
    cwd?: string
  },
) {
  const { db, REQUIRED_TOKEN, API_KEY_OWNERS, resolveOwner, bearerOf, sessionOwnerCache } = deps
  const cfgDir = deps.cwd ?? process.cwd()

  // Admin = the master MIRA_TOKEN (owner "default"). In open/dev mode (no
  // REQUIRED_TOKEN) the endpoints are reachable without auth, matching the
  // server's "auth disabled" posture.
  const isAdmin = (c: { req: { header: (n: string) => string | undefined } }): boolean => {
    if (!REQUIRED_TOKEN) return true
    return resolveOwner(bearerOf(c.req.header("Authorization"))) === "default"
  }
  const deny = (c: { json: (b: JsonValue, s: number) => Response }) => c.json({ error: "unauthorized" }, 401)

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
    let body: { owner?: JsonValue } = {}
    try { body = (await c.req.json()) as { owner?: JsonValue } } catch {}
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

  // Queryable audit log (admin only) — DB mirror of file audit (Risk 2)
  app.get("/admin/audit", async c => {
    if (!isAdmin(c)) return deny(c)
    const tool = c.req.query("tool")
    const decision = c.req.query("decision") as "allow" | "deny" | "warn" | undefined
    const sessionID = c.req.query("sessionID") ?? c.req.query("session_id")
    const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? "50") || 50))
    // Ensure table exists (migrate may not have run on older DB)
    try {
      db.sqlite.exec(
        "CREATE TABLE IF NOT EXISTS audit_entries (id TEXT PRIMARY KEY, session_id TEXT, tool TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT, args TEXT, result TEXT, created_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS audit_entries_session_idx ON audit_entries(session_id); CREATE INDEX IF NOT EXISTS audit_entries_tool_idx ON audit_entries(tool); CREATE INDEX IF NOT EXISTS audit_entries_decision_idx ON audit_entries(decision); CREATE INDEX IF NOT EXISTS audit_entries_created_idx ON audit_entries(created_at);"
      )
    } catch {}
    let sql = "SELECT id, session_id as sessionID, tool, decision, reason, args, result, created_at as createdAt FROM audit_entries WHERE 1=1"
    const params: Array<string | number> = []
    if (tool) { sql += " AND tool = ?"; params.push(tool) }
    if (decision && ["allow", "deny", "warn"].includes(decision)) { sql += " AND decision = ?"; params.push(decision) }
    if (sessionID) { sql += " AND session_id = ?"; params.push(sessionID) }
    sql += " ORDER BY created_at DESC LIMIT ?"
    params.push(limit)
    try {
      const rows = db.sqlite.prepare(sql).all(...params) as Array<Record<string, JsonValue>>
      // Parse JSON fields for convenience
      const entries = rows.map(r => ({
        ...r,
        args: (() => { try { return r.args ? JSON.parse(r.args as string) : null } catch { return r.args } })(),
        result: (() => { try { return r.result ? JSON.parse(r.result as string) : null } catch { return r.result } })(),
      }))
      return c.json({ count: entries.length, entries })
    } catch (e) {
      return c.json({ error: String(e) }, 500)
    }
  })

  // ── Curated model catalog (single source of truth; admin only) ────

  // Sync the provider's catalog into the config registry (upsert, NEVER deletes).
  // Body: { models: [...] } — or empty/auto to fetch the live catalog from the provider.
  // Existing admin flags (enabled/deprecated/pricing/capabilities) are preserved unless
  // the payload explicitly overrides them. Models absent from the payload are kept.
  app.post("/admin/providers/:id/models/sync", async c => {
    if (!isAdmin(c)) return deny(c)
    const id = c.req.param("id")
    const cfg = getConfig()
    const prov = cfg.provider?.[id]
    if (!prov) return c.json({ error: "provider not found" }, 404)
    const body = (await c.req.json().catch(() => null)) as { models?: unknown; auto?: unknown } | null
    let incoming: Array<ModelCatalogEntry & { id: string }> = []
    if (body && Array.isArray(body.models)) {
      const parsed = modelEntriesSchema.safeParse(body.models)
      if (parsed.success) incoming = parsed.data as Array<ModelCatalogEntry & { id: string }>
    }
    // Auto-fetch: payload omitted models (or auto:true) → pull live catalog from the provider
    if (incoming.length === 0 && deps.gateway?.listProviderModels) {
      const live = await deps.gateway.listProviderModels(id)
      incoming = live.map(m => ({
        // registry keys are BARE ids — strip the `provider/` prefix live fetches add
        id: m.id.startsWith(`${id}/`) ? m.id.slice(id.length + 1) : m.id,
        name: m.name,
        limit: m.context ? { context: m.context, output: 4096 } : undefined,
      }))
      console.log(`[admin] sync ${id}: fetched ${live.length} live models`)
    }
    const { models, result } = mergeModelCatalog(prov.models ?? {}, incoming)
    if (incoming.length > 0) {
      await saveConfig({ provider: { [id]: { models } } } as Partial<MiraConfig>, "project", cfgDir)
      console.log(`[admin] sync ${id}: result=${JSON.stringify(result)}`)
    }
    return c.json({ ok: true, provider: id, ...result })
  })

  // Update one catalog entry's flags/metadata (hide-before-delete: enabled:false keeps
  // the model callable by ref but removes it from the picker).
  app.patch("/admin/providers/:id/models/:modelId", async c => {
    if (!isAdmin(c)) return deny(c)
    const id = c.req.param("id")
    const modelId = c.req.param("modelId")
    const cfg = getConfig()
    const prov = cfg.provider?.[id]
    if (!prov) return c.json({ error: "provider not found" }, 404)
    const existing = prov.models?.[modelId]
    if (!existing) return c.json({ error: "model not found" }, 404)
    const body = (await c.req.json().catch(() => null)) as Record<string, JsonValue> | null
    const parsed = modelPatchSchema.safeParse(body ?? {})
    if (!parsed.success) {
      return c.json({ error: "invalid model patch", issues: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`) }, 400)
    }
    const { models } = mergeModelCatalog(prov.models ?? {}, [{ id: modelId, name: existing.name, ...parsed.data }] as Array<ModelCatalogEntry & { id: string }>)
    await saveConfig({ provider: { [id]: { models } } } as Partial<MiraConfig>, "project", cfgDir)
    const updated = getConfig().provider?.[id]?.models?.[modelId]
    return c.json({ ok: true, model: updated })
  })

  // Permanent delete (admin only) — removes the stored definition outright. This is the
  // final step after hide/deprecate; deleted models degrade gracefully in existing sessions.
  app.delete("/admin/providers/:id/models/:modelId", async c => {
    if (!isAdmin(c)) return deny(c)
    const id = c.req.param("id")
    const modelId = c.req.param("modelId")
    const cfg = getConfig()
    const prov = cfg.provider?.[id]
    if (!prov) return c.json({ error: "provider not found" }, 404)
    if (!prov.models?.[modelId]) return c.json({ error: "model not found" }, 404)
    const removed = await removeProviderModelFromConfig(id, modelId, cfgDir)
    console.log(`[admin] delete ${id}/${modelId}: removed=${removed}`)
    return c.json({ ok: removed })
  })
}
