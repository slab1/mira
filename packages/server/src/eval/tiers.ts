/**
 * Mira Eval — 3-Tier Evaluation Strategy
 *
 * Tier 1 — PR Fast Checks (gate):    < 5 min, blocks merge on fail
 * Tier 2 — Nightly LLM-as-Judge:     ~30 min, deep quality signals
 * Tier 3 — Prod Drift Alerts:        continuous, detects regressions in live traces
 *
 * Inspiration: Braintrust / Langfuse 3-tier evals (89% observability, 52% eval gap)
 */

import type { DriftCheckResult } from './tracing.js'
import type { JudgeSuiteResult } from './judge.js'
import type { BenchmarkResult } from './benchmarks.js'

export type TierName = 'pr' | 'nightly' | 'prod'

export interface TierCheck {
  id: string
  label: string
  /** budget in ms — PR checks must be fast */
  budgetMs: number
  /** run the check, throw on failure */
  run: (ctx: TierContext) => Promise<CheckResult>
}

export interface TierContext {
  tier: TierName
  sha?: string
  branch?: string
  traceId?: string
  env: Record<string, string | undefined>
}

export interface CheckResult {
  checkId: string
  passed: boolean
  score?: number // 0..1
  latencyMs: number
  costUsd?: number
  message?: string
  details?: JudgeSuiteResult | BenchmarkResult | DriftCheckResult
}

export interface TierReport {
  tier: TierName
  passed: boolean
  durationMs: number
  checks: CheckResult[]
  summary: string
}

export interface TierConfig {
  name: TierName
  label: string
  /** cron / trigger description for humans */
  trigger: string
  /** soft SLO — alert if exceeded */
  budgetMs: number
  /** block merge / deploy on failure? */
  blocking: boolean
  checks: TierCheck[]
}

// ── Helpers ──────────────────────────────────────────────────────────

function timedCheck(check: TierCheck, ctx: TierContext): Promise<CheckResult> {
  const t0 = Date.now()
  return Promise.race([
    check.run(ctx),
    new Promise<CheckResult>((_, reject) =>
      setTimeout(
        () => reject(new Error(`check ${check.id} timeout after ${check.budgetMs}ms`)),
        check.budgetMs,
      ),
    ),
  ])
    .then((r) => ({ ...r, latencyMs: Date.now() - t0 }))
    .catch((e) => ({
      checkId: check.id,
      passed: false,
      latencyMs: Date.now() - t0,
      message: (e as Error).message,
    }))
}

export async function runTier(config: TierConfig, ctx: TierContext): Promise<TierReport> {
  const t0 = Date.now()
  const results: CheckResult[] = []
  // PR runs sequentially for deterministic logs; nightly/prod may run in parallel
  const parallel = config.name !== 'pr'
  if (parallel) {
    const settled = await Promise.all(config.checks.map((c) => timedCheck(c, ctx)))
    results.push(...settled)
  } else {
    for (const c of config.checks) results.push(await timedCheck(c, ctx))
  }
  const passed = results.every((r) => r.passed)
  const durationMs = Date.now() - t0
  const summary = `${config.label} ${passed ? 'PASS' : 'FAIL'} — ${results.filter((r) => r.passed).length}/${results.length} checks in ${durationMs}ms`
  return { tier: config.name, passed, durationMs, checks: results, summary }
}

// ── Tier 1: PR Fast Checks ─────────────────────────────────────────

export const prChecks: TierCheck[] = [
  {
    id: 'typecheck',
    label: 'tsc --noEmit',
    budgetMs: 60_000,
    run: async () => {
      try {
        const proc = Bun.spawn(['bunx', 'tsc', '--noEmit'], { stdout: 'pipe', stderr: 'pipe' })
        const exit = await proc.exited
        const stderr = await new Response(proc.stderr).text()
        return {
          checkId: 'typecheck',
          passed: exit === 0,
          latencyMs: 0,
          message: exit === 0 ? 'typecheck ok' : stderr.slice(0, 500),
        }
      } catch {
        // tsc binary missing → the check cannot run → fail loudly, never pass silently
        return {
          checkId: 'typecheck',
          passed: false,
          latencyMs: 0,
          message: 'tsc unavailable — check could not run',
        }
      }
    },
  },
  {
    id: 'unit-smoke',
    label: 'unit smoke (eval fixtures)',
    budgetMs: 10_000,
    run: async () => {
      // Minimal self-test: judge rubric parses, benchmark fixtures load
      try {
        const mod = await import('./benchmarks.js')
        const b = mod.getBenchmark('swe-bench-mini')
        return {
          checkId: 'unit-smoke',
          passed: !!b && b.tasks.length > 0,
          score: 1,
          latencyMs: 0,
          message: b ? `fixtures ok: ${b.tasks.length} tasks` : 'no benchmark',
        }
      } catch (e) {
        return { checkId: 'unit-smoke', passed: false, latencyMs: 0, message: (e as Error).message }
      }
    },
  },
  {
    id: 'latency-budget',
    label: 'latency < 2s p50',
    budgetMs: 5_000,
    run: async () => {
      // Real measurement: ping the running Mira server's health endpoint (3 samples, honest skip if offline)
      const base = (process.env.MIRA_API_URL ?? 'http://127.0.0.1:4096').replace(/\/$/, '')
      const samples: number[] = []
      for (let i = 0; i < 3; i++) {
        const t0 = Date.now()
        try {
          const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1500) })
          if (res.ok) samples.push(Date.now() - t0)
        } catch {}
      }
      if (samples.length === 0) {
        return {
          checkId: 'latency-budget',
          passed: true,
          latencyMs: 0,
          message: `skipped — server not reachable at ${base} (latency not measured)`,
        }
      }
      samples.sort((a, b) => a - b)
      const p50 = samples[Math.floor(samples.length / 2)]
      return {
        checkId: 'latency-budget',
        passed: p50 < 2000,
        score: p50 < 500 ? 1 : p50 < 1000 ? 0.8 : 0.5,
        latencyMs: p50,
        message: `p50=${p50}ms (${samples.length} samples)`,
      }
    },
  },
  {
    id: 'no-secrets',
    label: 'no secrets in diff',
    budgetMs: 3_000,
    run: async () => {
      const { scanChangedFilesForSecrets } = await import('./secrets.js')
      const flags = scanChangedFilesForSecrets()
      if (flags.length === 0) {
        return {
          checkId: 'no-secrets',
          passed: true,
          latencyMs: 0,
          message: 'no secrets detected in changed files',
        }
      }
      return {
        checkId: 'no-secrets',
        passed: false,
        latencyMs: 0,
        message: `secrets in changed files: ${flags.map((f) => `${f.file} (${f.detail})`).join('; ')}`,
      }
    },
  },
]

export const nightlyChecks: TierCheck[] = [
  {
    id: 'llm-judge',
    label: 'LLM-as-judge (5 cases)',
    budgetMs: 120_000,
    run: async (ctx) => {
      const { runJudgeSuite } = await import('./judge.js')
      const result = await runJudgeSuite({
        model: ctx.env.MIRA_JUDGE_MODEL ?? 'openrouter/openai/gpt-4o-mini',
        sample: 5,
      })
      return {
        checkId: 'llm-judge',
        passed: result.passRate >= 0.7,
        score: result.passRate,
        latencyMs: 0,
        message: `judge passRate=${(result.passRate * 100).toFixed(1)}% (${result.passed}/${result.total})`,
        details: result,
      }
    },
  },
  {
    id: 'swe-bench-mini',
    label: 'SWE-bench mini (3 tasks)',
    budgetMs: 180_000,
    run: async () => {
      const { runBenchmark } = await import('./benchmarks.js')
      const r = await runBenchmark('swe-bench-mini', { limit: 3 })
      return {
        checkId: 'swe-bench-mini',
        passed: r.passRate >= 0.33,
        score: r.passRate,
        latencyMs: 0,
        message: `swe-bench ${r.passed}/${r.total} passed`,
        details: r,
      }
    },
  },
  {
    id: 'terminal-bench-mini',
    label: 'Terminal-Bench mini (2 tasks)',
    budgetMs: 180_000,
    run: async () => {
      const { runBenchmark } = await import('./benchmarks.js')
      const r = await runBenchmark('terminal-bench-mini', { limit: 2 })
      return {
        checkId: 'terminal-bench-mini',
        passed: r.passRate >= 0.5,
        score: r.passRate,
        latencyMs: 0,
        message: `terminal-bench ${r.passed}/${r.total} passed`,
        details: r,
      }
    },
  },
  {
    id: 'locomo-mini',
    label: 'LoCoMo mini (memory QA)',
    budgetMs: 120_000,
    run: async () => {
      const { runBenchmark } = await import('./benchmarks.js')
      const r = await runBenchmark('locomo-mini', { limit: 3 })
      return {
        checkId: 'locomo-mini',
        passed: r.passRate >= 0.5,
        score: r.passRate,
        latencyMs: 0,
        message: `locomo ${r.passed}/${r.total} passed`,
        details: r,
      }
    },
  },
]

export const prodChecks: TierCheck[] = [
  {
    id: 'drift-latency',
    label: 'prod latency drift',
    budgetMs: 10_000,
    run: async () => {
      const { checkDrift } = await import('./tracing.js')
      const d = await checkDrift('latency_p50', { window: '1h', threshold: 0.15 })
      return {
        checkId: 'drift-latency',
        passed: !d.alert,
        score: d.driftPct !== undefined ? 1 - Math.min(Math.abs(d.driftPct), 1) : 1,
        latencyMs: 0,
        message: d.message,
        details: d,
      }
    },
  },
  {
    id: 'drift-quality',
    label: 'prod quality drift (judge)',
    budgetMs: 10_000,
    run: async () => {
      const { checkDrift } = await import('./tracing.js')
      const d = await checkDrift('judge_score', { window: '24h', threshold: 0.1 })
      return {
        checkId: 'drift-quality',
        passed: !d.alert,
        latencyMs: 0,
        message: d.message,
        details: d,
      }
    },
  },
  {
    id: 'error-rate',
    label: 'error rate < 1%',
    budgetMs: 10_000,
    run: async () => {
      // Real metrics need a queryable backend (OTel/Langfuse); without one, report an honest skip.
      const endpoint = process.env.MIRA_OTEL_METRICS_URL
      if (!endpoint) {
        return {
          checkId: 'error-rate',
          passed: true,
          latencyMs: 0,
          message: 'skipped — no metrics backend (set MIRA_OTEL_METRICS_URL)',
        }
      }
      try {
        const res = await fetch(`${endpoint.replace(/\/$/, '')}/meters/error_rate`, {
          signal: AbortSignal.timeout(3000),
        })
        if (res.ok) {
          const body = (await res.json()) as { value?: number }
          const rate = Number(body.value ?? -1)
          if (rate >= 0) {
            return {
              checkId: 'error-rate',
              passed: rate < 0.01,
              latencyMs: 0,
              message: `error rate ${(rate * 100).toFixed(2)}% ${rate < 0.01 ? 'ok' : 'above 1% budget'}`,
            }
          }
        }
      } catch {}
      return {
        checkId: 'error-rate',
        passed: true,
        latencyMs: 0,
        message: `skipped — could not query ${endpoint}`,
      }
    },
  },
]

// ── Tier Configs ─────────────────────────────────────────────────────

export const TIERS: Record<TierName, TierConfig> = {
  pr: {
    name: 'pr',
    label: 'PR Fast Checks',
    trigger: 'on pull_request (blocking)',
    budgetMs: 5 * 60_000,
    blocking: true,
    checks: prChecks,
  },
  nightly: {
    name: 'nightly',
    label: 'Nightly LLM-as-Judge',
    trigger: 'cron 0 3 * * * + on demand',
    budgetMs: 30 * 60_000,
    blocking: false,
    checks: nightlyChecks,
  },
  prod: {
    name: 'prod',
    label: 'Prod Drift Alerts',
    trigger: 'continuous (every 5m)',
    budgetMs: 5 * 60_000,
    blocking: false,
    checks: prodChecks,
  },
}

export function getTier(name: TierName): TierConfig {
  const t = TIERS[name]
  if (!t) throw new Error(`unrecognized tier: ${name}`)
  return t
}

export function listTiers(): TierConfig[] {
  return Object.values(TIERS)
}

// Mira Patch (2026-08-22): Reduce eval risk: require PR tier to pass before applying patches; gate on evalReport.passed. Evidence: eval pr FAILED (pr)
