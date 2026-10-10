import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { synthesizeAppendDiff } from './diff.js'
import { Patcher } from './patcher.js'
import type { PainPoint } from './detector.js'

describe('synthesizeAppendDiff', () => {
  test('returns null when old content is unavailable (never fabricates anchors)', () => {
    expect(synthesizeAppendDiff('x.md', null, 'note')).toBeNull()
    expect(synthesizeAppendDiff('x.md', undefined, 'note')).toBeNull()
  })

  test('emits anchored unified diff for append notes', () => {
    const old = 'line one\nline two\nline three\n'
    const r = synthesizeAppendDiff('docs/x.md', old, 'improvement note')
    expect(r).not.toBeNull()
    expect(r!.diff).toContain('--- a/docs/x.md')
    expect(r!.diff).toContain('+++ b/docs/x.md')
    expect(r!.diff).toContain(' line two')
    expect(r!.diff).toContain(' line three')
    expect(r!.diff).toContain('+improvement note')
    // hunk header must exist and reference plausible ranges
    expect(r!.diff).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/)
  })

  test('handles empty file', () => {
    const r = synthesizeAppendDiff('docs/x.md', '', 'first note')
    expect(r).not.toBeNull()
    expect(r!.diff).toContain('+first note')
  })
})

describe('Patcher diff + rollbackPlan (P1.3)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mira-patcher-'))
    writeFileSync(join(dir, 'AGENTS.md'), '# Agent Instructions\n\nexisting content\n')
  })

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })

  const pain = (overrides: Partial<PainPoint> = {}): PainPoint =>
    ({
      id: 'over-eager',
      label: 'Over-eager tool calls',
      severity: 'high',
      score: 0.9,
      threshold: 0.5,
      evidence: ['too many tool calls per turn'],
      ...overrides,
    }) as PainPoint

  test('patches targeting existing files carry a unified diff', () => {
    const p = new Patcher({ rootDir: dir, maxPatchesPerCycle: 5 })
    const patches = p.generate([pain()])
    expect(patches.length).toBe(1)
    expect(patches[0]!.targetFile).toBe('AGENTS.md')
    expect(patches[0]!.diff).toBeDefined()
    expect(patches[0]!.diff).toContain('--- a/AGENTS.md')
    expect(patches[0]!.diff).toContain('+Guard over-eager')
    expect(patches[0]!.diff).toContain(' existing content') // context line
  })

  test('patches for missing targets still generated, diff absent (never fabricated)', () => {
    const p = new Patcher({ rootDir: dir, maxPatchesPerCycle: 5 })
    // token-cost targets src/session/prompt.ts, absent in fixture
    const patches = p.generate([pain({ id: 'token-cost' })])
    expect(patches.length).toBe(1)
    expect(patches[0]!.change.length).toBeGreaterThan(0)
    expect(patches[0]!.diff).toBeUndefined()
  })

  test('every patch carries a rollbackPlan', () => {
    const p = new Patcher({ rootDir: dir })
    const patches = p.generate([pain(), pain({ id: 'latency' })])
    for (const patch of patches) {
      expect(patch.rollbackPlan).toBeDefined()
      expect(patch.rollbackPlan!.lossless).toBe(true)
      expect(patch.rollbackPlan!.steps.length).toBeGreaterThan(0)
    }
  })

  test('manual patches also carry a rollbackPlan', () => {
    const p = new Patcher({ rootDir: dir })
    const patch = p.createManual({
      painPointId: 'security',
      kind: 'security',
      targetFile: 'src/patching/security.ts',
      reason: 'test',
      change: 'manual change',
    })
    expect(patch.rollbackPlan?.strategy).toBe('snapshot')
  })
})
