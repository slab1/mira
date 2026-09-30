/**
 * Mira Eval — Main Runner (3-Tier)
 *
 * Tiers:
 *   pr       → fast checks, blocks merge (< 5 min)
 *   nightly  → LLM-as-judge + benchmarks (~30 min)
 *   prod     → drift alerts (continuous)
 *
 * Usage:
 *   bun src/eval/index.ts --tier pr
 *   bun src/eval/index.ts --tier nightly
 *   bun src/eval/index.ts --tier prod
 *   bun src/eval/index.ts --tier all
 *   bun src/eval/index.ts --suite=curated --limit=25 --json --out result.json
 *
 * Programmatic:
 *   import { runEval, EvalRunner } from "./eval/index.js"
 *   const report = await runEval("pr")
 */

import { getTier, type TierName, type TierReport } from './tiers.js'
import {
  createTrace,
  startSpan,
  endSpan,
  flush,
  exportTraces,
  type ExportedTraces,
} from './tracing.js'
import { runBenchmark, type BenchmarkResult } from './benchmarks.js'
import { runJudgeSuite, type JudgeSuiteResult } from './judge.js'

export interface EvalReport {
  requested: TierName | 'all'
  at: string
  sha?: string
  branch?: string
  tiers: TierReport[]
  passed: boolean
  durationMs: number
  traces?: ExportedTraces
}

export class EvalRunner {
  async run(
    tier: TierName | 'all',
    opts: { sha?: string; branch?: string } = {},
  ): Promise<EvalReport> {
    const t0 = Date.now()
    const trace = createTrace(`eval:${tier}`, { tier, sha: opts.sha, branch: opts.branch })
    const targetTiers: TierName[] =
      tier === 'all' ? (['pr', 'nightly', 'prod'] as TierName[]) : [tier as TierName]

    const reports: TierReport[] = []
    for (const name of targetTiers) {
      const cfg = getTier(name)
      const span = startSpan(trace, `tier:${name}`, { tier: name })
      try {
        const { runTier } = await import('./tiers.js')
        const report = await runTier(cfg, {
          tier: name,
          sha: opts.sha ?? process.env.GITHUB_SHA,
          branch: opts.branch ?? process.env.GITHUB_REF_NAME,
          env: process.env as Record<string, string>,
        })
        endSpan(span, {
          passed: report.passed,
          checks: report.checks.length,
          summary: report.summary,
        })
        reports.push(report)
        console.log(`[eval:${name}] ${report.summary}`)
        for (const c of report.checks) {
          const icon = c.passed ? '✓' : '✗'
          console.log(
            `  ${icon} ${c.checkId} — ${c.message ?? ''} ${c.score !== undefined ? `(score ${c.score.toFixed(2)})` : ''} ${c.latencyMs}ms`,
          )
        }
        // If PR tier fails and it's blocking, short-circuit (still reports)
        if (!report.passed && cfg.blocking) {
          console.error(`[eval] blocking tier ${name} failed — stopping`)
          if (tier !== 'all') break
        }
      } catch (e) {
        endSpan(span, { error: String(e) }, true)
        const failed: TierReport = {
          tier: name,
          passed: false,
          durationMs: Date.now() - span.startMs,
          checks: [{ checkId: 'tier-error', passed: false, latencyMs: 0, message: String(e) }],
          summary: `${name} ERROR: ${String(e).slice(0, 200)}`,
        }
        reports.push(failed)
      }
    }

    await flush().catch(() => {})
    const durationMs = Date.now() - t0
    const passed = reports.every((r) => r.passed)
    const at = new Date().toISOString()
    if (!passed) console.error(`[eval] ✗ ${tier} FAILED in ${durationMs}ms`)
    else console.log(`[eval] ✓ ${tier} PASSED in ${durationMs}ms`)

    return {
      requested: tier,
      at,
      sha: opts.sha ?? process.env.GITHUB_SHA,
      branch: opts.branch,
      tiers: reports,
      passed,
      durationMs,
      traces: exportTraces(),
    }
  }
}

export async function runEval(
  tier: TierName | 'all' = 'pr',
  opts: { sha?: string; branch?: string } = {},
): Promise<EvalReport> {
  const runner = new EvalRunner()
  return runner.run(tier, opts)
}

// ── Suites (single-benchmark CI steps) ────────────────────────────────
//
// The eval.yml workflow runs one suite per step so a failure is attributable.
// Thresholds mirror the tier checks in tiers.ts so gating is consistent.

export type SuiteName = 'judge' | 'swe-bench' | 'terminal-bench' | 'locomo' | 'curated'

export const SUITE_NAMES: readonly SuiteName[] = [
  'judge',
  'swe-bench',
  'terminal-bench',
  'locomo',
  'curated',
] as const

/** Minimum passRate for a suite to count as PASSED (mirrors tiers.ts checks) */
const SUITE_THRESHOLDS: Record<SuiteName, number> = {
  judge: 0.7,
  'swe-bench': 0.33,
  'terminal-bench': 0.5,
  locomo: 0.5,
  curated: 0.5,
}

/** Default task budget for the curated suite (plan: 25-task benchmark) */
export const CURATED_BUDGET_DEFAULT = 25

export interface SuiteReport {
  suite: SuiteName
  at: string
  passed: boolean
  durationMs: number
  /** pass threshold applied */
  threshold: number
  /** task budget (curated only); undefined when unbounded */
  limit?: number
  total: number
  passedCount: number
  passRate: number
  /** present for benchmark suites and curated */
  benchmarks?: BenchmarkResult[]
  /** present for judge suite */
  judge?: JudgeSuiteResult
}

/**
 * Run a single eval suite by name.
 *
 * - `judge`           → LLM-as-judge fixture suite
 * - `swe-bench`       → swe-bench-mini
 * - `terminal-bench`  → terminal-bench-mini
 * - `locomo`          → locomo-mini
 * - `curated`         → all three benchmarks under a shared task budget
 *                       (default 25; current mini fixtures total 7 tasks)
 *
 * `opts.limit` caps the number of tasks (judge: sample size, curated: budget).
 */
export async function runSuite(
  suite: SuiteName,
  opts: { limit?: number } = {},
): Promise<SuiteReport> {
  const t0 = Date.now()
  const threshold = SUITE_THRESHOLDS[suite]
  const limit = typeof opts.limit === 'number' && opts.limit > 0 ? opts.limit : undefined

  let benchmarks: BenchmarkResult[] | undefined
  let judgeSuite: JudgeSuiteResult | undefined

  if (suite === 'judge') {
    judgeSuite = await runJudgeSuite({ sample: limit })
  } else if (suite === 'curated') {
    // Shared task budget across benches: consume sequentially until exhausted.
    benchmarks = []
    let budget = limit ?? CURATED_BUDGET_DEFAULT
    for (const id of ['swe-bench-mini', 'terminal-bench-mini', 'locomo-mini'] as const) {
      if (budget <= 0) break
      const r = await runBenchmark(id, { limit: budget })
      benchmarks.push(r)
      budget -= r.total
    }
  } else {
    const id =
      suite === 'swe-bench'
        ? 'swe-bench-mini'
        : suite === 'terminal-bench'
          ? 'terminal-bench-mini'
          : 'locomo-mini'
    benchmarks = [await runBenchmark(id, { limit })]
  }

  const total = judgeSuite ? judgeSuite.total : (benchmarks ?? []).reduce((s, b) => s + b.total, 0)
  const passedCount = judgeSuite
    ? judgeSuite.passed
    : (benchmarks ?? []).reduce((s, b) => s + b.passed, 0)
  const passRate = total > 0 ? passedCount / total : 0
  const passed = total > 0 && passRate >= threshold

  return {
    suite,
    at: new Date().toISOString(),
    passed,
    durationMs: Date.now() - t0,
    threshold,
    limit,
    total,
    passedCount,
    passRate,
    ...(benchmarks && benchmarks.length > 0 ? { benchmarks } : {}),
    ...(judgeSuite ? { judge: judgeSuite } : {}),
  }
}

/** Parse `--suite=<name>` / `--suite <name>`. Unknown names warn + return undefined. */
export function parseSuite(argv: string[]): SuiteName | undefined {
  const idx = argv.findIndex((a) => a === '--suite')
  const raw = idx !== -1 ? argv[idx + 1] : argv.find((a) => a.startsWith('--suite='))?.split('=')[1]
  if (!raw) return undefined
  const v = raw.toLowerCase()
  if ((SUITE_NAMES as readonly string[]).includes(v)) return v as SuiteName
  console.warn(`[eval] unrecognized suite "${raw}", known: ${SUITE_NAMES.join(', ')}`)
  return undefined
}

/** Parse `--limit=<n>` / `--limit <n>`. Invalid/absent → undefined. */
export function parseLimit(argv: string[]): number | undefined {
  const idx = argv.findIndex((a) => a === '--limit')
  const raw = idx !== -1 ? argv[idx + 1] : argv.find((a) => a.startsWith('--limit='))?.split('=')[1]
  if (!raw) return undefined
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(`[eval] invalid --limit "${raw}", ignoring`)
    return undefined
  }
  return n
}

// ── CLI ───────────────────────────────────────────────────────────────

function parseTier(argv: string[]): TierName | 'all' {
  const idx = argv.findIndex((a) => a === '--tier' || a === '-t')
  const raw = idx !== -1 ? argv[idx + 1] : argv.find((a) => a.startsWith('--tier='))?.split('=')[1]
  const v = (raw ?? 'pr').toLowerCase()
  if (v === 'all' || v === 'pr' || v === 'nightly' || v === 'prod') return v
  console.warn(`[eval] unrecognized tier "${raw}", defaulting to pr`)
  return 'pr'
}

export function printReport(report: EvalReport): void {
  console.log('\n' + '─'.repeat(60))
  console.log(
    `Mira Eval Report — ${report.requested} — ${report.passed ? 'PASS' : 'FAIL'} — ${report.durationMs}ms`,
  )
  console.log(
    `at: ${report.at}  sha: ${report.sha ?? 'local'}  branch: ${report.branch ?? 'local'}`,
  )
  for (const t of report.tiers) {
    console.log(`\n[${t.tier}] ${t.summary}`)
    for (const c of t.checks)
      console.log(`  ${c.passed ? '✓' : '✗'} ${c.checkId.padEnd(18)} ${c.message ?? ''}`)
  }
  console.log('─'.repeat(60) + '\n')
}

if (import.meta.main) {
  const suite = parseSuite(Bun.argv)
  const runner = new EvalRunner()

  if (suite) {
    // Single-suite mode: one benchmark per CI step (eval.yml)
    const report = await runSuite(suite, { limit: parseLimit(Bun.argv) })
    const icon = report.passed ? '✓' : '✗'
    console.log(
      `[eval] ${icon} suite=${report.suite} ${report.passedCount}/${report.total} ` +
        `passRate=${(report.passRate * 100).toFixed(1)}% threshold=${report.threshold} ` +
        `in ${report.durationMs}ms`,
    )
    if (Bun.argv.includes('--json')) {
      const out = Bun.argv.includes('--out') ? Bun.argv[Bun.argv.indexOf('--out') + 1] : undefined
      const json = JSON.stringify(report, null, 2)
      if (out) await Bun.write(out, json)
      else console.log(json)
    }
    if (process.env.GITHUB_OUTPUT) {
      try {
        await Bun.write(
          process.env.GITHUB_OUTPUT,
          `passed=${report.passed}\ndurationMs=${report.durationMs}\npassRate=${report.passRate}\n`,
        )
      } catch {}
    }
    process.exit(report.passed ? 0 : 1)
  }

  const tier = parseTier(Bun.argv)
  const report = await runner.run(tier)
  printReport(report)
  // Emit JSON for CI artifacts if requested
  if (Bun.argv.includes('--json')) {
    const out = Bun.argv.includes('--out') ? Bun.argv[Bun.argv.indexOf('--out') + 1] : undefined
    const json = JSON.stringify(report, null, 2)
    if (out) await Bun.write(out, json)
    else console.log(json)
  }
  // GitHub Actions output
  if (process.env.GITHUB_OUTPUT) {
    try {
      await Bun.write(
        process.env.GITHUB_OUTPUT,
        `passed=${report.passed}\ndurationMs=${report.durationMs}\n`,
      )
    } catch {}
  }
  process.exit(report.passed ? 0 : 1)
}

// Re-exports for ergonomic imports
export * from './tiers.js'
export * from './judge.js'
export * from './benchmarks.js'
export * from './tracing.js'
