/**
 * Mira Patching — Latency
 *
 * Tracks response latency (p50/p95/p99) and generates optimization hints.
 * Used by Detector (pain point #8) and Patcher (latency patches).
 *
 * Budgets (ms):
 *  - p50 < 2000  (PR SLO)
 *  - p95 < 8000
 *  - p99 < 15000
 */

// ── Types ──────────────────────────────────────────────────────────

export interface LatencySample {
  traceId?: string
  route?: string
  durationMs: number
  timestamp: number
}

export interface LatencyStats {
  count: number
  p50: number
  p95: number
  p99: number
  avg: number
  min: number
  max: number
  windowMs: number
}

export interface LatencyBudget {
  p50: number
  p95: number
  p99: number
}

export const DEFAULT_BUDGET: LatencyBudget = {
  p50: 2000,
  p95: 8000,
  p99: 15000,
}

export interface LatencyCheckResult {
  pass: boolean
  breach?: keyof LatencyBudget
  stats: LatencyStats
  budget: LatencyBudget
  suggestion?: string
}

// ── LatencyTracker ─────────────────────────────────────────────────

export class LatencyTracker {
  private samples: LatencySample[] = []
  private readonly maxSamples = 2000
  private budget: LatencyBudget

  constructor(budget: Partial<LatencyBudget> = {}) {
    this.budget = { ...DEFAULT_BUDGET, ...budget }
  }

  /** Record a single latency sample */
  record(durationMs: number, route?: string, traceId?: string): void {
    this.samples.push({ durationMs, route, traceId, timestamp: Date.now() })
    if (this.samples.length > this.maxSamples) this.samples.shift()
  }

  /** Import bulk historical samples (e.g. from usage sessions) */
  import(samples: LatencySample[]): void {
    for (const s of samples) this.samples.push(s)
    if (this.samples.length > this.maxSamples) {
      this.samples.splice(0, this.samples.length - this.maxSamples)
    }
  }

  /** Snapshot stats over recent window */
  stats(windowMs = 60 * 60 * 1000, route?: string): LatencyStats {
    const now = Date.now()
    let filtered = this.samples
    if (windowMs > 0) filtered = filtered.filter(s => now - s.timestamp <= windowMs)
    if (route) filtered = filtered.filter(s => s.route === route)
    if (filtered.length === 0) {
      return { count: 0, p50: 0, p95: 0, p99: 0, avg: 0, min: 0, max: 0, windowMs }
    }
    const sorted = filtered.map(s => s.durationMs).sort((a, b) => a - b)
    return {
      count: sorted.length,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      avg: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
      min: sorted[0]!,
      max: sorted[sorted.length - 1]!,
      windowMs,
    }
  }

  /** Check against budget — returns breach info */
  check(budget?: Partial<LatencyBudget>, windowMs?: number): LatencyCheckResult {
    const b = { ...this.budget, ...(budget ?? {}) }
    const s = this.stats(windowMs)
    if (s.count === 0) return { pass: true, stats: s, budget: b }
    if (s.p50 > b.p50) return { pass: false, breach: "p50", stats: s, budget: b, suggestion: `p50 ${s.p50}ms > ${b.p50}ms — reduce context, parallelize tool calls, or add caching` }
    if (s.p95 > b.p95) return { pass: false, breach: "p95", stats: s, budget: b, suggestion: `p95 ${s.p95}ms > ${b.p95}ms — tail optimization: streaming, cancel slow tools` }
    if (s.p99 > b.p99) return { pass: false, breach: "p99", stats: s, budget: b, suggestion: `p99 ${s.p99}ms > ${b.p99}ms — add timeout guards` }
    return { pass: true, stats: s, budget: b }
  }

  /** Whether latency warrants a patch */
  needsPatch(windowMs?: number): boolean {
    return !this.check(undefined, windowMs).pass
  }

  /** Generate optimization hints for Patcher */
  suggestions(windowMs?: number): string[] {
    const result = this.check(undefined, windowMs)
    if (result.pass) return []
    const out: string[] = []
    if (result.suggestion) out.push(result.suggestion)
    const s = result.stats
    if (s.p95 > s.p50 * 4) out.push(`High variance (p95/p50 ${(s.p95 / Math.max(1, s.p50)).toFixed(1)}x) — add per-tool timeouts and early abort`)
    if (s.avg > 3000) out.push(`High avg ${s.avg}ms — consider prompt compaction and tool result summarization`)
    return out
  }

  /** Build stats from UsageAnalysis latency fields (convenience) */
  static fromSessions(sessions: Array<{ latencyMs: number; createdAt: number }>): LatencyStats {
    const t = new LatencyTracker()
    for (const s of sessions) t.record(s.latencyMs, undefined, undefined)
    // override timestamps to preserve originals
    t.samples = sessions.map(s => ({ durationMs: s.latencyMs, timestamp: s.createdAt }))
    return t.stats(0)
  }

  clear(): void { this.samples = [] }
  size(): number { return this.samples.length }
  setBudget(b: Partial<LatencyBudget>): void { this.budget = { ...this.budget, ...b } }
  getBudget(): LatencyBudget { return { ...this.budget } }
}

// ── helpers ────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p))
  return sorted[idx] ?? 0
}
