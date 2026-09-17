import type { Hono } from 'hono'
import { randomBytes, createHash } from 'node:crypto'
import { z } from 'zod'
import type { MiraDB } from '../storage/db.js'
import type { JsonValue } from '../types/index.js'

const ownerSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9._-]+$/, 'owner must be alphanumeric, dot, underscore or hyphen')
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
  // server's "auth disabled" posture — but gated to loopback (P3-2).
  let adminOpenWarned = false
  const isAdmin = (c: { req: { header: (n: string) => string | undefined } }): boolean => {
    if (!REQUIRED_TOKEN && API_KEY_OWNERS.size === 0) {
      // Open/dev mode: only allow admin on loopback, otherwise 401 (P3-2).
      // A public bind (HOST=0.0.0.0 or any non-loopback) must NEVER open admin
      // without auth — the strict gate below applies to 0.0.0.0 too. The only
      // way to open admin on a non-loopback bind is the explicit operator
      // opt-out MIRA_STRICT_AUTH=0 (still warned).
      const host = process.env.HOST ?? '127.0.0.1'
      const strictLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
      if (!strictLoopback && process.env.MIRA_STRICT_AUTH !== '0') {
        return false
      }
      if (!adminOpenWarned) {
        adminOpenWarned = true
        console.warn(
          `[admin] open mode: admin endpoints reachable without auth (dev only, HOST=${host})`,
        )
      }
      return true
    }
    return resolveOwner(bearerOf(c.req.header('Authorization'))) === 'default'
  }
  const deny = (c: { json: (b: JsonValue, s: number) => Response }) =>
    c.json({ error: 'unauthorized' }, 401)

  let tableEnsured = false
  const ensureTable = () => {
    if (tableEnsured) return
    db.sqlite.exec(`CREATE TABLE IF NOT EXISTS api_keys (
      key TEXT PRIMARY KEY,
      key_hash TEXT,
      key_prefix TEXT,
      owner TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      created_by TEXT NOT NULL DEFAULT 'default'
    ); CREATE INDEX IF NOT EXISTS api_keys_owner_idx ON api_keys(owner);`)
    // Idempotent column adds for existing DBs (P3-1)
    try {
      db.sqlite.exec(`ALTER TABLE api_keys ADD COLUMN key_hash TEXT;`)
    } catch (e) {
      if (!String(e).includes('duplicate column name'))
        console.warn('[admin] addColumn key_hash failed:', String(e))
    }
    try {
      db.sqlite.exec(`ALTER TABLE api_keys ADD COLUMN key_prefix TEXT;`)
    } catch (e) {
      if (!String(e).includes('duplicate column name'))
        console.warn('[admin] addColumn key_prefix failed:', String(e))
    }
    tableEnsured = true
  }

  // Mint a scoped API key for a user (admin only). The raw key is stored
  // server-side (DB + API_KEY_OWNERS) for verification but is NEVER returned
  // in the response — only key_prefix + key_hash presence (Gap 2).
  app.post('/admin/api-keys', async (c) => {
    if (!isAdmin(c)) return deny(c)
    let body: { owner?: JsonValue } = {}
    try {
      body = (await c.req.json()) as { owner?: JsonValue }
    } catch {}
    const parsed = ownerSchema.safeParse(typeof body.owner === 'string' ? body.owner : 'user')
    if (!parsed.success)
      return c.json(
        {
          error: 'invalid owner',
          issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        },
        400,
      )
    const owner = parsed.data
    ensureTable()
    const count = (db.sqlite.prepare('SELECT COUNT(*) as n FROM api_keys').get() as { n: number }).n
    if (count >= MAX_KEYS)
      return c.json({ error: `key limit reached (${MAX_KEYS}) — revoke unused keys first` }, 429)
    const key = randomBytes(48).toString('hex')
    const keyHash = createHash('sha256').update(key).digest('hex')
    const keyPrefix = key.slice(0, 12)
    // Option 1 safe: DB bearer column `key` stores hash-only (DB dump ≠ bearer); raw kept only for log preview
    db.sqlite
      .prepare(
        'INSERT INTO api_keys (key, key_hash, key_prefix, owner, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(keyHash, keyHash, keyPrefix, owner, Date.now(), 'default')
    API_KEY_OWNERS.set(keyHash, owner)
    console.log(`[admin] mint key for owner="${owner}" preview=${key.slice(0, 6)}…${key.slice(-4)}`)
    return c.json({ key_prefix: keyPrefix, key_hash: true, owner }, 201)
  })

  // List issued keys (admin only). Raw keys are never selected or returned —
  // only key_prefix + key_hash presence (Gap 2).
  app.get('/admin/api-keys', async (c) => {
    if (!isAdmin(c)) return deny(c)
    ensureTable()
    const rows = db.sqlite
      .prepare(
        'SELECT key_prefix, key_hash, owner, created_at, created_by FROM api_keys ORDER BY created_at DESC',
      )
      .all() as Array<{
      key_prefix: string | null
      key_hash: string | null
      owner: string
      created_at: number
      created_by: string
    }>
    const issued = rows.map((r) => ({
      owner: r.owner,
      created_at: r.created_at,
      created_by: r.created_by,
      key_prefix: r.key_prefix ?? null,
      key_hash: !!r.key_hash,
    }))
    return c.json({ count: rows.length, issued })
  })

  // Revoke a key (admin only) — hash-aware + legacy fallback (key_hash=hash OR key=raw)
  app.delete('/admin/api-keys/:key', async (c) => {
    if (!isAdmin(c)) return deny(c)
    const key = c.req.param('key')
    if (!key || key.length < 32) return c.json({ error: 'not found' }, 404)
    ensureTable()
    const hash = createHash('sha256').update(key).digest('hex')
    const existing = db.sqlite
      .prepare('SELECT 1 FROM api_keys WHERE key_hash = ? OR key = ?')
      .get(hash, key) as { '1': number } | undefined
    db.sqlite.prepare('DELETE FROM api_keys WHERE key_hash = ? OR key = ?').run(hash, key)
    API_KEY_OWNERS.delete(hash)
    API_KEY_OWNERS.delete(key)
    sessionOwnerCache.clear()
    if (existing) console.log(`[admin] revoke key preview=${key.slice(0, 6)}…${key.slice(-4)}`)
    return c.json({ ok: true, key: existing ? `${key.slice(0, 6)}…${key.slice(-4)}` : 'not found' })
  })

  // Queryable audit log (admin only) — DB mirror of file audit (Risk 2)
  app.get('/admin/audit', async (c) => {
    if (!isAdmin(c)) return deny(c)
    const tool = c.req.query('tool')
    const decision = c.req.query('decision') as 'allow' | 'deny' | 'warn' | undefined
    const sessionID = c.req.query('sessionID') ?? c.req.query('session_id')
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? '50') || 50))
    // Ensure table exists (migrate may not have run on older DB)
    try {
      db.sqlite.exec(
        'CREATE TABLE IF NOT EXISTS audit_entries (id TEXT PRIMARY KEY, session_id TEXT, tool TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT, args TEXT, result TEXT, created_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS audit_entries_session_idx ON audit_entries(session_id); CREATE INDEX IF NOT EXISTS audit_entries_tool_idx ON audit_entries(tool); CREATE INDEX IF NOT EXISTS audit_entries_decision_idx ON audit_entries(decision); CREATE INDEX IF NOT EXISTS audit_entries_created_idx ON audit_entries(created_at);',
      )
    } catch {}
    let sql =
      'SELECT id, session_id as sessionID, tool, decision, reason, args, result, created_at as createdAt FROM audit_entries WHERE 1=1'
    const params: Array<string | number> = []
    if (tool) {
      sql += ' AND tool = ?'
      params.push(tool)
    }
    if (decision && ['allow', 'deny', 'warn'].includes(decision)) {
      sql += ' AND decision = ?'
      params.push(decision)
    }
    if (sessionID) {
      sql += ' AND session_id = ?'
      params.push(sessionID)
    }
    sql += ' ORDER BY created_at DESC LIMIT ?'
    params.push(limit)
    try {
      const rows = db.sqlite.prepare(sql).all(...params) as Array<Record<string, JsonValue>>
      // Parse JSON fields for convenience
      const entries = rows.map((r) => ({
        ...r,
        args: (() => {
          try {
            return r.args ? JSON.parse(r.args as string) : null
          } catch {
            return r.args
          }
        })(),
        result: (() => {
          try {
            return r.result ? JSON.parse(r.result as string) : null
          } catch {
            return r.result
          }
        })(),
      }))
      return c.json({ count: entries.length, entries })
    } catch (e) {
      return c.json({ error: String(e) }, 500)
    }
  })
}
