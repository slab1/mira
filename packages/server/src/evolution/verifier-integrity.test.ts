/**
 * §4 verification integrity — a verifier that checks the wrong tree is worse
 * than no verifier, because it reports success.
 *
 * These tests are regression locks for defects found by EXECUTION:
 *   1. verify() ran `npx tsc` with cwd = the untouched repository, so a
 *      candidate that could not compile was measured as passing with zero
 *      issues.
 *   2. bare `npx tsc` resolves the deprecated `tsc` placeholder npm package,
 *      which exits 0 — so even a correct cwd would have passed anything.
 *   3. `verified` allowed a failed typecheck through whenever risk < 0.9.
 * A candidate with no tree is reported UNVERIFIED rather than passed.
 */
import { describe, test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verify } from './verifier.js'
import { createExperiment } from './experiment.js'
import { diagnose } from './diagnosis.js'
import { propose } from './proposal.js'

/** Materialize a real candidate tree whose only source is `src`. */
function tree(src: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mira-verify-cand-'))
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      include: ['thing.ts'],
    }),
    'utf-8',
  )
  writeFileSync(join(dir, 'thing.ts'), src, 'utf-8')
  writeFileSync(join(dir, 'package.json'), '{"name":"c"}\n', 'utf-8')
  return dir
}

const breakingDiff = [
  '--- a/src/thing.ts',
  '+++ b/src/thing.ts',
  '@@ -1,1 +1,1 @@',
  '-export const x: number = 1',
  '+export const x: number = "a string where a number belongs"',
].join('\n')

function breakingExperiment() {
  const d = diagnose({ failure: 'edit failed on thing.ts', evidence: {}, timestamp: Date.now() })
  const p = propose(d)
  return createExperiment(p, breakingDiff, { targetFile: 'src/thing.ts', appliable: true })
}

describe('§4: verification checks the CANDIDATE, not the repository', () => {
  test('a candidate tree that cannot compile → verified:false', async () => {
    const dir = tree('export const x: number = "a string where a number belongs"\n')
    try {
      const r = await verify(breakingExperiment(), {
        runStatic: true,
        treeDir: dir,
        timeoutMs: 120_000,
      })
      expect(r.static.passed).toBe(false)
      expect(r.verified).toBe(false)
      expect(r.static.issues.join(' ')).toContain('fails typecheck')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)

  test('a candidate tree that compiles → verified:true', async () => {
    const dir = tree('export const x: number = 42\n')
    try {
      const r = await verify(breakingExperiment(), {
        runStatic: true,
        treeDir: dir,
        timeoutMs: 120_000,
      })
      expect(r.static.passed).toBe(true)
      expect(r.verified).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)

  test('runStatic with no candidate tree → unverified, never a pass', async () => {
    const r = await verify(breakingExperiment(), { runStatic: true })
    expect(r.static.passed).toBe(false)
    expect(r.verified).toBe(false)
    expect(r.static.issues.join(' ')).toContain('no candidate tree')
  })

  test('a candidate tree with no static run → explicitly unverified', async () => {
    const dir = tree('export const x: number = 42\n')
    try {
      const r = await verify(breakingExperiment(), { treeDir: dir })
      expect(r.static.passed).toBe(false)
      expect(r.verified).toBe(false)
      expect(r.static.issues.join(' ')).toContain('unverified')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the placeholder-package trap: verification never uses bare npx tsc', async () => {
    // A tree with no node_modules would make bare `npx tsc` resolve the
    // deprecated `tsc` placeholder package, which exits 0 and passes anything.
    // The broken content below must still be rejected.
    const dir = tree('export const y: number = "still not a number"\n')
    try {
      const r = await verify(breakingExperiment(), {
        runStatic: true,
        treeDir: dir,
        timeoutMs: 120_000,
      })
      expect(r.verified).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)
})
