import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { editTool, validateNearAnchor } from './edit.js'

// The intent anchor (`near`): a perfectly-matching oldString can still sit in
// the WRONG function. No string matcher can detect that — the mismatch is
// intent, not text. `near` lets the agent declare intent and the edit is
// refused when it would land outside the named region.

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mira-anchor-'))
})

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
})

const FILE = [
  'import x from "x"',
  'function build() {',
  '  return x',
  '}',
  '',
  'function target() {',
  '  const a = 1',
  '  const b = 2',
  '  return a + b',
  '}',
].join('\n')

const setup = (content = FILE) => {
  const p = join(dir, 'code.ts')
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content, 'utf-8')
  return p
}

describe('validateNearAnchor', () => {
  test('anchor before the match, within window → pass', () => {
    expect(validateNearAnchor(FILE, '  const a = 1', 'function target', 'code.ts')).toBeNull()
  })

  test('anchor only AFTER the match → refuse (editing outside the named region)', () => {
    const err = validateNearAnchor(FILE, '  return x', 'function target', 'code.ts')
    expect(err).toContain('only AFTER')
  })

  test('anchor not in the file at all → refuse', () => {
    const err = validateNearAnchor(FILE, '  const a = 1', 'function nonexistent', 'code.ts')
    expect(err).toContain('not found')
  })

  test('ambiguous oldString → skipped (ambiguity handled elsewhere)', () => {
    expect(validateNearAnchor('x\nx\n', 'x', 'anchor', 'f.ts')).toBeNull()
  })

  test('oldString not present → skipped (fallback layers will handle)', () => {
    expect(validateNearAnchor(FILE, 'not-present', 'function target', 'code.ts')).toBeNull()
  })

  test('beyond the window → refuse with the distance', () => {
    const far = [
      'function anchor() {',
      ...Array.from({ length: 60 }, (_, i) => `  // fill ${i}`),
      '  const deep = 1',
      '}',
    ].join('\n')
    const err = validateNearAnchor(far, '  const deep = 1', 'function anchor', 'code.ts')
    expect(err).toContain('61 lines above')
  })

  test('repeated anchor: the ENCLOSING (last before match) one counts', () => {
    const nested = [FILE, '', 'function target2() {', '  const a = 1', '}'].join('\n')
    // 'const a = 1' appears twice; the second is inside target2 — anchor is target2
    expect(validateNearAnchor(nested, '  const a = 1', 'function target2', 'code.ts')).toBeNull()
  })
})

describe('edit tool with near', () => {
  test('stale snippet matching the WRONG function is refused', async () => {
    const p = setup()
    const ctx = { cwd: dir } as never
    const res = (await editTool.execute(
      {
        path: 'code.ts',
        oldString: '  return x\n}\n',
        newString: '  return x + 1\n}\n',
        near: 'function target',
      },
      ctx,
    )) as { ok: boolean; error?: string }
    expect(res.ok).toBe(false)
    expect(res.error).toContain('near-anchor')
    // file untouched
    expect(readFileSync(p, 'utf-8')).toBe(FILE)
  })

  test('correct edit inside the anchored region passes and reports it', async () => {
    setup()
    const ctx = { cwd: dir } as never
    const res = (await editTool.execute(
      {
        path: 'code.ts',
        oldString: '  const a = 1',
        newString: '  const a = 10',
        near: 'function target',
      },
      ctx,
    )) as { ok: boolean; anchorVerified?: boolean }
    expect(res.ok).toBe(true)
    expect(res.anchorVerified).toBe(true)
    expect(readFileSync(join(dir, 'code.ts'), 'utf-8')).toContain('const a = 10')
  })

  test('no anchor → behaves exactly as before', async () => {
    setup()
    const ctx = { cwd: dir } as never
    // exact match in build() — without an anchor this legitimately applies
    const res = (await editTool.execute(
      { path: 'code.ts', oldString: '  return x', newString: '  return x * 2' },
      ctx,
    )) as { ok: boolean }
    expect(res.ok).toBe(true)
  })
})
