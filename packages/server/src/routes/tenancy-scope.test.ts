import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { createDatabase, migrate } from '../storage/db.js'
import { Bus } from '../bus/index.js'
import { mountFindingRoutes } from './finding.js'
import { mountWorkspacesRoutes } from './workspaces.js'

// P3.3 tenancy follow-up — findings and file snapshots were owner-unscoped, so
// every authenticated owner could read every other owner's rows once orgs exist.
// Real fetch against a live Bun.serve socket.

let server!: { stop: (closeActiveConnections?: boolean) => void; port: number | undefined }
let BASE!: string
let db!: ReturnType<typeof createDatabase>

// alice + bob share org-1; carol is orgless; dave is in org-2.
const OWNERS: Record<string, string> = {
  'tok-alice': 'alice',
  'tok-bob': 'bob',
  'tok-carol': 'carol',
  'tok-dave': 'dave',
}
const ORG_OF: Record<string, string> = { alice: 'org-1', bob: 'org-1', dave: 'org-2' }
const resolveOwner = (t: string): string | undefined => OWNERS[t]
const bearerOf = (h?: string): string => (h?.startsWith('Bearer ') ? h.slice(7) : '')
const orgOfOwner = (o: string | null | undefined) => (o ? ORG_OF[o] : undefined)

const SESSIONS: Record<string, { owner: string | null; org: string | null }> = {
  's-alice': { owner: 'alice', org: 'org-1' },
  's-bob': { owner: 'bob', org: 'org-1' },
  's-dave': { owner: 'dave', org: 'org-2' },
  's-legacy': { owner: null, org: null },
}
const ownerOfSession = async (id: string) => SESSIONS[id]?.owner ?? null
const orgOfSession = async (id: string) => SESSIONS[id]?.org ?? null

const auth = (tok: string) => ({ Authorization: `Bearer ${tok}` })

beforeEach(() => {
  db.sqlite.exec('DELETE FROM findings; DELETE FROM file_snapshots; DELETE FROM sessions;')
  const now = Date.now()
  const insSession = db.sqlite.prepare(
    'INSERT INTO sessions (id, title, model, provider, created_at, updated_at, owner_id, org_id) VALUES (?,?,?,?,?,?,?,?)',
  )
  for (const [id, s] of Object.entries(SESSIONS))
    insSession.run(id, id, 'm', 'p', now, now, s.owner, s.org)
  const insFinding = db.sqlite.prepare(
    'INSERT INTO findings (id, session_id, source, severity, title, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
  )
  insFinding.run('f-alice', 's-alice', 'agent', 'major', 'alice finding', 'open', now, now)
  insFinding.run('f-dave', 's-dave', 'agent', 'major', 'dave finding', 'open', now, now)
  insFinding.run('f-legacy', 's-legacy', 'agent', 'info', 'legacy finding', 'open', now, now)
  const insSnap = db.sqlite.prepare(
    'INSERT INTO file_snapshots (id, session_id, path, content, created_at) VALUES (?,?,?,?,?)',
  )
  insSnap.run('sn-alice', 's-alice', 'src/alice.ts', 'alice content', now)
  insSnap.run('sn-dave', 's-dave', 'src/dave.ts', 'dave content', now)
})

beforeAll(() => {
  db = createDatabase(':memory:')
  const app = new Hono<{ Variables: { requestId: string } }>()
  const tenancy = {
    ownerOfSession,
    orgOfSession,
    orgOfOwner,
    resolveOwner,
    bearerOf,
    OWNERSHIP_ENABLED: true as const,
  }
  mountFindingRoutes(app, { db, bus: new Bus(), ...tenancy })
  mountWorkspacesRoutes(app, { db, ...tenancy })
  // migrate is async — run it before serving
  void migrate(db)
  server = Bun.serve({ port: 0, fetch: app.fetch })
  BASE = `http://127.0.0.1:${server.port}`
})

afterAll(() => {
  try {
    server.stop(true)
  } catch {}
})

const list = async (tok: string) =>
  (await (await fetch(`${BASE}/finding`, { headers: auth(tok) })).json()) as Array<{ id: string }>
const titles = async (tok: string) => (await list(tok)).map((f) => f.id).sort()

describe('findings tenancy (P3.3)', () => {
  test('same-org member sees org findings plus legacy shared ones', async () => {
    expect(await titles('tok-bob')).toEqual(['f-alice', 'f-legacy'])
  })

  test('owner sees their own + legacy', async () => {
    expect(await titles('tok-alice')).toEqual(['f-alice', 'f-legacy'])
  })

  test('other-org owner sees only their own', async () => {
    expect(await titles('tok-dave')).toEqual(['f-dave', 'f-legacy'])
  })

  test('orgless owner sees only legacy (shared) findings', async () => {
    expect(await titles('tok-carol')).toEqual(['f-legacy'])
  })

  test('cannot attach a finding to another owner’s session (404)', async () => {
    const res = await fetch(`${BASE}/finding`, {
      method: 'POST',
      headers: { ...auth('tok-dave'), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'sneaky', severity: 'minor', sessionID: 's-alice' }),
    })
    expect(res.status).toBe(404)
  })

  test('can attach a finding to a same-org session', async () => {
    const res = await fetch(`${BASE}/finding`, {
      method: 'POST',
      headers: { ...auth('tok-bob'), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'shared concern', severity: 'minor', sessionID: 's-alice' }),
    })
    expect(res.status).toBe(201)
  })

  test('cannot resolve another owner’s finding (404)', async () => {
    const res = await fetch(`${BASE}/finding/f-alice/resolve`, {
      method: 'POST',
      headers: auth('tok-dave'),
    })
    expect(res.status).toBe(404)
  })

  test('same-org member can resolve it', async () => {
    const res = await fetch(`${BASE}/finding/f-alice/resolve`, {
      method: 'POST',
      headers: auth('tok-bob'),
    })
    expect(res.status).toBe(200)
  })
})

describe('file snapshot tenancy (P3.3)', () => {
  test('/files only lists the caller’s own paths', async () => {
    const rows = (await (
      await fetch(`${BASE}/files`, { headers: auth('tok-dave') })
    ).json()) as Array<{
      path: string
    }>
    expect(rows.map((r) => r.path)).toEqual(['src/dave.ts'])
  })

  test('orgless owner sees no snapshots', async () => {
    const rows = (await (
      await fetch(`${BASE}/files`, { headers: auth('tok-carol') })
    ).json()) as Array<{
      path: string
    }>
    expect(rows).toEqual([])
  })

  test('/changes only lists the caller’s own snapshots', async () => {
    const rows = (await (
      await fetch(`${BASE}/changes`, { headers: auth('tok-alice') })
    ).json()) as Array<{
      path: string
    }>
    expect(rows.map((r) => r.path)).toEqual(['src/alice.ts'])
  })

  test('legacy (ownerless) sessions remain visible', async () => {
    db.sqlite
      .prepare(
        'INSERT INTO file_snapshots (id, session_id, path, content, created_at) VALUES (?,?,?,?,?)',
      )
      .run('sn-legacy', 's-legacy', 'src/shared.ts', 'shared', Date.now())
    const rows = (await (
      await fetch(`${BASE}/files`, { headers: auth('tok-carol') })
    ).json()) as Array<{
      path: string
    }>
    expect(rows.map((r) => r.path)).toContain('src/shared.ts')
  })
})
