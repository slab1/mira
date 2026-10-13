import type { LatencyTracker } from '../latency.js'
import type { BenchmarkResult, MetricSnapshot } from './types.js'
import { RegressionDetector } from './regression.js'

/**
 * Metrics a benchmark must measure on BOTH sides before a regression verdict
 * is meaningful. These are the gates — anything absent, non-finite, negative,
 * or a non-credible 0ms baseline blocks rather than being coerced to 0.
 */
const REQUIRED_METRICS = ['p50', 'p95'] as const

type Verdict = { ok: true } | { ok: false; reason: string }

/**
 * Validate one side of the comparison. Never substitutes a default for a
 * missing measurement: a metric that was not measured is not a metric that
 * measured zero, and `regressed()` treats a 0 baseline as "cannot regress",
 * so coercing missing → 0 would turn absent evidence into a PASS.
 */
function validateSide(label: string, stats: MetricSnapshot): Verdict {
  for (const metric of REQUIRED_METRICS) {
    const raw = stats[metric]
    if (raw === undefined || raw === null) {
      return { ok: false, reason: `${label} is missing required metric '${metric}'` }
    }
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return {
        ok: false,
        reason: `${label} metric '${metric}' is not a finite number (got ${String(raw)})`,
      }
    }
    if (raw < 0) {
      return { ok: false, reason: `${label} metric '${metric}' is negative (${raw})` }
    }
    if (raw === 0) {
      // A 0ms p50/p95 is not a credible measurement, and the regression math
      // divides by the baseline — it would report "no regression" forever.
      return {
        ok: false,
        reason: `${label} metric '${metric}' is 0 — implausible baseline, refusing to compare`,
      }
    }
  }
  return { ok: true }
}

export class BenchmarkRunner {
  private regression = new RegressionDetector()

  constructor(private latency?: LatencyTracker) {}

  async run(beforeStats?: MetricSnapshot, afterStats?: MetricSnapshot): Promise<BenchmarkResult> {
    // Fail closed. Previously this returned `passed: true` with the reason
    // "benchmark skipped", which advanced the proposal to BENCHMARK_PASSED
    // on zero evidence. Missing evidence must block, never authorize.
    if (!this.latency) {
      return {
        passed: false,
        outcome: 'BLOCKED',
        reason: 'benchmark blocked — no latency tracker injected; cannot measure',
        before: beforeStats,
        after: afterStats,
        delta: {},
      }
    }
    if (!beforeStats || !afterStats) {
      return {
        passed: false,
        outcome: 'BLOCKED',
        reason: 'benchmark blocked — baseline and candidate measurements are required',
        before: beforeStats,
        after: afterStats,
        delta: {},
      }
    }

    const beforeCheck = validateSide('baseline', beforeStats)
    if (!beforeCheck.ok) {
      return {
        passed: false,
        outcome: 'BLOCKED',
        reason: `benchmark blocked — ${beforeCheck.reason}`,
        before: beforeStats,
        after: afterStats,
        delta: {},
      }
    }
    const afterCheck = validateSide('candidate', afterStats)
    if (!afterCheck.ok) {
      return {
        passed: false,
        outcome: 'BLOCKED',
        reason: `benchmark blocked — ${afterCheck.reason}`,
        before: beforeStats,
        after: afterStats,
        delta: {},
      }
    }

    const baseline: Record<string, { value: number; unit: string }> = {}
    const candidate: Record<string, { value: number; unit: string }> = {}
    for (const metric of REQUIRED_METRICS) {
      baseline[metric] = { value: beforeStats[metric], unit: 'ms' }
      candidate[metric] = { value: afterStats[metric], unit: 'ms' }
    }

    const result = this.regression.detect({ baseline, candidate })

    const delta: Record<string, number> = {}
    for (const key of Object.keys(baseline)) {
      const b = baseline[key].value
      const c = candidate[key].value
      delta[key] = ((c - b) / b) * 100
    }

    return {
      passed: result.passed,
      outcome: result.passed ? 'PASSED' : 'FAILED',
      reason: result.passed
        ? `benchmark passed — p50 ${delta.p50?.toFixed(1)}%, p95 ${delta.p95?.toFixed(1)}%`
        : // deltaPct is a fraction (0.15 == 15% worse) — scale it, matching
          // GovernanceGate.promote()'s regression reason.
          `benchmark failed — ${result.findings.map((f) => `${f.metric} +${(f.deltaPct * 100).toFixed(1)}%`).join(', ')}`,
      before: beforeStats,
      after: afterStats,
      delta,
    }
  }
}
