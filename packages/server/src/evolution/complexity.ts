/**
 * Evolution Complexity Tracker — complexity as an engineering metric (§20)
 *
 * Docs: MIRA_WEAKNESSES_AND_OBSTACLES.md §20 (Complexity Is Itself a Risk, P0):
 *   "Mira is capable of doing many things, but nobody can confidently explain
 *   how the entire system behaves" is an architectural failure mode.
 *
 * Tracked per §20:
 *   number of engines / dependencies / autonomous actions / state transitions /
 *   agents / tools / permissions / failure paths
 *
 * Design: metrics come from injected provider callbacks (counters over live
 * systems) — the tracker itself is pure, keeps a bounded in-memory time series,
 * and derives a weighted complexity score with risk bands so complexity growth
 * is visible and comparable over time (Before vs Candidate vs After, §16).
 *
 * Documentation Maintenance — 10 items:
 * | # | Item | Status | Evidence |
 * |---|------|--------|----------|
 * | 1 | Implementation path | Implemented | packages/server/src/evolution/complexity.ts |
 * | 2 | Public interfaces | Implemented | ComplexityTracker.registerProvider(name, fn); snapshot(); trend(); history(limit); reset() |
 * | 3 | Events | Implemented | caller emits evolution.complexity via Bus (module is pure) |
 * | 4 | Configuration | Implemented | MIRA_COMPLEXITY_WARN (default 100), MIRA_COMPLEXITY_RISK (default 200) score bands |
 * | 5 | Tests | Implemented | packages/server/src/evolution/complexity.test.ts (providers, score bands, trend, history cap) |
 * | 6 | Security boundaries | Implemented | §20: read-only counters; provider failures yield 0 with a flagged error, never throw into callers |
 * | 7 | Operational procedures | Implemented | GET /evolution/complexity (wired with ledger/loop-guard providers; engine/tool providers via deps) |
 * | 8 | Migration strategy | Implemented | additive, pure module; missing providers simply report 0 |
 * | 9 | Rollback strategy | Implemented | delete module + route; no persisted state |
 * | 10 | Known limitations | Implemented | in-memory history (restarts reset); weights are heuristic; per-module failure-path counting is Target |
 */

export interface ComplexityMetrics {
  engines: number
  tools: number
  dependencies: number
  agents: number
  permissions: number
  autonomousActions: number
  stateTransitions: number
  failurePaths: number
}

export interface ComplexitySnapshot {
  metrics: ComplexityMetrics
  /** Weighted score — higher means harder to reason about the whole system. */
  score: number
  risk: 'low' | 'warn' | 'high'
  providerErrors: string[]
  timestamp: number
}

export interface ComplexityTrend {
  window: { from: number; to: number; samples: number }
  scoreDelta: number
  metricsDelta: Partial<Record<keyof ComplexityMetrics, number>>
}

type Provider = () => number

const WEIGHTS: Record<keyof ComplexityMetrics, number> = {
  engines: 1,
  tools: 0.5,
  dependencies: 0.2,
  agents: 1,
  permissions: 1,
  autonomousActions: 0.05,
  stateTransitions: 0.1,
  failurePaths: 0.5,
}

const METRIC_KEYS = Object.keys(WEIGHTS) as Array<keyof ComplexityMetrics>

function envNum(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

export class ComplexityTracker {
  private providers = new Map<keyof ComplexityMetrics, Provider>()
  private history_: ComplexitySnapshot[] = []
  private readonly maxHistory: number
  private readonly warnScore: number
  private readonly riskScore: number

  constructor(opts: { maxHistory?: number; warnScore?: number; riskScore?: number } = {}) {
    this.maxHistory = opts.maxHistory ?? 200
    this.warnScore = opts.warnScore ?? envNum('MIRA_COMPLEXITY_WARN', 100)
    this.riskScore = opts.riskScore ?? envNum('MIRA_COMPLEXITY_RISK', 200)
  }

  registerProvider(metric: keyof ComplexityMetrics, provider: Provider): void {
    this.providers.set(metric, provider)
  }

  snapshot(now = Date.now()): ComplexitySnapshot {
    const metrics = {} as ComplexityMetrics
    const providerErrors: string[] = []
    for (const key of METRIC_KEYS) {
      const provider = this.providers.get(key)
      if (!provider) {
        metrics[key] = 0
        continue
      }
      try {
        const v = provider()
        metrics[key] = typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
      } catch (e) {
        metrics[key] = 0
        providerErrors.push(`${key}: ${String(e).slice(0, 100)}`)
      }
    }
    let score = 0
    for (const key of METRIC_KEYS) score += metrics[key] * WEIGHTS[key]
    const risk = score >= this.riskScore ? 'high' : score >= this.warnScore ? 'warn' : 'low'

    const snap: ComplexitySnapshot = {
      metrics,
      score: Math.round(score * 100) / 100,
      risk,
      providerErrors,
      timestamp: now,
    }
    this.history_.push(snap)
    if (this.history_.length > this.maxHistory) this.history_.shift()
    return snap
  }

  /** Delta between the oldest and newest snapshots in the retained window. */
  trend(): ComplexityTrend | null {
    if (this.history_.length < 2) return null
    const oldest = this.history_[0]
    const newest = this.history_[this.history_.length - 1]
    const metricsDelta: Partial<Record<keyof ComplexityMetrics, number>> = {}
    for (const key of METRIC_KEYS) {
      const d = newest.metrics[key] - oldest.metrics[key]
      if (d !== 0) metricsDelta[key] = d
    }
    return {
      window: { from: oldest.timestamp, to: newest.timestamp, samples: this.history_.length },
      scoreDelta: Math.round((newest.score - oldest.score) * 100) / 100,
      metricsDelta,
    }
  }

  history(limit = 20): ComplexitySnapshot[] {
    return this.history_.slice(-limit).reverse()
  }

  reset(): void {
    this.history_ = []
  }
}
