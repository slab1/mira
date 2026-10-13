import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { createDatabase, migrate } from '../storage/db.js'
import { mountAdminRoutes } from './admin.js'

// P3.5 compliance routes — violation report, retention trigger/inspect, and
// the admin gate. Uses REAL fetch against a live Bun.serve socket.

let server!: { stop: (closeActiveConnections?: boolean) => void; port: number | undefined }
let BASE!: string
let db!: ReturnType<typeof createDatabase>

const TOKEN = 'compliance-admin-token'
const resolveOwner = (t: string): string | undefined => (t === TOKEN ? 'default' : undefined)
const resolveRole = (t: string): 'viewer' | 'operator' | 'admin' =>
  resolveOwner(t) === 'default' ? 'admin' : 'operator'
const bearerOf = (h?: string): string => (h?.startsWith('Bearer ') ? h.slice(7) : '')
const AUTH = { Authorization: `Bearer ${TOKEN}` }

/** Session → org stub (org-1 owns s1; s2 belongs to another org). */
const orgOfSession = async (sessionID: string): Promise<string | null> =>
  sessionID === 's1' ? 'org-1' : sessionID === 's2' ? 'org-2' : null

beforeAll(async () => {
  db = createDatabase(':memory:')
  await migrate(db)
  const app = new Hono<{ Variables: { requestId: string } }>()
  mountAdminRoutes(app, {
    db,
    REQUIRED_TOKEN: TOKEN,
    API_KEY_OWNERS: new Map(),
    API_KEY_CREDENTIAL_ROLES: new Map(),
    API_KEY_EXPIRES_AT: new Map(),
    API_KEY_REVOKED_AT: new Map(),
    LEGACY_API_KEY_ROLES: new Map(),
    resolveOwner,
    resolveRole,
    bearerOf,
    sessionOwnerCache: new Map(),
    orgOfSession,
  })
  server = Bun.serve({ port: 0, fetch: app.fetch })
  BASE = `http://127.0.0.1:${server.port}`

  const ins = db.sqlite.prepare(
    'INSERT INTO audit_entries (id, session_id, tool, decision, reason, args, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const now = Date.now()
  const DAY = 24 * 60 * 60 * 1000
  // violation rows across sessions/orgs, plus benign + expired rows
  ins.run('c1', 's1', 'bash', 'deny', 'bash command accesses /etc/passwd', '{}', '{}', now)
  ins.run('c2', 's1', 'bash', 'deny', 'bash command accesses /etc/passwd', '{}', '{}', now)
  ins.run(
    'c3',
    's1',
    'edit',
    'deny',
    'patch target outside allowed roots (/etc/x)',
    '{}',
    '{}',
    now,
  )
  ins.run('c4', 's2', 'bash', 'warn', 'bash command in blocked list', '{}', '{}', now)
  ins.run('c5', null, 'bash', 'deny', 'bash blocked', '{}', '{}', now) // unscoped
  ins.run('c6', 's1', 'read', 'allow', null, '{}', '{}', now) // not a violation
  ins.run('c7', 's1', 'bash', 'deny', 'bash old', '{}', '{}', now - 200 * DAY) // expired
})

afterAll(() => {
  try {
    server.stop(true)
  } catch {}
})

const rowCount = () =>
  (db.sqlite.prepare('SELECT COUNT(*) AS c FROM audit_entries').get() as { c: number }).c

describe('GET /admin/compliance/violations', () => {
  test('requires admin', async () => {
    const res = await fetch(`${BASE}/admin/compliance/violations`)
    expect(res.status).toBe(401)
  })

  test('reports categories, tools and the rows/events split', async () => {
    const res = await fetch(`${BASE}/admin/compliance/violations?days=30`, { headers: AUTH })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      report: {
        totalRows: number
        totalEvents: number
        byCategory: Array<{ category: string; rows: number; events: number }>
        byTool: Array<{ tool: string; rows: number }>
      }
    }
    const r = body.report
    // 5 in-window violations (c1..c5); c6 is allow, c7 is outside 30d
    expect(r.totalRows).toBe(5)
    // c1/c2 are the same session+tool+reason → one event
    expect(r.totalEvents).toBe(4)
    expect(r.byCategory[0].category).toBe('command')
    expect(r.byCategory[0].rows).toBe(4)
    expect(r.byCategory[1].category).toBe('patch')
    expect(r.byTool.map((t) => t.tool)).toContain('bash')
  })

  test('scopes to an org and counts unscoped rows', async () => {
    const res = await fetch(`${BASE}/admin/compliance/violations?org=org-1&days=30`, {
      headers: AUTH,
    })
    const body = (await res.json()) as {
      report: { totalRows: number; unscopedRows: number }
    }
    // s1 rows: c1,c2,c3 (c6 is allow, c7 out of window) → 3
    expect(body.report.totalRows).toBe(3)
    // c4 (org-2, excluded by filter) + c5 (no session) are not counted as scoped
    expect(body.report.unscopedRows).toBe(1)
  })

  test('clamps an absurd window instead of erroring', async () => {
    const res = await fetch(`${BASE}/admin/compliance/violations?days=99999`, { headers: AUTH })
    expect(res.status).toBe(200)
  })
})

describe('POST /admin/compliance/retention', () => {
  test('requires admin', async () => {
    const res = await fetch(`${BASE}/admin/compliance/retention`, { method: 'POST' })
    expect(res.status).toBe(401)
  })

  test('deletes expired rows and reports the result', async () => {
    const before = rowCount()
    const res = await fetch(`${BASE}/admin/compliance/retention`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ retentionDays: 90 }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      result: { deletedByAge: number; remaining: number }
      effectiveRetentionDays: number
    }
    expect(body.effectiveRetentionDays).toBe(90)
    expect(body.result.deletedByAge).toBe(1) // c7
    expect(rowCount()).toBe(before - 1)
  })

  test('retentionDays 0 is honoured (no age deletion)', async () => {
    const before = rowCount()
    const res = await fetch(`${BASE}/admin/compliance/retention`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ retentionDays: 0 }),
    })
    const body = (await res.json()) as { result: { deletedByAge: number } }
    expect(body.result.deletedByAge).toBe(0)
    expect(rowCount()).toBe(before)
  })

  test('maxRows trims the oldest overflow', async () => {
    const res = await fetch(`${BASE}/admin/compliance/retention`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ retentionDays: 0, maxRows: 3 }),
    })
    const body = (await res.json()) as { result: { remaining: number } }
    expect(body.result.remaining).toBe(3)
  })

  test('ignores garbage numbers rather than wiping the trail', async () => {
    await db.sqlite
      .prepare(
        'INSERT INTO audit_entries (id, session_id, tool, decision, reason, args, result, created_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run('keep-me', 's1', 'read', 'allow', null, null, null, Date.now())
    const res = await fetch(`${BASE}/admin/compliance/retention`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ retentionDays: 'soon', maxRows: 'lots' }),
    })
    const body = (await res.json()) as { effectiveRetentionDays: number }
    // falls back to the default window, not 0/garbage
    expect(body.effectiveRetentionDays).toBeGreaterThan(0)
    expect(rowCount()).toBeGreaterThan(0)
  })
})

describe('GET /admin/compliance/retention', () => {
  test('reports the effective window and current size', async () => {
    const res = await fetch(`${BASE}/admin/compliance/retention`, { headers: AUTH })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { effectiveRetentionDays: number; totalRows: number }
    expect(body.effectiveRetentionDays).toBeGreaterThan(0)
    expect(body.totalRows).toBe(rowCount())
  })
})

describe('audit reads redact secrets (defense in depth)', () => {
  test('raw secrets stored before redaction are masked on read', async () => {
    db.sqlite
      .prepare(
        'INSERT INTO audit_entries (id, session_id, tool, decision, reason, args, result, created_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(
        'raw1',
        's1',
        'bash',
        'allow',
        null,
        JSON.stringify({ command: 'export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENG' }),
        JSON.stringify({ out: 'token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' }),
        Date.now(),
      )
    const res = await fetch(`${BASE}/admin/audit?limit=200`, { headers: AUTH })
    const text = await res.text()
    expect(text).not.toContain('wJalrXUtnFEMIK7MDENG')
    expect(text).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789')
    expect(text).toContain('REDACTED')
  })

  test('JSON export redacts too', async () => {
    const res = await fetch(`${BASE}/admin/audit/export?format=json&limit=100`, { headers: AUTH })
    const text = await res.text()
    expect(text).not.toContain('wJalrXUtnFEMIK7MDENG')
  })
})
