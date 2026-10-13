/**
 * Variant Benchmark — real candidate measurement from a materialized tree
 *
 * Docs: MIRA_WEAKNESSES_AND_OBSTACLES.md §3/§5/§15 — the honest candidate.
 * `shadow/benchmark.ts` explicitly refuses to fabricate a candidate: a
 * self-benchmark of the registry engine compares production against itself and
 * "passes by construction", and the verifier-only measurement measures a verify
 * run, not the shipped code path.
 *
 * This module measures the candidate by RUNNING IT: given a materialized,
 * patched variant tree (governance/variant.ts), it executes real checks inside
 * that tree and reports what actually happened:
 *   - typecheck (tsc --noEmit) — the patched tree must compile
 *   - the tree's own tests when cheap enough to run
 * Fail-closed by construction:
 *   - no materialized variant → NO measurement (never invent one)
 *   - a failing check → measurement with successRate 0 (the candidate is real
 *     and it is broken — that is the finding, not a missing instrument)
 *   - a check that cannot run (tooling absent) → treated as no measurement for
 *     that axis, never as a pass
 *
 * Documentation Maintenance — 10 items:
 * | # | Item | Status | Evidence |
 * |---|------|--------|----------|
 * | 1 | Implementation path | Implemented | packages/server/src/shadow/variant-benchmark.ts |
 * | 2 | Public interfaces | Implemented | measureVariant(opts): Promise<VariantMeasurement \| null>; VariantMeasurement {version, dir, latencyMs, successRate, costDelta, checks[]} |
 * | 3 | Events | Implemented | none — pure measurement; callers record the result |
 * | 4 | Configuration | Implemented | MIRA_VARIANT_CHECKS (default typecheck); per-check timeout via opts.timeoutMs (default 60s) |
 * | 5 | Tests | Implemented | packages/server/src/shadow/variant-benchmark.test.ts (no-variant → null; passing tree → measured; failing tree → successRate 0) |
 * | 6 | Security boundaries | Implemented | runs only inside a disposable materialized tree; spawns with no shell interpolation of user input; cwd is the variant dir; never writes to the repo tree |
 * | 7 | Operational procedures | Implemented | shadow/start route materializes a variant then calls measureVariant; result feeds ShadowBenchmark as candidateMeasurement |
 * | 8 | Migration strategy | Implemented | additive; shadow/start keeps working without a variant (parity benchmark as before) |
 * | 9 | Rollback strategy | Implemented | variant trees are disposable (VariantWorkspace.dispose) |
 * | 10 | Known limitations | Implemented | measures compile/test viability, not behavioural quality — behavioural comparison needs served traffic (canary Phase 5) |
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { JsonValue } from '../types/index.js'

export interface VariantCheck {
  name: string
  /** 'pass' | 'fail' | 'skipped' — 'skipped' never counts as a pass. */
  outcome: 'pass' | 'fail' | 'skipped'
  exitCode?: number
  latencyMs: number
  detail?: string
}

export interface VariantMeasurement {
  version: string
  dir: string
  latencyMs: number
  successRate: number
  costDelta: number
  checks: VariantCheck[]
}

export interface VariantMeasureOptions {
  /** Absolute path to the materialized, patched tree (never the repo tree). */
  dir: string
  /** Version label for the candidate (e.g. `<engine>+exp:<simulationId>`). */
  version: string
  timeoutMs?: number
  /** Which checks to run — default typecheck only (cheap, decisive). */
  checks?: Array<'typecheck' | 'test'>
}

interface CheckSpec {
  name: 'typecheck' | 'test'
  cmd: string[]
  args: string[]
}

const DEFAULT_CHECKS: Record<'typecheck' | 'test', CheckSpec> = {
  typecheck: { name: 'typecheck', cmd: ['npx'], args: ['tsc', '--noEmit'] },
  test: { name: 'test', cmd: ['bun'], args: ['test'] },
}

/**
 * Resolve the REAL TypeScript compiler.
 *
 * Bare `npx tsc` in a tree without node_modules resolves the unrelated `tsc`
 * npm package (a deprecated placeholder that prints "This is not the tsc
 * command you are looking for") and — critically — EXITS 0. That would make
 * every broken candidate "pass" the shadow check, which is worse than having
 * no check at all. We only run a typecheck when the workspace compiler is
 * actually resolvable; otherwise the check is skipped (never a pass).
 */
function resolveTsc(): string[] | null {
  const roots = [
    process.cwd(),
    // the variant tree itself (when it carries its own node_modules)
    '',
  ]
  const seen = new Set<string>()
  for (const root of roots) {
    let dir = root
    for (let i = 0; i < 8 && dir; i++) {
      if (seen.has(dir)) break
      seen.add(dir)
      const local = join(dir, 'node_modules', '.bin', 'tsc')
      if (existsSync(local)) return [local, '--noEmit']
      const parent = join(dir, '..')
      dir = parent === dir ? '' : parent
    }
  }
  return null
}

function run(spec: CheckSpec, dir: string, timeoutMs: number): Promise<VariantCheck> {
  const t0 = Date.now()
  return new Promise((resolve) => {
    let settled = false
    const finish = (c: VariantCheck) => {
      if (settled) return
      settled = true
      resolve(c)
    }
    try {
      const proc = spawn(spec.cmd[0], spec.args.slice(1), {
        cwd: dir,
        env: { ...process.env, MIRA_NO_AUTOPROVISION: '1', CI: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
      })
      let stderr = ''
      proc.stderr?.on('data', (d: Buffer) => {
        if (stderr.length < 2000) stderr += d.toString()
      })
      proc.on('error', (e) => {
        // Tooling absent (npx/bun not found) — skipped, never a pass.
        finish({
          name: spec.name,
          outcome: 'skipped',
          latencyMs: Date.now() - t0,
          detail: String(e).slice(0, 200),
        })
      })
      proc.on('close', (code) => {
        const out = code === 0 ? 'pass' : 'fail'
        finish({
          name: spec.name,
          outcome: out,
          exitCode: code ?? undefined,
          latencyMs: Date.now() - t0,
          ...(code !== 0 && stderr ? { detail: stderr.slice(0, 400) } : {}),
        })
      })
    } catch (e) {
      finish({
        name: spec.name,
        outcome: 'skipped',
        latencyMs: Date.now() - t0,
        detail: String(e).slice(0, 200),
      })
    }
  })
}

/**
 * Measure a materialized candidate tree by running real checks inside it.
 * Returns null when there is no candidate to measure (fail-closed — the caller
 * then falls back to whatever it did before, never to a fabricated number).
 */
export async function measureVariant(
  opts: VariantMeasureOptions,
): Promise<VariantMeasurement | null> {
  if (!opts?.dir) return null
  const dir = String(opts.dir)
  const timeoutMs = opts.timeoutMs ?? 60_000
  const wanted = opts.checks ?? ['typecheck']
  const t0 = Date.now()

  const results: VariantCheck[] = []
  for (const name of wanted) {
    if (name === 'typecheck') {
      const tsc = resolveTsc()
      if (!tsc) {
        // No real compiler resolvable — skipped, never counted as a pass.
        results.push({
          name: 'typecheck',
          outcome: 'skipped',
          latencyMs: 0,
          detail:
            'no real TypeScript compiler resolvable (bare npx tsc is the deprecated placeholder package and exits 0)',
        })
        continue
      }
      results.push(
        await run({ name: 'typecheck', cmd: [tsc[0]], args: tsc.slice(1) }, dir, timeoutMs),
      )
      continue
    }
    const spec = DEFAULT_CHECKS[name]
    if (!spec) continue
    results.push(await run(spec, dir, timeoutMs))
  }

  // No check produced a verdict → no measurement (never invent one).
  const decided = results.filter((c) => c.outcome !== 'skipped')
  if (decided.length === 0) return null

  const passed = decided.filter((c) => c.outcome === 'pass').length
  return {
    version: String(opts.version ?? 'candidate'),
    dir,
    latencyMs: Date.now() - t0,
    successRate: passed / decided.length,
    // Candidate execution cost is the measured check time, normalized against
    // the §16 cost baseline per task (0.18).
    costDelta: Math.max(0, (Date.now() - t0) / 1000 / 0.18),
    checks: results,
  }
}

/** Measurement detail shaped for the shadow record / Bus payload. */
export function measurementToJson(m: VariantMeasurement): JsonValue {
  return {
    version: m.version,
    latencyMs: m.latencyMs,
    successRate: m.successRate,
    costDelta: m.costDelta,
    checks: m.checks,
    source: 'variant-tree-execution',
  } as unknown as JsonValue
}
