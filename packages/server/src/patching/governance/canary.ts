import type { CanaryResult, CanaryConfig } from './types.js'
import type { LatencyTracker } from '../latency.js'

const DEFAULT_MIN_SAMPLES = 1

/**
 * Canary gate — fail closed.
 *
 * Previously this returned `passed: true` when no tracker was injected, and
 * otherwise compared PROCESS-WIDE latency telemetry against the SLO. Three
 * separate holes:
 *   1. no tracker        → `passed: true` ("canary skipped")
 *   2. no SLO configured → every comparison short-circuited to true
 *   3. no sample floor   → an empty measurement window looked identical to a
 *                          healthy one, and the configured durationMs was only
 *                          echoed into metrics, never actually observed
 *
 * It also measured whatever traffic happened to exist, which is not evidence
 * that THIS candidate worked. Evidence is now scoped to the candidate's route
 * over the configured window.
 */
export class CanaryRunner {
  constructor(private latency?: LatencyTracker) {}

  async start(proposalId: string, config?: CanaryConfig): Promise<CanaryResult> {
    const trafficPct = config?.trafficPct ?? 5
    const durationMs = config?.durationMs ?? 300_000
    const slo = config?.slo
    const minSamples = config?.minSamples ?? DEFAULT_MIN_SAMPLES
    const route = config?.route ?? proposalId

    // Policy echo — kept out of `metrics` so `deriveMetrics` can never read a
    // configured threshold as if it were an observation.
    const policy = { trafficPct, durationMs, minSamples, route }

    const blocked = (reason: string): CanaryResult => ({
      passed: false,
      outcome: 'BLOCKED',
      reason: `canary blocked — ${reason}`,
      policy,
    })

    if (!this.latency) {
      return blocked('no latency tracker injected; cannot measure the candidate')
    }

    // Config validation — an unusable config must not authorize promotion.
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      return blocked(`durationMs must be a positive number (got ${String(durationMs)})`)
    }
    if (!Number.isFinite(trafficPct) || trafficPct <= 0 || trafficPct > 100) {
      return blocked(`trafficPct must be within (0,100] (got ${String(trafficPct)})`)
    }
    if (!Number.isFinite(minSamples) || minSamples < 1) {
      return blocked(`minSamples must be >= 1 (got ${String(minSamples)})`)
    }
    // Without at least one threshold there is nothing to judge against, and
    // the old `!slo?.p50Ms || ...` form silently passed everything.
    const thresholds = [slo?.p50Ms, slo?.p95Ms, slo?.errorRate].filter(
      (v): v is number => typeof v === 'number' && Number.isFinite(v),
    )
    if (thresholds.length === 0) {
      return blocked(
        'no SLO thresholds configured; a canary cannot pass without limits to compare against',
      )
    }

    // Candidate-specific evidence: only samples attributed to THIS candidate,
    // inside the configured observation window.
    const stats = this.latency.stats(durationMs, route)
    const count = Number(stats.count ?? 0)

    if (!Number.isFinite(count) || count < minSamples) {
      return {
        passed: false,
        outcome: 'BLOCKED',
        reason: `canary blocked — insufficient candidate traffic: observed ${Number.isFinite(count) ? count : 'non-finite'} sample(s) on route '${route}', need >= ${minSamples}`,
        metrics: { count: Number.isFinite(count) ? count : 0 },
        policy,
      }
    }

    const p50 = Number(stats.p50 ?? 0)
    const p95 = Number(stats.p95 ?? 0)
    const errorRate = Number(stats.errorRate ?? 0)

    for (const [name, value] of Object.entries({ p50, p95, errorRate })) {
      if (!Number.isFinite(value) || value < 0) {
        return blocked(`measured ${name} is not a usable value (${String(value)})`)
      }
    }

    const metrics = { count, p50, p95, errorRate }
    const violations: string[] = []
    if (typeof slo?.p50Ms === 'number' && p50 > slo.p50Ms) {
      violations.push(`p50=${p50}ms exceeds limit ${slo.p50Ms}ms`)
    }
    if (typeof slo?.p95Ms === 'number' && p95 > slo.p95Ms) {
      violations.push(`p95=${p95}ms exceeds limit ${slo.p95Ms}ms`)
    }
    if (typeof slo?.errorRate === 'number' && errorRate > slo.errorRate) {
      violations.push(
        `errors=${(errorRate * 100).toFixed(1)}% exceeds limit ${(slo.errorRate * 100).toFixed(1)}%`,
      )
    }

    if (violations.length > 0) {
      return {
        passed: false,
        outcome: 'FAILED',
        reason: `canary failed — ${violations.join(', ')}`,
        metrics,
        policy,
      }
    }

    return {
      passed: true,
      outcome: 'PASSED',
      reason: `canary passed — ${count} sample(s) on '${route}': p50=${p50}ms p95=${p95}ms errors=${(errorRate * 100).toFixed(1)}% traffic=${trafficPct}%`,
      metrics,
      policy,
    }
  }
}
