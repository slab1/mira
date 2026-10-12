import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { createDatabase, migrate, type MiraDB } from '../storage/db.js'
import { mountWorkspacesRoutes } from './workspaces.js'

// Workspace endpoints. Two of these were placeholders or contract mismatches:
//   GET /changes  — returned 4 fields while the web UI renders 12, so agent /
//                   before / verification / snapshot / rollback rendered as
//                   literally "undefined" in the Changes workspace.
//   GET /memory   — returned [] unconditionally, so the Intelligence page's
//                   Memory section never rendered at all.

let db: MiraDB
let server: { stop: (c?: boolean) => void; port: number | undefined }
let BASE: string

beforeEach(async () => {
  db = createDatabase(':memory:')
  await migrate(db)
  const app = new Hono<{ Variables: { requestId: string } }>()
  mountWorkspacesRoutes(app, { db })
  server = Bun.serve({ port: 0, fetch: app.fetch })
  BASE = `http://127.0.0.1:${server.port}`
})

afterEach(() => {
  try {
    server.stop(true)
  } catch {}
})

const seedSession = (id: string, agent: string | null) =>
  db.sqlite
    .prepare(
      `INSERT OR IGNORE INTO sessions (id, title, model, provider, created_at, updated_at, agent)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(id, id, 'm', 'p', Date.now(), Date.now(), agent)

/** verification_state lives on jobs (VERIFICATION_STATES_DESIGN §2.2). */
const seedJobVerification = (sessionID: string, state: string) =>
  db.sqlite
    .prepare(
      `INSERT INTO jobs (id, parent_session_id, prompt, status, result, created_at, updated_at, verification_state)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(
      `job_${sessionID}_${state}`,
      sessionID,
      'do the work',
      'completed',
      'ok',
      Date.now(),
      Date.now(),
      state,
    )

const seedSnapshot = (id: string, sessionID: string, path: string, content: string | null) =>
  db.sqlite
    .prepare(
      'INSERT INTO file_snapshots (id, session_id, message_id, path, content, created_at) VALUES (?,?,?,?,?,?)',
    )
    .run(id, sessionID, 'msg1', path, content, Date.now())

describe('GET /changes — full contract', () => {
  test('returns every field the Changes UI renders', async () => {
    seedSession('s1', 'reviewer')
    seedJobVerification('s1', 'VERIFIED')
    seedSnapshot('snap1', 's1', '/repo/a.ts', 'before content\n')

    const res = await fetch(`${BASE}/changes`)
    expect(res.status).toBe(200)
    const items = (await res.json()) as Array<Record<string, unknown>>
    expect(items.length).toBe(1)
    const c = items[0]

    // fields the UI declares on ChangeEntry
    for (const key of [
      'id',
      'type',
      'path',
      'diff',
      'agent',
      'before',
      'after',
      'tests',
      'verification',
      'snapshot',
      'rollback',
      'approval',
      'createdAt',
    ]) {
      expect(Object.hasOwn(c, key)).toBe(true)
    }
    // no field may be literally undefined (that is what rendered as "undefined")
    for (const v of Object.values(c)) expect(v).not.toBeUndefined()
  })

  test('joins real agent + verification state from the session', async () => {
    seedSession('s1', 'reviewer')
    seedJobVerification('s1', 'VERIFIED')
    seedSnapshot('snap1', 's1', '/repo/a.ts', 'x\n')
    const items = (await (await fetch(`${BASE}/changes`)).json()) as Array<Record<string, unknown>>
    expect(items[0].agent).toBe('reviewer')
    expect(items[0].verification).toBe('VERIFIED')
  })

  test('"before" is the snapshot content; a created file has empty before', async () => {
    seedSession('s1', null)
    seedSnapshot('snap1', 's1', '/repo/a.ts', 'original body\n')
    seedSnapshot('snap2', 's1', '/repo/new.ts', null) // null = file did not exist
    const items = (await (await fetch(`${BASE}/changes`)).json()) as Array<Record<string, unknown>>
    const updated = items.find((i) => i.id === 'snap1')
    const created = items.find((i) => i.id === 'snap2')
    expect(updated?.before).toBe('original body\n')
    expect(created?.before).toBe('')
    expect(created?.type).toBe('create')
    expect(updated?.type).toBe('update')
  })

  test('unrecorded facts are null, never fabricated', async () => {
    seedSession('s1', null)
    seedSnapshot('snap1', 's1', '/repo/a.ts', 'x\n')
    const items = (await (await fetch(`${BASE}/changes`)).json()) as Array<Record<string, unknown>>
    // no session agent / verification recorded
    expect(items[0].agent).toBeNull()
    expect(items[0].verification).toBeNull()
    // these are genuinely not tracked per snapshot
    expect(items[0].tools).toBeNull()
    expect(items[0].tests).toBeNull()
    expect(items[0].approval).toBeNull()
    // a snapshot always exists → rollback is available
    expect(items[0].rollback).toBe('available')
  })
})

describe('GET /memory — real knowledge entries', () => {
  const seedMemory = (
    id: string,
    tier: string,
    title: string,
    content: string,
    tags: string | null,
    metadata: string | null,
  ) =>
    db.sqlite
      .prepare(
        `INSERT INTO knowledge_entries (id, tier, source, title, content, tags, metadata, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, tier, 'user', title, content, tags, metadata, Date.now(), Date.now())

  test('returns stored memories instead of an empty array', async () => {
    seedMemory(
      'k1',
      'procedural',
      'Commit style',
      'Conventional commits.',
      JSON.stringify(['git', 'convention']),
      JSON.stringify({ provenance: 'human-verified', confidence: 0.9 }),
    )
    const res = await fetch(`${BASE}/memory`)
    expect(res.status).toBe(200)
    const items = (await res.json()) as Array<Record<string, unknown>>
    expect(items.length).toBe(1)
    expect(items[0].title).toBe('Commit style')
    expect(items[0].tier).toBe('procedural')
    expect(items[0].content).toBe('Conventional commits.')
    expect(items[0].tags).toEqual(['git', 'convention'])
    expect(items[0].provenance).toBe('human-verified')
    expect(items[0].confidence).toBe(0.9)
  })

  test('empty database → empty array (not an error)', async () => {
    const res = await fetch(`${BASE}/memory`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  test('defaults provenance/confidence when metadata is absent', async () => {
    seedMemory('k2', 'semantic', 'T', 'C', null, null)
    const items = (await (await fetch(`${BASE}/memory`)).json()) as Array<Record<string, unknown>>
    expect(items[0].provenance).toBe('unverified')
    expect(items[0].confidence).toBe(0.5)
    expect(items[0].tags).toEqual([])
  })

  test('tier filter is applied', async () => {
    seedMemory('k3', 'episodic', 'E', 'C', null, null)
    seedMemory('k4', 'semantic', 'S', 'C', null, null)
    const items = (await (await fetch(`${BASE}/memory?tier=episodic`)).json()) as Array<
      Record<string, unknown>
    >
    expect(items.length).toBe(1)
    expect(items[0].tier).toBe('episodic')
  })
})
