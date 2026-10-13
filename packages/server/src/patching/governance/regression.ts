/**
 * Regression Detection — gate in the promotion lifecycle.
 *
 * Compares baseline vs candidate metrics across 4 axes:
 *   quality  — eval pass/fail + severity regressions
 *   latency  — p50/p95 deltas vs baseline budget
 *   cost     — token/cost delta vs baseline
 *   memory   — memory growth beyond threshold
 *
 * Any regression above tolerance blocks promotion (state → REJECTED with reason).
 */

export interface MetricPoint {
  value: number
  unit: string
}

export interface RegressionInput {
  baseline: Record<string, MetricPoint>
  candidate: Record<string, MetricPoint>
  /** per-axis tolerance as fraction (0.05 = 5% worse allowed). Defaults apply if missing. */
  tolerances?: Partial<Record<RegressionAxis, number>>
}

export type RegressionAxis = 'quality' | 'latency' | 'cost' | 'memory' | 'inverseQuality'

export interface RegressionFinding {
  axis: RegressionAxis
  metric: string
  baseline: number
  candidate: number
  deltaPct: number
  tolerancePct: number
}

export interface RegressionResult {
  passed: boolean
  findings: RegressionFinding[]
}

const DEFAULT_TOLERANCE: Record<RegressionAxis, number> = {
  quality: 0.0, // quality must not regress at all
  latency: 0.05,
  cost: 0.1,
  memory: 0.2,
  // error/failure rates are quality metrics that go DOWN when things improve —
  // so "regressed" means RISING, the opposite direction from successRate.
  inverseQuality: 0.0,
}

/** Classify a metric name into an axis (quality/latency/cost/memory).
 *
 *  Unclassified metrics are NEVER COMPARED, so a metric this misses cannot
 *  regress — it is invisible to the gate. That makes this list a safety
 *  surface, not a convenience: `successRate` — the primary quality metric
 *  used by evaluator.ts, shadow/comparison.ts and the longitudinal baseline —
 *  was previously unclassified, so a candidate halving its success rate
 *  passed regression detection cleanly. Explicit names are checked first
 *  (so `errorRate` reads as quality, not as some unhandled axis), then
 *  substring patterns.
 */
export function classifyAxis(metric: string): RegressionAxis | null {
  const m = metric.toLowerCase()
  // A bare sample/observation count is evidence *about* the measurement, not a
  // quantity that can regress — it must never be compared on the memory axis
  // (the previous `/count$/` rule did exactly that, so a canary's sample count
  // would have been scored as if it were heap growth).
  if (m === 'count' || m === 'samples') return null

  // Explicit quality names first: these must not fall through to latency
  // (e.g. `successRateMs`) or to memory (`errorRateEntries`).
  if (/^(success|successrate|success_rate|accuracy|tasksuccess|passrate|pass_rate)/.test(m))
    return 'quality'
  if (/^(error|errorrate|error_rate|fail|failure|failrate|failure_rate)/.test(m)) {
    return 'inverseQuality'
  }
  if (/^(regressionrate|regression_rate|securityviolations|violations)/.test(m))
    return 'inverseQuality'
  if (/^(quality|eval|score|completion|taskcompletion|completionrate|winrate|win_rate)/.test(m)) {
    return 'quality'
  }

  // Explicit latency/cost/memory anchors before generic substrings.
  if (/^(latency|duration|p50|p95|p99|ttft|tpot)/.test(m)) return 'latency'
  if (/^(cost|price|tokens|tokensin|tokensout)/.test(m)) return 'cost'
  if (/^(memory|heap|rss|entries)/.test(m)) return 'memory'

  // Generic substrings for compound names (e.g. `avg_latency_ms`).
  if (/quality|pass|eval|score|success|accuracy|completing|resolution|error/.test(m))
    return 'quality'
  if (/latency|p50|p95|p99|duration|ms$/.test(m)) return 'latency'
  if (/cost|token|price/.test(m)) return 'cost'
  if (/memory|heap|rss|entries/.test(m)) return 'memory'
  return null
}

/** Direction per axis: higher-is-better (quality), lower-is-better
 *  (latency/cost/memory), and lower-is-better for inverseQuality (error and
 *  failure RATE, which improve by falling). */
function regressed(
  axis: RegressionAxis,
  baseline: number,
  candidate: number,
  tolerance: number,
): { bad: boolean; deltaPct: number } {
  if (baseline === 0) return { bad: false, deltaPct: 0 }
  const deltaPct = (candidate - baseline) / baseline
  const bad =
    axis === 'quality'
      ? deltaPct < -tolerance // quality fell
      : deltaPct > tolerance // latency/cost/memory rose, or error rate rose
  return { bad, deltaPct }
}

export class RegressionDetector {
  /** Compare metrics; any axis exceeding tolerance → finding (blocks promotion). */
  detect(input: RegressionInput): RegressionResult {
    const tolerances = { ...DEFAULT_TOLERANCE, ...(input.tolerances ?? {}) }
    const findings: RegressionFinding[] = []
    for (const [metric, cand] of Object.entries(input.candidate)) {
      const base = input.baseline[metric]
      if (!base) continue
      const axis = classifyAxis(metric)
      if (!axis) continue
      const tol = tolerances[axis]
      const { bad, deltaPct } = regressed(axis, base.value, cand.value, tol)
      if (bad) {
        findings.push({
          axis,
          metric,
          baseline: base.value,
          candidate: cand.value,
          deltaPct,
          tolerancePct: tol,
        })
      }
    }
    return { passed: findings.length === 0, findings }
  }
}
