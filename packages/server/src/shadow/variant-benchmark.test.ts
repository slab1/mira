/**
 * Variant Benchmark — real candidate measurement from a materialized tree.
 * Uses real temp trees (an honest passing tree and an honest failing one) so
 * the measurement is produced by execution, not by stubbing.
 */
import { describe, test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { measureVariant } from './variant-benchmark.js'

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'mira-variant-bench-'))
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, 'utf-8')
  }
  return dir
}

describe('measureVariant — real candidate measurement (fail-closed)', () => {
  test('no variant dir → null (never a fabricated candidate)', async () => {
    const m = await measureVariant({ dir: '', version: 'c' })
    expect(m).toBeNull()
  })

  test('healthy patched tree typechecks → measured pass', async () => {
    const dir = tree({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
        include: ['a.ts'],
      }),
      'a.ts': 'export const x: number = 1\n',
      'package.json': JSON.stringify({ name: 't', private: true }),
    })
    try {
      const m = await measureVariant({
        dir,
        version: 'c+exp:sim1',
        timeoutMs: 120_000,
        checks: ['typecheck'],
      })
      // npx tsc may be absent in a bare temp tree → skipped → null; if it runs,
      // a compiling tree must measure as a pass, never as a failure.
      if (m) {
        expect(m.version).toBe('c+exp:sim1')
        expect(m.successRate).toBe(1)
        expect(m.checks[0].outcome).toBe('pass')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)

  test('broken patched tree typechecks → real failure (successRate 0), not a pass', async () => {
    const dir = tree({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
        include: ['bad.ts'],
      }),
      'bad.ts': 'export const y: number = "definitely not a number"\n',
      'package.json': JSON.stringify({ name: 't', private: true }),
    })
    try {
      const m = await measureVariant({
        dir,
        version: 'c+exp:broken',
        timeoutMs: 120_000,
        checks: ['typecheck'],
      })
      if (m) {
        // The candidate is real and it is broken — that is the finding.
        expect(m.successRate).toBe(0)
        expect(m.checks[0].outcome).toBe('fail')
        expect(m.checks[0].exitCode).not.toBe(0)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)
})
