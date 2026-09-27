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

export type RegressionAxis = 'quality' | 'latency' | 'cost' | 'memory'

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
}

/** Classify a metric name into an axis (quality/latency/cost/memory). */
export function classifyAxis(metric: string): RegressionAxis | null {
  const m = metric.toLowerCase()
  if (/quality|pass|eval|score/.test(m)) return 'quality'
  if (/latency|p50|p95|p99|duration|ms$/.test(m)) return 'latency'
  if (/cost|token|price/.test(m)) return 'cost'
  if (/memory|heap|rss|entries|count$/.test(m)) return 'memory'
  return null
}

/** Lower-is-better for latency/cost/memory; higher-is-better for quality. */
function regressed(axis: RegressionAxis, baseline: number, candidate: number, tolerance: number): { bad: boolean; deltaPct: number } {
  if (baseline === 0) return { bad: false, deltaPct: 0 }
  const deltaPct = (candidate - baseline) / baseline
  const bad = axis === 'quality' ? deltaPct < -tolerance : deltaPct > tolerance
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
