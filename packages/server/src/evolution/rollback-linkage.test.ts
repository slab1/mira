import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDatabase, migrate, type MiraDB } from '../storage/db.js'
import { Bus } from '../bus/index.js'
import { RollbackManager } from './rollback.js'
import { EVOLUTION_SNAPSHOT_SESSION } from '../patching/applier.js'

// Rollback linkage — the old `session_id LIKE '%evolution%'` heuristic could
// capture UNRELATED sessions' snapshots and revert files no patch touched.
// Rollback points now exact-match the evolution marker session and, when
// patchIds are provided, the applier-recorded message_id.

let dir: string
let db: MiraDB

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mira-rb-link-'))
  db = createDatabase(':memory:')
  await migrate(db)
  // marker session (the applier creates this via INSERT OR IGNORE)
  db.sqlite
    .prepare(
      'INSERT OR IGNORE INTO sessions (id, title, model, provider, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    )
    .run(EVOLUTION_SNAPSHOT_SESSION, 'evolution', 'm', 'p', Date.now(), Date.now())
  // an unrelated user session with its own snapshots — the old LIKE heuristic
  // would sweep these into every rollback point
  db.sqlite
    .prepare(
      'INSERT OR IGNORE INTO sessions (id, title, model, provider, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    )
    .run('user-session-1', 'u', 'm', 'p', Date.now(), Date.now())
})

afterEach(() => {
  try {
    db.sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  } catch {}
})

const seedSnapshot = (
  sessionID: string,
  path: string,
  content: string | null,
  messageID?: string,
) =>
  db.sqlite
    .prepare(
      'INSERT INTO file_snapshots (id, session_id, message_id, path, content, created_at) VALUES (?,?,?,?,?,?)',
    )
    .run(
      `sn_${Math.random().toString(36).slice(2)}`,
      sessionID,
      messageID ?? null,
      path,
      content,
      Date.now() + Math.random(),
    )

describe('rollback linkage (exact, no LIKE)', () => {
  test('patchIds link ONLY the applier-recorded evolution snapshots', () => {
    const target = join(dir, 'pkg.ts')
    writeFileSync(target, 'PATCHED', 'utf-8')
    // applier-recorded: evolution session, message_id = patch id
    seedSnapshot(EVOLUTION_SNAPSHOT_SESSION, target, 'PRE-IMAGE', 'patch_123')
    // unrelated: a user session snapshot (old heuristic swept this in)
    const userFile = join(dir, 'user-file.ts')
    writeFileSync(userFile, 'user content', 'utf-8')
    seedSnapshot('user-session-1', userFile, 'user content')

    const mgr = new RollbackManager({ db, bus: new Bus() })
    const point = mgr.createRollbackPoint('prop_1', ['patch_123'])
    expect(point.snapshotIds.length).toBe(1)

    // rollback restores exactly the patched file, nothing else
    mgr.rollback('prop_1')
    expect(readFileSync(target, 'utf-8')).toBe('PRE-IMAGE')
    expect(readFileSync(join(dir, 'user-file.ts'), 'utf-8')).toBe('user content')
    expect(existsUserSnapshot()).toBe(true)
  })

  test('without patchIds: falls back to the marker session only (still exact)', () => {
    const target = join(dir, 'pkg.ts')
    writeFileSync(target, 'PATCHED', 'utf-8')
    const userFile = join(dir, 'user-file.ts')
    writeFileSync(userFile, 'user content', 'utf-8')
    seedSnapshot(EVOLUTION_SNAPSHOT_SESSION, target, 'PRE-IMAGE')
    seedSnapshot('user-session-1', userFile, 'user content')

    const mgr = new RollbackManager({ db, bus: new Bus() })
    const point = mgr.createRollbackPoint('prop_2')
    expect(point.snapshotIds.length).toBe(1)
    mgr.rollback('prop_2')
    expect(readFileSync(target, 'utf-8')).toBe('PRE-IMAGE')
    expect(readFileSync(join(dir, 'user-file.ts'), 'utf-8')).toBe('user content')
  })

  test('created-by-patch files are removed on rollback (content null)', () => {
    const created = join(dir, 'new-file.ts')
    writeFileSync(created, 'generated', 'utf-8')
    seedSnapshot(EVOLUTION_SNAPSHOT_SESSION, created, null, 'patch_new')

    const mgr = new RollbackManager({ db, bus: new Bus() })
    mgr.createRollbackPoint('prop_3', ['patch_new'])
    mgr.rollback('prop_3')
    expect(existsSyncSafe(created)).toBe(false)
  })

  test('patchId with no matching snapshots → empty point, rollback still marks ledger', () => {
    const mgr = new RollbackManager({ db, bus: new Bus() })
    const point = mgr.createRollbackPoint('prop_4', ['patch_never_applied'])
    expect(point.snapshotIds).toEqual([])
    // must not throw
    expect(() => mgr.rollback('prop_4')).not.toThrow()
  })
})

function existsUserSnapshot(): boolean {
  const row = db.sqlite
    .prepare('SELECT COUNT(*) AS c FROM file_snapshots WHERE session_id = ?')
    .get('user-session-1') as { c: number }
  return row.c > 0
}

function existsSyncSafe(p: string): boolean {
  try {
    return readFileSync(p, 'utf-8') !== undefined
  } catch {
    return false
  }
}

// ── Applier ↔ snapshot integration ────────────────────────────────────
describe('applier records pre-images under the marker session', () => {
  test('apply snapshots the pre-image with message_id = patch.id', async () => {
    const { Applier } = await import('../patching/applier.js')
    const target = join(dir, 'mod.ts')
    writeFileSync(target, 'ORIGINAL', 'utf-8')
    const applier = new Applier({ db, bus: new Bus() }, { rootDir: dir })
    const res = await applier.apply(
      {
        id: 'patch_link1',
        painPointId: 'pp1',
        kind: 'fix',
        targetFile: 'mod.ts',
        reason: 'test',
        change: 'REPLACED',
        severity: 'minor',
        score: 1,
      } as never,
      { verified: true, reason: 'test' } as never,
    )
    expect(res.applied).toBe(true)
    // applyChange appends a review note — the pre-image content must survive
    expect(readFileSync(target, 'utf-8')).toContain('ORIGINAL')

    // the snapshot exists under the marker session with the patch id
    const row = db.sqlite
      .prepare('SELECT content FROM file_snapshots WHERE session_id = ? AND message_id = ?')
      .get(EVOLUTION_SNAPSHOT_SESSION, 'patch_link1') as { content: string }
    expect(row.content).toBe('ORIGINAL')

    // and the rollback point restores it
    const mgr = new RollbackManager({ db, bus: new Bus() })
    mgr.createRollbackPoint('prop_link', ['patch_link1'])
    mgr.rollback('prop_link')
    // exact pre-image restored — the appended note is gone
    expect(readFileSync(target, 'utf-8')).toBe('ORIGINAL')
  })
})
