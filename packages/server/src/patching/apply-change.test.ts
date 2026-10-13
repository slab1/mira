/**
 * applyChange — real unified-diff application (the mechanism that makes a
 * candidate variant tree a genuinely different code path) plus the legacy
 * note-append fallback. Fail-closed on context drift.
 */
import { describe, test, expect } from 'bun:test'
import { applyChange, applyUnifiedDiff, isUnifiedDiff } from './apply-change.js'

describe('isUnifiedDiff', () => {
  test('recognizes a git-style diff and rejects prose', () => {
    expect(isUnifiedDiff('--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1,2 +1,3 @@\n a\n+b\n')).toBe(true)
    expect(isUnifiedDiff('just make it faster')).toBe(false)
    expect(isUnifiedDiff('--- a/x.ts\n+++ b/x.ts\n')).toBe(false) // no hunk
  })
})

describe('applyUnifiedDiff — real changes', () => {
  test('applies an anchored insertion', () => {
    const original = 'line1\nline2\nline3\n'
    const diff = [
      '--- a/f.ts',
      '+++ b/f.ts',
      '@@ -2,2 +2,3 @@',
      ' line2',
      ' line3',
      '+inserted',
    ].join('\n')
    expect(applyUnifiedDiff(original, diff)).toBe('line1\nline2\nline3\ninserted\n')
  })

  test('applies a deletion', () => {
    const original = 'line1\nline2\nline3\n'
    const diff = ['--- a/f.ts', '+++ b/f.ts', '@@ -1,3 +1,2 @@', ' line1', '-line2', ' line3'].join(
      '\n',
    )
    expect(applyUnifiedDiff(original, diff)).toBe('line1\nline3\n')
  })

  test('preserves file-ending style (no trailing newline stays none)', () => {
    const original = 'line1\nline2'
    const diff = ['--- a/f.ts', '+++ b/f.ts', '@@ -1,2 +1,3 @@', ' line1', ' line2', '+x'].join(
      '\n',
    )
    expect(applyUnifiedDiff(original, diff)).toBe('line1\nline2\nx')
  })

  test('context drift → null (never a partial apply)', () => {
    const original = 'totally\ndifferent\ncontent\n'
    const diff = ['--- a/f.ts', '+++ b/f.ts', '@@ -1,2 +1,3 @@', ' line1', ' line2', '+x'].join(
      '\n',
    )
    expect(applyUnifiedDiff(original, diff)).toBeNull()
  })

  test('multi-hunk applies in order', () => {
    const original = 'a\nb\nc\nd\ne\nf\ng\n'
    const diff = [
      '--- a/f.ts',
      '+++ b/f.ts',
      '@@ -1,2 +1,3 @@',
      ' a',
      '+a2',
      ' b',
      '@@ -6,2 +7,2 @@',
      ' f',
      '-g2',
      '+g3',
    ].join('\n')
    // The second hunk's context does not exist in this file — drift → null
    expect(applyUnifiedDiff(original, diff)).toBeNull()
  })
})

describe('applyChange — precedence and fail-closed behaviour', () => {
  test('a real diff is applied (not note-appended)', () => {
    const original = 'export const a = 1\n'
    const diff = [
      '--- a/f.ts',
      '+++ b/f.ts',
      '@@ -1,1 +1,2 @@',
      ' export const a = 1',
      '+export const b = 2',
    ].join('\n')
    const out = applyChange(original, diff, 'f.ts')
    expect(out).toContain('export const b = 2')
    expect(out).not.toContain('Mira Patch') // not note-appended
  })

  test('a stale diff returns the original unchanged (no fake success)', () => {
    const original = 'nothing like the anchor\n'
    const diff = [
      '--- a/f.ts',
      '+++ b/f.ts',
      '@@ -1,2 +1,3 @@',
      ' expected',
      ' context',
      '+x',
    ].join('\n')
    expect(applyChange(original, diff, 'f.ts')).toBe(original)
  })

  test('prose change falls back to the idempotent note append', () => {
    const original = 'export const a = 1\n'
    const out = applyChange(original, 'make this faster somehow', 'f.ts')
    expect(out).toContain('Mira Patch')
    // idempotent — applying the same note again does not duplicate it
    expect(applyChange(out, 'make this faster somehow', 'f.ts')).toBe(out)
  })

  test('markdown targets get an HTML comment note', () => {
    const out = applyChange('# Title\n', 'clarify wording', 'README.md')
    expect(out).toContain('<!-- Mira Patch')
  })
})
