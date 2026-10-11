import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDatabase, migrate } from '../storage/db.js'
import { analyzeTaskRelevance, moduleOf, recentUserPrompts } from './edit-target.js'

// Task-intent relevance: does this edit belong to what was actually asked?

let dir: string
let db: ReturnType<typeof createDatabase>

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mira-relevance-'))
  db = createDatabase(':memory:')
  await migrate(db)
})

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
})

const abs = (rel: string) => join(dir, rel)

describe('moduleOf', () => {
  test('groups packages under a workspace root', () => {
    expect(moduleOf(abs('packages/server/src/a.ts'), dir)).toBe('packages/server')
    expect(moduleOf(abs('packages/web/src/b.ts'), dir)).toBe('packages/web')
    expect(moduleOf(abs('docs/x.md'), dir)).toBe('docs')
    expect(moduleOf(abs('a.ts'), dir)).toBe('')
  })
})

describe('analyzeTaskRelevance — module boundary', () => {
  test('flags an edit that crosses into another package', () => {
    const res = analyzeTaskRelevance({
      target: abs('packages/web/src/thing.ts'),
      cwd: dir,
      sessionID: 's1',
      sessionTouches: new Set([abs('packages/server/src/thing.ts')]),
      recentPrompts: [],
    })
    expect(res.warnings.length).toBe(1)
    expect(res.warnings[0]).toContain('module boundary')
    expect(res.warnings[0]).toContain('packages/web')
  })

  test('silent when the edit stays inside the same module', () => {
    const res = analyzeTaskRelevance({
      target: abs('packages/server/src/other.ts'),
      cwd: dir,
      sessionID: 's1',
      sessionTouches: new Set([abs('packages/server/src/thing.ts')]),
      recentPrompts: [],
    })
    expect(res.warnings).toEqual([])
  })

  test('silent on the first edit of a session (nothing to compare)', () => {
    const res = analyzeTaskRelevance({
      target: abs('packages/web/src/thing.ts'),
      cwd: dir,
      sessionID: 's1',
      sessionTouches: new Set(),
      recentPrompts: [],
    })
    expect(res.warnings).toEqual([])
  })
})

describe('analyzeTaskRelevance — task text', () => {
  test('flags a file the task never mentioned when another file is named', () => {
    const res = analyzeTaskRelevance({
      target: abs('packages/server/src/logout.ts'),
      cwd: dir,
      sessionID: 's1',
      sessionTouches: new Set([abs('packages/server/src/login.ts')]),
      recentPrompts: ['fix the bug in login.ts where the session expires'],
    })
    expect(res.warnings.length).toBe(1)
    expect(res.warnings[0]).toContain('login.ts')
    expect(res.warnings[0]).toContain('logout.ts')
  })

  test('silent when the task does mention the target file', () => {
    const res = analyzeTaskRelevance({
      target: abs('packages/server/src/login.ts'),
      cwd: dir,
      sessionID: 's1',
      sessionTouches: new Set([abs('packages/server/src/session.ts')]),
      recentPrompts: ['fix the bug in login.ts where the session expires'],
    })
    expect(res.warnings).toEqual([])
  })

  test('generic file names never count as a task mention', () => {
    // index/util/thing appear in ordinary prose — they must not trigger
    const res = analyzeTaskRelevance({
      target: abs('packages/server/src/index.ts'),
      cwd: dir,
      sessionID: 's1',
      sessionTouches: new Set([abs('packages/server/src/util.ts')]),
      recentPrompts: ['improve the shared index and the util helpers'],
    })
    expect(res.warnings).toEqual([])
  })

  test('matches camelCase file names by their words', () => {
    const res = analyzeTaskRelevance({
      target: abs('src/AuthService.ts'),
      cwd: dir,
      sessionID: 's1',
      sessionTouches: new Set([abs('src/login.ts')]),
      recentPrompts: ['the AuthService needs a retry'],
    })
    expect(res.warnings).toEqual([])
  })

  test('both signals can fire together', () => {
    const res = analyzeTaskRelevance({
      target: abs('packages/web/src/logout.ts'),
      cwd: dir,
      sessionID: 's1',
      sessionTouches: new Set([abs('packages/server/src/login.ts')]),
      recentPrompts: ['fix login.ts'],
    })
    expect(res.warnings.length).toBe(2)
  })
})

describe('recentUserPrompts', () => {
  const seed = (id: string, role: string, text: string | null, at: number) => {
    db.sqlite
      .prepare(
        'INSERT OR IGNORE INTO sessions (id, title, model, provider, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      )
      .run('sess', 't', 'm', 'pr', at, at)
    db.sqlite
      .prepare('INSERT INTO messages (id, session_id, role, created_at) VALUES (?,?,?,?)')
      .run(`${id}-m`, 'sess', role, at)
    if (text !== null)
      db.sqlite
        .prepare(
          'INSERT INTO parts (id, message_id, session_id, type, text, created_at) VALUES (?,?,?,?,?,?)',
        )
        .run(`${id}-p`, `${id}-m`, 'sess', 'text', text, at)
  }

  test('returns user prompts newest first', () => {
    seed('m1', 'user', 'first prompt', 1000)
    seed('m2', 'user', 'second prompt', 2000)
    seed('m3', 'assistant', 'assistant text', 3000)
    const out = recentUserPrompts(db, 'sess')
    expect(out[0]).toBe('second prompt')
    expect(out).not.toContain('assistant text')
  })

  test('never throws on a missing session', () => {
    expect(recentUserPrompts(db, 'does-not-exist')).toEqual([])
  })
})
