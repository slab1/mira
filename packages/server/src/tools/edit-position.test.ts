import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { applyEditWithFallback } from './edit-fallback.js'

// P3.6 groundwork — wrong-position edit protection.
//
// The line-anchored fallback (Layer 6) used to splice at the FIRST line sharing
// a 20-char prefix of oldString's first line, without checking the rest of the
// span, then reported `verified: true`. A stale snippet whose opening line
// resembled an earlier constructor/import line therefore corrupted the file
// while claiming success. Layer 9 had the same class of problem in reverse:
// it replaced only the first line and silently discarded the remainder.

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mira-editpos-'))
})

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
})

const write = (name: string, content: string) => {
  const p = join(dir, name)
  writeFileSync(p, content, 'utf-8')
  return p
}
const read = (p: string) => readFileSync(p, 'utf-8')

describe('Layer 6 refuses a wrong-position splice', () => {
  const file = `import x from "x"
function build() {
  return x
}

function target() {
  const a = 1
  const b = 2
  return a + b
}
`

  test('rejects when the prefix matches an earlier line that is NOT the target', async () => {
    const p = write('wrong.ts', file)
    // oldString's first line ("  return x") also matches inside build() earlier
    const oldString = ['  return x', '}', ''].join('\n')
    const newString = ['  return x + 1', '}', ''].join('\n')

    let threw = false
    try {
      await applyEditWithFallback(p, oldString, newString, false, dir)
    } catch {
      threw = true
    }
    // Either it refuses outright, or it applies only where the span validates.
    const after = read(p)
    if (!threw) {
      // If it succeeded, the change must be inside build(), not at target()
      const buildIdx = after.indexOf('function build()')
      const targetIdx = after.indexOf('function target()')
      const changed = after.indexOf('return x + 1')
      expect(changed).toBeGreaterThan(buildIdx)
      expect(changed).toBeLessThan(targetIdx)
    } else {
      // Refused: the file must be untouched
      expect(after).toBe(file)
    }
  })

  test('still applies when the position genuinely validates', async () => {
    const p = write('right.ts', file)
    const oldString = ['  const a = 1', '  const b = 2', '  return a + b'].join('\n')
    const newString = ['  const a = 10', '  const b = 2', '  return a + b'].join('\n')

    // Force fallback by making the exact match fail on whitespace only
    const drifted = oldString
      .split('\n')
      .map((l, i) => (i === 1 ? l + ' ' : l))
      .join('\n')
    const res = await applyEditWithFallback(p, drifted, newString, false, dir)
    expect(res.ok).toBe(true)
    expect(read(p)).toContain('const a = 10')
  })

  test('never reports verified:true when the bytes did not change', async () => {
    const p = write('noop.ts', file)
    const oldString = ['  const a = 1', '  const b = 2', '  return a + b'].join('\n')
    const res = await applyEditWithFallback(p, oldString, oldString, false, dir)
    if (res.ok && res.verification) {
      expect(res.verification.verified).toBe(res.verification.preHash !== res.verification.postHash)
    }
  })
})

describe('Layer 9 refuses lossy last-resort replacement', () => {
  test('multi-line edit never silently truncates the file', async () => {
    const p = write('lossy.ts', 'line one\nline two\nline three\n')
    // Exact multi-line match — handled by Layer 1, and must stay lossless.
    const res = await applyEditWithFallback(p, 'line one\nline two', 'REPLACED', false, dir)
    expect(res.ok).toBe(true)
    const after = read(p)
    expect(after).toBe('REPLACED\nline three\n')
    // no line was dropped
    expect(after).toContain('line three')
  })

  test('multi-line edit that must fall through still keeps every line', async () => {
    const p = write('fall.ts', 'alpha\nbeta\ngamma\ndelta\n')
    // Drift the middle line's trailing whitespace so the exact match fails;
    // a correct engine still replaces the whole 2-line span.
    const oldString = ['alpha', 'beta  ', 'gamma'].join('\n')
    let result: Awaited<ReturnType<typeof applyEditWithFallback>> | null = null
    let threw = false
    try {
      result = await applyEditWithFallback(p, oldString, 'BETA', false, dir)
    } catch {
      threw = true
    }
    const after = read(p)
    if (threw) {
      // Refusing is acceptable; losing lines is not.
      expect(after).toBe('alpha\nbeta\ngamma\ndelta\n')
    } else {
      expect(result!.ok).toBe(true)
      expect(after).toContain('delta')
      expect(after).not.toContain('alpha\nbeta')
    }
  })

  test('ambiguous oldString is refused outright, by any layer', async () => {
    // This is the regression: Layer 1 refused the ambiguity, then Layer 2
    // (trimmed) silently edited the FIRST occurrence and reported success.
    const p = write('ambig.ts', 'const x = 1\nconst x = 1\n')
    let threw = false
    let message = ''
    try {
      await applyEditWithFallback(p, 'const x = 1', 'const x = 2', false, dir)
    } catch (e) {
      threw = true
      message = (e as Error).message
    }
    expect(threw).toBe(true)
    expect(message).toContain('Ambiguous')
    expect(read(p)).toBe('const x = 1\nconst x = 1\n')
  })

  test('replaceAll=true still works on an ambiguous string', async () => {
    const p = write('all.ts', 'const x = 1\nconst x = 1\n')
    const res = await applyEditWithFallback(p, 'const x = 1', 'const x = 2', true, dir)
    expect(res.ok).toBe(true)
    expect(res.replaced).toBe(2)
    expect(read(p)).toBe('const x = 2\nconst x = 2\n')
  })

  test('a unique oldString is unaffected by the gate', async () => {
    const p = write('unique.ts', 'first\nsecond\nthird\n')
    const res = await applyEditWithFallback(p, 'second', 'SECOND', false, dir)
    expect(res.ok).toBe(true)
    expect(read(p)).toBe('first\nSECOND\nthird\n')
  })
})
