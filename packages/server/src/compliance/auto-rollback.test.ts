import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDatabase, migrate } from '../storage/db.js'
import { autoRollbackEnabled, rollbackSessionMutations } from './index.js'
import { resetConfigCache, saveConfig } from '../config/index.js'

// P3.6 groundwork — auto-rollback on FAILED_VERIFICATION, opt-in, with the
// toggle supporting BOTH modes (config field and env override).

let dir: string
let projectDir: string
let db: ReturnType<typeof createDatabase>

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mira-rollback-'))
  projectDir = mkdtempSync(join(tmpdir(), 'mira-cfg-'))
  db = createDatabase(':memory:')
  await migrate(db)
  resetConfigCache()
  delete process.env.MIRA_AUTO_ROLLBACK
})

afterEach(() => {
  delete process.env.MIRA_AUTO_ROLLBACK
  resetConfigCache()
  try {
    rmSync(dir, { recursive: true, force: true })
    rmSync(projectDir, { recursive: true, force: true })
  } catch {}
})

const seedSession = (id: string) =>
  db.sqlite
    .prepare(
      'INSERT OR IGNORE INTO sessions (id, title, model, provider, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    )
    .run(id, id, 'm', 'p', Date.now(), Date.now())

const snapshot = (sessionID: string, path: string, content: string | null, age = 0) =>
  db.sqlite
    .prepare(
      'INSERT INTO file_snapshots (id, session_id, message_id, path, content, created_at) VALUES (?,?,?,?,?,?)',
    )
    .run(
      `sn_${Math.random().toString(36).slice(2)}`,
      sessionID,
      null,
      path,
      content,
      Date.now() - age,
    )

describe('autoRollbackEnabled — both modes', () => {
  test('defaults to OFF (safe: never silently un-write files)', () => {
    expect(autoRollbackEnabled()).toBe(false)
  })

  test('enabled by config field', async () => {
    await saveConfig({ compliance: { autoRollback: true } }, 'project', projectDir)
    expect(autoRollbackEnabled()).toBe(true)
  })

  test('disabled by explicit config even when env says on (config wins)', async () => {
    await saveConfig({ compliance: { autoRollback: false } }, 'project', projectDir)
    process.env.MIRA_AUTO_ROLLBACK = '1'
    expect(autoRollbackEnabled()).toBe(false)
  })

  test('env enables when no config value is set', () => {
    process.env.MIRA_AUTO_ROLLBACK = '1'
    expect(autoRollbackEnabled()).toBe(true)
  })

  test('env accepts the usual truthy spellings', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'TRUE']) {
      process.env.MIRA_AUTO_ROLLBACK = v
      expect(autoRollbackEnabled()).toBe(true)
    }
  })

  test('env disables explicitly', () => {
    process.env.MIRA_AUTO_ROLLBACK = 'off'
    expect(autoRollbackEnabled()).toBe(false)
  })

  test('config enable beats a disabling env (both modes reachable)', async () => {
    await saveConfig({ compliance: { autoRollback: true } }, 'project', projectDir)
    process.env.MIRA_AUTO_ROLLBACK = '0'
    expect(autoRollbackEnabled()).toBe(true)
  })
})

describe('rollbackSessionMutations', () => {
  test('restores modified files to their pre-run content', async () => {
    seedSession('s1')
    const p = join(dir, 'a.ts')
    writeFileSync(p, 'BROKEN', 'utf-8')
    snapshot('s1', p, 'original content')

    const res = await rollbackSessionMutations(db, 's1')
    expect(res.files).toContain(p)
    expect(readFileSync(p, 'utf-8')).toBe('original content')
  })

  test('deletes files the run created', async () => {
    seedSession('s1')
    const p = join(dir, 'created.ts')
    writeFileSync(p, 'new', 'utf-8')
    snapshot('s1', p, null) // content null = did not exist before

    const res = await rollbackSessionMutations(db, 's1')
    expect(res.deleted).toContain(p)
    expect(existsSync(p)).toBe(false)
  })

  test('recovers several files in one pass', async () => {
    seedSession('s1')
    const a = join(dir, 'a.ts')
    const b = join(dir, 'b.ts')
    writeFileSync(a, 'A-broken', 'utf-8')
    writeFileSync(b, 'B-broken', 'utf-8')
    snapshot('s1', a, 'A-original', 10)
    snapshot('s1', b, 'B-original', 5)

    await rollbackSessionMutations(db, 's1')
    expect(readFileSync(a, 'utf-8')).toBe('A-original')
    expect(readFileSync(b, 'utf-8')).toBe('B-original')
  })

  test('restores the EARLIEST snapshot per file when a file was edited twice', async () => {
    seedSession('s1')
    const p = join(dir, 'twice.ts')
    writeFileSync(p, 'v3', 'utf-8')
    snapshot('s1', p, 'v1', 20) // oldest = pre-run state
    snapshot('s1', p, 'v2', 10)

    await rollbackSessionMutations(db, 's1')
    // Newest-first restore then second pass ends at the oldest content
    expect(readFileSync(p, 'utf-8')).toBe('v1')
  })

  test('consumes the snapshots it applied', async () => {
    seedSession('s1')
    const p = join(dir, 'c.ts')
    writeFileSync(p, 'x', 'utf-8')
    snapshot('s1', p, 'original')
    await rollbackSessionMutations(db, 's1')
    const left = db.sqlite
      .prepare('SELECT COUNT(*) AS c FROM file_snapshots WHERE session_id = ?')
      .get('s1') as { c: number }
    expect(left.c).toBe(0)
  })

  test('does not touch another session’s files', async () => {
    seedSession('s1')
    seedSession('s2')
    const p1 = join(dir, 'one.ts')
    const p2 = join(dir, 'two.ts')
    writeFileSync(p1, 'one-broken', 'utf-8')
    writeFileSync(p2, 'two-untouched', 'utf-8')
    snapshot('s1', p1, 'one-original')
    snapshot('s2', p2, 'two-original')

    await rollbackSessionMutations(db, 's1')
    expect(readFileSync(p1, 'utf-8')).toBe('one-original')
    // s2's file AND its snapshot are untouched
    expect(readFileSync(p2, 'utf-8')).toBe('two-untouched')
    const s2 = db.sqlite
      .prepare('SELECT COUNT(*) AS c FROM file_snapshots WHERE session_id = ?')
      .get('s2') as { c: number }
    expect(s2.c).toBe(1)
  })

  test('never throws on a missing session or empty snapshot set', async () => {
    expect((await rollbackSessionMutations(db, 'nope')).files).toEqual([])
    seedSession('empty')
    expect((await rollbackSessionMutations(db, 'empty')).deleted).toEqual([])
  })

  test('recreates parent directories when the whole subtree is gone', async () => {
    seedSession('s1')
    const nested = join(dir, 'deep', 'nested', 'f.ts')
    mkdirSync(dirname(nested), { recursive: true })
    writeFileSync(nested, 'broken', 'utf-8')
    snapshot('s1', nested, 'restored')
    // Someone removed the directory tree after the run
    rmSync(join(dir, 'deep'), { recursive: true, force: true })
    expect(existsSync(nested)).toBe(false)

    const res = await rollbackSessionMutations(db, 's1')
    expect(res.files).toContain(nested)
    expect(readFileSync(nested, 'utf-8')).toBe('restored')
  })
})
