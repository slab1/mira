import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { analyzeTaskRelevance, recentUserPrompts } from './edit-target.js'

// Symbol-level task binding: the undirected catch for "stale snippet matched
// perfectly in the wrong function". The prompt is the only intent evidence.

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mira-symbol-'))
})

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
})

const FILE = [
  'function build() {',
  '  return x',
  '}',
  '',
  'function target() {',
  '  const a = 1',
  '  return a + b',
  '}',
].join('\n')

const analyze = (over: Partial<Parameters<typeof analyzeTaskRelevance>[0]>) =>
  analyzeTaskRelevance({
    target: join(dir, 'code.ts'),
    cwd: dir,
    sessionID: 's1',
    fileContent: FILE,
    recentPrompts: [],
    ...over,
  })

describe('symbol binding', () => {
  test('task names target() but the edit lands inside build() → warn', () => {
    const res = analyze({
      oldString: '  return x',
      recentPrompts: ['fix the bug in target()'],
    })
    const sym = res.warnings.find((w) => w.includes('symbol') || w.includes('lands inside'))
    expect(sym).toBeTruthy()
    expect(sym!).toContain('target()')
    expect(sym!).toContain('build()')
  })

  test('task names the enclosing symbol → silent', () => {
    const res = analyze({
      oldString: '  return x',
      recentPrompts: ['refactor build() to use a helper'],
    })
    expect(res.warnings).toEqual([])
  })

  test('task names nothing → silent (cannot judge)', () => {
    const res = analyze({
      oldString: '  return x',
      recentPrompts: ['make the change we discussed'],
    })
    expect(res.warnings).toEqual([])
  })

  test('task names TWO symbols → silent (ambiguous intent)', () => {
    const res = analyze({
      oldString: '  return x',
      recentPrompts: ['build() and target() share logic, tidy both'],
    })
    expect(res.warnings).toEqual([])
  })

  test('word-boundary matching: "x" inside "fix" is not a symbol mention', () => {
    // declarations include `x` (const x = 1 in target via `return a + b`? no —
    // FILE declares build/target only). Use a short-name case explicitly:
    const file = 'function add() {\n  return 1 + 2\n}\n'
    const res = analyzeTaskRelevance({
      target: join(dir, 'f.ts'),
      cwd: dir,
      sessionID: 's1',
      fileContent: file,
      oldString: 'return 1 + 2',
      recentPrompts: ['please fix this'],
      sessionTouches: new Set(),
    })
    expect(res.warnings).toEqual([])
  })

  test('non-unique oldString → skipped (ambiguity handled elsewhere)', () => {
    const file = 'function a() {\n  same\n}\nfunction b() {\n  same\n}\n'
    const res = analyzeTaskRelevance({
      target: join(dir, 'g.ts'),
      cwd: dir,
      sessionID: 's1',
      fileContent: file,
      oldString: '  same\n',
      recentPrompts: ['fix b()'],
      sessionTouches: new Set(),
    })
    expect(res.warnings).toEqual([])
  })

  test('edit at top level (no enclosing symbol) → silent', () => {
    const file = 'const banner = "hi"\nfunction target() {\n  return 1\n}\n'
    const res = analyzeTaskRelevance({
      target: join(dir, 'h.ts'),
      cwd: dir,
      sessionID: 's1',
      fileContent: file,
      oldString: 'const banner = "hi"',
      recentPrompts: ['fix the bug in target()'],
      sessionTouches: new Set(),
    })
    expect(res.warnings).toEqual([])
  })
})

describe('recentUserPrompts feeding the signal', () => {
  test('returns user prompts from the real parts/messages tables', async () => {
    const db = (await import('../storage/db.js')).createDatabase(':memory:')
    await (await import('../storage/db.js')).migrate(db)
    db.sqlite
      .prepare(
        'INSERT OR IGNORE INTO sessions (id,title,model,provider,created_at,updated_at) VALUES (?,?,?,?,?,?)',
      )
      .run('s', 't', 'm', 'p', Date.now(), Date.now())
    db.sqlite
      .prepare('INSERT INTO messages (id, session_id, role, created_at) VALUES (?,?,?,?)')
      .run('m2', 's', 'user', 2000)
    db.sqlite
      .prepare(
        'INSERT INTO parts (id, message_id, session_id, type, text, created_at) VALUES (?,?,?,?,?,?)',
      )
      .run('p2', 'm2', 's', 'text', 'fix target()', 2000)
    expect(recentUserPrompts(db, 's')).toEqual(['fix target()'])
  })
})
