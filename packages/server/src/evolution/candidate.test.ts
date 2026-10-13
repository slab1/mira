/**
 * Candidate construction — a proposal becomes a REAL candidate only when the
 * change is genuinely appliable: real diff, real file, inside the repo, and
 * one the proposal actually claims. Everything else is an investigation.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCandidatePatch, diffTargetFile, isSafeRepoPath } from './candidate.js'
import type { ImprovementProposal } from './proposal.js'

let repo: string

const proposal = (over: Partial<ImprovementProposal> = {}): ImprovementProposal =>
  ({
    id: 'prop_1',
    title: 'Improve tool: edit failed',
    type: 'fix',
    risk: 'low',
    priority: 'P1',
    affectedEngine: 'tool',
    evidence: null,
    expectedImpact: 'raise edit success',
    cause: 'edit/patch application failure',
    confidence: 0.7,
    createdAt: Date.now(),
    rollbackPlan: { strategy: 'snapshot', steps: [], lossless: true },
    ...over,
  }) as unknown as ImprovementProposal

const realDiff = (file: string, from: string, to: string) =>
  ['--- a/' + file, '+++ b/' + file, `@@ -1,1 +1,1 @@`, '-' + from, '+' + to].join('\n')

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'mira-candidate-'))
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'src', 'mod.ts'), 'export const value = 1\n', 'utf-8')
  writeFileSync(join(repo, 'package.json'), '{"name":"r"}\n', 'utf-8')
})
afterEach(() => {
  try {
    rmSync(repo, { recursive: true, force: true })
  } catch {}
})

describe('diffTargetFile / isSafeRepoPath', () => {
  test('extracts the b/ target and ignores emitter tab columns', () => {
    expect(diffTargetFile(realDiff('src/mod.ts', 'a', 'b'))).toBe('src/mod.ts')
    expect(diffTargetFile('--- a/x\n+++ b/x\t2026-01-01\n@@ -1 +1 @@\n-a\n+b')).toBe('x')
    expect(diffTargetFile('no diff here')).toBeNull()
  })

  test('rejects traversal and absolute paths', () => {
    expect(isSafeRepoPath('src/mod.ts')).toBe(true)
    expect(isSafeRepoPath('../outside.ts')).toBe(false)
    expect(isSafeRepoPath('src/../../etc/passwd')).toBe(false)
    expect(isSafeRepoPath('/etc/passwd')).toBe(false)
    expect(isSafeRepoPath('')).toBe(false)
  })
})

describe('buildCandidatePatch — real candidates only', () => {
  test('a real diff against an existing claimed file builds a candidate', () => {
    const c = buildCandidatePatch({
      proposal: proposal(),
      change: realDiff('src/mod.ts', 'export const value = 1', 'export const value = 42'),
      claimedFiles: ['src/mod.ts'],
      repoRoot: repo,
    })
    expect(c).not.toBeNull()
    expect(c!.targetFile).toBe('src/mod.ts')
    expect(c!.patch.targetFile).toBe('src/mod.ts')
    expect(c!.patch.diff).toContain('export const value = 42')
    expect(c!.basis).toContain('real unified diff')
  })

  test('prose intent → null (no fabricated patch)', () => {
    expect(
      buildCandidatePatch({
        proposal: proposal(),
        change: 'make edits more reliable',
        repoRoot: repo,
      }),
    ).toBeNull()
  })

  test('placeholder-style diff against a nonexistent path → null', () => {
    expect(
      buildCandidatePatch({
        proposal: proposal(),
        change: realDiff('tool', 'x', 'y'),
        repoRoot: repo,
      }),
    ).toBeNull()
  })

  test('diff against an existing but UNCLAIMED file → null (no smuggling)', () => {
    const c = buildCandidatePatch({
      proposal: proposal(),
      change: realDiff('src/mod.ts', 'export const value = 1', 'export const value = 42'),
      claimedFiles: ['src/other.ts'],
      repoRoot: repo,
    })
    expect(c).toBeNull()
  })

  test('traversal diff → null even if the file exists outside the repo', () => {
    const outside = mkdtempSync(join(tmpdir(), 'mira-outside-'))
    writeFileSync(join(outside, 'secret.ts'), 'export const secret = 1\n', 'utf-8')
    try {
      const c = buildCandidatePatch({
        proposal: proposal(),
        change: realDiff(`../${join(outside, 'secret.ts').split('/').pop()}`, 'a', 'b'),
        claimedFiles: ['../secret.ts'],
        repoRoot: repo,
      })
      expect(c).toBeNull()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test('symlink escape → null (realpath containment)', () => {
    const outside = mkdtempSync(join(tmpdir(), 'mira-outside2-'))
    writeFileSync(join(outside, 'secret.ts'), 'export const secret = 1\n', 'utf-8')
    try {
      symlinkSync(join(outside, 'secret.ts'), join(repo, 'src', 'link.ts'))
      const c = buildCandidatePatch({
        proposal: proposal(),
        change: realDiff('src/link.ts', 'export const secret = 1', 'export const secret = 2'),
        claimedFiles: ['src/link.ts'],
        repoRoot: repo,
      })
      expect(c).toBeNull()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
