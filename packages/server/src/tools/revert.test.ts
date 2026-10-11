import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDatabase, migrate } from '../storage/db.js'
import { ToolRegistry } from './registry.js'
import { PermissionManager } from '../permission/index.js'
import { Bus } from '../bus/index.js'
import type { Gateway } from '../gateway/index.js'

const stubGateway = {
  stream: () => Promise.resolve((async function* () {})()),
  complete: async () => ({ text: '' }),
  summarize: async () => '',
  listModels: async () => [],
  stats: () => ({
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUSD: 0,
    avgLatencyMs: 0,
    byModel: {},
  }),
} as unknown as Gateway

// Wrong-edit protection: the patch read-guard gap and the agent-callable
// revert tool (file-scoped undo for self-correction).

let dir: string
let db: ReturnType<typeof createDatabase>

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mira-revert-'))
  db = createDatabase(':memory:')
  await migrate(db)
  regPromise = null // each test gets a registry bound to its own db
})

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
})

let regPromise: Promise<ToolRegistry> | null = null
/** Registry with all built-in tools registered (read/write/edit/patch/revert…). */
const registry = async () => {
  if (!regPromise) {
    regPromise = (async () => {
      const r = new ToolRegistry({
        db,
        bus: new Bus(),
        permissions: new PermissionManager({}),
        gateway: stubGateway,
      })
      await r.registerAll()
      return r
    })()
  }
  return regPromise
}

/** file_snapshots FKs onto sessions/messages — the row must exist. */
const seedSession = (id: string) =>
  db.sqlite
    .prepare(
      'INSERT OR IGNORE INTO sessions (id, title, model, provider, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    )
    .run(id, id, 'm', 'p', Date.now(), Date.now())

const ctx = (sessionID: string) => ({
  sessionID,
  messageID: 'msg-1',
  cwd: dir,
  db,
})

describe('read-before-edit guard covers patch too', () => {
  test('patch on an unread file is refused', async () => {
    const p = join(dir, 'guarded.ts')
    writeFileSync(p, 'original\n', 'utf-8')
    const reg = await registry()
    const err = await reg
      .execute(
        'patch',
        {
          cwd: dir,
          patch: `--- a/guarded.ts\n+++ b/guarded.ts\n@@\n-original\n+patched\n`,
        },
        ctx('sess-guard'),
      )
      .then(() => null)
      .catch((e: Error) => e)
    expect(err).toBeTruthy()
    expect(err!.message).toContain('Read-before-edit guard')
    // file untouched
    expect(readFileSync(p, 'utf-8')).toBe('original\n')
  })

  test('patch succeeds after the target was read', async () => {
    const p = join(dir, 'read-then-patch.ts')
    writeFileSync(p, 'original\n', 'utf-8')
    const reg = await registry()
    await reg.execute('read', { path: 'read-then-patch.ts' }, ctx('sess-guard2'))
    const res = await reg.execute(
      'patch',
      {
        cwd: dir,
        patch: `--- a/read-then-patch.ts\n+++ b/read-then-patch.ts\n@@\n-original\n+patched\n`,
      },
      ctx('sess-guard2'),
    )
    expect(res).toBeTruthy()
  })

  test('patch may still create a brand-new file', async () => {
    mkdirSync(join(dir, 'nested'), { recursive: true })
    const reg = await registry()
    const res = await reg.execute(
      'patch',
      {
        cwd: dir,
        patch: `--- a/nested/brand-new.ts\n+++ b/nested/brand-new.ts\n@@\n+hello\n`,
      },
      ctx('sess-guard3'),
    )
    expect(res).toBeTruthy()
  })
})

describe('revert tool (agent self-correction)', () => {
  test('restores the pre-edit content of a file the agent changed', async () => {
    seedSession('sess-revert')
    const p = join(dir, 'wrong-file.ts')
    writeFileSync(p, 'correct content\n', 'utf-8')
    const reg = await registry()
    const sessionID = 'sess-revert'

    await reg.execute('read', { path: 'wrong-file.ts' }, ctx(sessionID))
    await reg.execute(
      'edit',
      {
        path: 'wrong-file.ts',
        oldString: 'correct content',
        newString: 'WRONG content',
      },
      ctx(sessionID),
    )
    expect(readFileSync(p, 'utf-8')).toBe('WRONG content\n')

    const { revertTool } = await import('./revert.js')
    const res = await revertTool.execute({ path: 'wrong-file.ts' }, ctx(sessionID))
    expect(res.ok).toBe(true)
    expect(readFileSync(p, 'utf-8')).toBe('correct content\n')
  })

  test('deletes a file the agent created', async () => {
    seedSession('sess-create')
    const p = join(dir, 'created.ts')
    const reg = await registry()
    const sessionID = 'sess-create'
    await reg.execute('write', { path: 'created.ts', content: 'new file\n' }, ctx(sessionID))
    expect(readFileSync(p, 'utf-8')).toBe('new file\n')

    const { revertTool } = await import('./revert.js')
    const res = await revertTool.execute({ path: 'created.ts' }, ctx(sessionID))
    expect(res.ok).toBe(true)
    // file gone
    expect(() => readFileSync(p, 'utf-8')).toThrow()
  })

  test('does NOT delete conversation messages (unlike revertLast)', async () => {
    const p = join(dir, 'ctx-keep.ts')
    writeFileSync(p, 'before\n', 'utf-8')
    const reg = await registry()
    const sessionID = 'sess-ctx'
    seedSession(sessionID)
    db.sqlite
      .prepare('INSERT INTO messages (id, session_id, role, created_at) VALUES (?,?,?,?)')
      .run('m1', sessionID, 'user', Date.now())

    await reg.execute('read', { path: 'ctx-keep.ts' }, ctx(sessionID))
    await reg.execute(
      'edit',
      { path: 'ctx-keep.ts', oldString: 'before', newString: 'after' },
      ctx(sessionID),
    )

    const { revertTool } = await import('./revert.js')
    await revertTool.execute({ path: 'ctx-keep.ts' }, ctx(sessionID))

    const msg = db.sqlite
      .prepare('SELECT COUNT(*) AS c FROM messages WHERE session_id = ?')
      .get(sessionID) as { c: number }
    expect(msg.c).toBe(1) // message preserved — agent keeps its context
  })

  test('refuses to revert a snapshot from another session', async () => {
    seedSession('sess-A')
    seedSession('sess-B')
    const p = join(dir, 'other-session.ts')
    writeFileSync(p, 'x\n', 'utf-8')
    const reg = await registry()
    await reg.execute('read', { path: 'other-session.ts' }, ctx('sess-A'))
    await reg.execute(
      'edit',
      { path: 'other-session.ts', oldString: 'x', newString: 'y' },
      ctx('sess-A'),
    )

    const { revertListTool, revertTool } = await import('./revert.js')
    const listed = (await revertListTool.execute({}, ctx('sess-A'))) as {
      snapshots: Array<{ snapshotID: string }>
    }
    expect(listed.snapshots.length).toBeGreaterThan(0)

    const res = await revertTool.execute(
      { snapshotID: listed.snapshots[0].snapshotID },
      ctx('sess-B'),
    )
    expect(res.ok).toBe(false)
  })

  test('revert_list reports what is undoable', async () => {
    seedSession('sess-list')
    const p = join(dir, 'listing.ts')
    writeFileSync(p, 'v1\n', 'utf-8')
    const reg = await registry()
    await reg.execute('read', { path: 'listing.ts' }, ctx('sess-list'))
    await reg.execute(
      'edit',
      { path: 'listing.ts', oldString: 'v1', newString: 'v2' },
      ctx('sess-list'),
    )

    const { revertListTool } = await import('./revert.js')
    const out = (await revertListTool.execute({}, ctx('sess-list'))) as {
      snapshots: Array<{ path: string; action: string; snapshotID: string }>
    }
    expect(out.snapshots.length).toBeGreaterThan(0)
    expect(out.snapshots[0].path.endsWith('listing.ts')).toBe(true)
    expect(out.snapshots[0].action).toContain('restore')
  })

  test('errors clearly when there is nothing to revert', async () => {
    const { revertTool } = await import('./revert.js')
    const res = await revertTool.execute({ path: 'never-touched.ts' }, ctx('sess-empty'))
    expect(res.ok).toBe(false)
    expect(res.error).toContain('no matching snapshot')
  })

  test('revert is registered in the tool registry', async () => {
    seedSession('sess-reg')
    const reg = await registry()
    expect(reg.get('revert')).toBeDefined()
    expect(reg.get('revert_list')).toBeDefined()
  })
})
