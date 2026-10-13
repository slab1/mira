import type { CanaryResult, CanaryConfig } from './types.js'
import type { LatencyTracker } from '../latency.js'
import { getVariantRouter, type VariantRouter } from './traffic.js'
import type { VariantWorkspace } from './variant.js'
import type { Patch } from '../patcher.js'
import type { VerifyResult } from '../verifier.js'

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
export interface CanaryDeps {
  latency?: LatencyTracker
  router?: VariantRouter
  /**
   * Materializes the candidate so it can actually receive traffic. Without one
   * the canary has nothing to observe and blocks — the honest outcome.
   */
  workspace?: VariantWorkspace
  /** Injected for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>
}

export class CanaryRunner {
  private readonly router?: VariantRouter
  private readonly workspace?: VariantWorkspace
  private readonly sleep: (ms: number) => Promise<void>

  constructor(
    private latency?: LatencyTracker,
    deps: CanaryDeps = {},
  ) {
    this.router = deps.router
    this.workspace = deps.workspace
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  /**
   * Materialize the candidate and register it for routing.
   *
   * Returns false when no variant could be produced, in which case traffic
   * stays on baseline and the canary blocks on insufficient candidate traffic.
   * The repository working tree is never modified.
   */
  async prepare(
    proposalId: string,
    patch: Patch,
    config: Pick<CanaryConfig, 'trafficPct'>,
    verifyResult?: VerifyResult,
  ): Promise<boolean> {
    if (!this.workspace) return false
    const { candidate, reason } = await this.workspace.materialize(proposalId, patch, verifyResult)
    if (!candidate) {
      console.warn(`[governance] no candidate variant for ${proposalId}: ${reason}`)
      return false
    }
    const router = this.router ?? getVariantRouter()
    router.register({
      proposalId,
      trafficPct: config.trafficPct,
      resolveVariant: (id) => (this.workspace?.get(id) ? candidate.dir : null),
    })
    return true
  }

  /** Remove the candidate tree and stop routing to it. */
  async teardown(proposalId: string): Promise<void> {
    ;(this.router ?? getVariantRouter()).unregister(proposalId)
    this.workspace?.dispose(proposalId)
  }

  /**
   * Register real traffic routing for this proposal before observing it.
   *
   * `resolveVariant` returns the executable variant (or null when none is
   * registered). Returns false when no variant exists — the canary will then
   * observe zero candidate traffic and BLOCK, which is the truthful outcome
   * rather than measuring baseline traffic and calling it the candidate.
   */
  route(
    proposalId: string,
    config: Pick<CanaryConfig, 'trafficPct'> & { resolveVariant?: (id: string) => string | null },
  ): boolean {
    const router = this.router ?? getVariantRouter()
    router.register({
      proposalId,
      trafficPct: config.trafficPct,
      ...(config.resolveVariant ? { resolveVariant: config.resolveVariant } : {}),
    })
    return router.get(proposalId) !== undefined
  }

  /** Stop routing traffic to the candidate (after observe, promote or rollback). */
  unroute(proposalId: string): void {
    ;(this.router ?? getVariantRouter()).unregister(proposalId)
  }

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

    // Candidate-specific evidence: only samples attributed to THIS candidate.
    // If nothing is routed yet, start routing before observing — the lifecycle
    // has to actually send traffic to the candidate, not merely hope some
    // arrives.
    const router = this.router ?? getVariantRouter()
    let stats = this.latency.stats(durationMs, route)
    let count = Number(stats.count ?? 0)
    if (count < minSamples && !router.get(proposalId) && config?.variant) {
      router.register({ proposalId, trafficPct, resolveVariant: () => config.variant! })
      stats = this.latency.stats(durationMs, route)
      count = Number(stats.count ?? 0)
    }

    // No variant is reachable, so no request can be routed to the candidate.
    // Observing for the full window would just burn the wall-clock to reach a
    // conclusion we already know — block now, and say why.
    const reachable =
      router.get(proposalId)?.resolveVariant?.(proposalId) ?? config?.variant ?? null
    if (!reachable && count < minSamples) {
      return blocked(
        `no candidate variant is registered to route traffic to (proposal '${proposalId}'); nothing can be observed`,
      )
    }

    // Observe for the configured duration. Previously a single instantaneous
    // read stood in for `durationMs`, so a canary could pass on one lucky
    // request instead of sustained observation.
    const deadline = Date.now() + durationMs
    while (Date.now() < deadline) {
      await this.sleep(Math.min(250, deadline - Date.now()))
      stats = this.latency.stats(durationMs, route)
      count = Number(stats.count ?? 0)
      if (!Number.isFinite(count)) break
    }

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
