/**
 * Mira metrics collector — bounded cardinality + real histograms.
 *
 * The audit flagged two problems in the old inline collector (src/index.ts):
 *  1. Unbounded cardinality: the map keyed by `METHOD route status` only "bounded"
 *     itself by silently DROPPING new labels once over cap — so a flood of distinct
 *     labels froze the counter (silent data loss) and stale labels were never evicted.
 *  2. The exported "histogram" was degenerate: every bucket emitted the same raw
 *     count, so /metrics exposed no latency distribution at all.
 *
 * This module fixes both without adding infra (single-node, in-memory by design):
 *  - Real LRU eviction: the counter map is hard-capped at `maxLabels`; when full we
 *    evict the least-recently-seen label and record the newcomer — so memory stays
 *    bounded AND active routes are never silently dropped.
 *  - Real per-route histogram: latency is bucketed per `METHOD route` across a fixed
 *    set of duration buckets, so the rendered histogram reflects the actual
 *    distribution instead of a fake flat line.
 *
 * Path labels are expected to be pre-collapsed (IDs -> ":id") before calling record().
 */

export const METRICS_MAX_LABELS = 1000
/** Seconds; `+Inf` is implicit (bucket index length is BUCKETS.length + 1). */
export const DURATION_BUCKETS_SECONDS = [0.05, 0.1, 0.5, 1, 5] as const

/** Pick the bucket index (last = +Inf) for a duration in seconds. */
export function bucketIndex(durationSec: number): number {
  for (let i = 0; i < DURATION_BUCKETS_SECONDS.length; i++) {
    if (durationSec <= DURATION_BUCKETS_SECONDS[i]) return i
  }
  return DURATION_BUCKETS_SECONDS.length
}

export class MetricsCollector {
  /** key: "METHOD route status" -> count (bounded, LRU-evicted). */
  readonly httpRequestsTotal = new Map<string, number>()
  /** key: "METHOD route" -> bucket counts; length = BUCKETS.length + 1 (last = +Inf). */
  readonly durationsByRoute = new Map<string, number[]>()
  /** key: "METHOD route" -> cumulative seconds (parallel to durationsByRoute for sum). */
  readonly durationSumByRoute = new Map<string, number>()
  httpRequestDurationSecondsSum = 0
  httpRequestDurationSecondsCount = 0
  activeSessions = 0
  private readonly maxLabels: number

  constructor(maxLabels = METRICS_MAX_LABELS) {
    this.maxLabels = maxLabels
  }

  /**
   * Bump a counter map with a hard cap and LRU-ish eviction. Touched keys are moved
   * to the end (delete+set), so when the map is full we evict the least-recently-seen
   * key and always record the newcomer — never silent data loss, never unbounded growth.
   */
  private bump(map: Map<string, number | number[]>, key: string, value: number | number[]): void {
    const had = map.has(key)
    if (!had && map.size >= this.maxLabels) {
      // Maps iterate in insertion order; head = least-recently touched.
      map.delete(map.keys().next().value as string)
    }
    if (had) map.delete(key)
    map.set(key, value)
  }

  /** Record one completed HTTP request. `route` must be path-collapsed already. */
  record(method: string, route: string, status: number, durationSec: number): void {
    // Request counter: "METHOD route status". Refresh recency + increment.
    const counterKey = `${method} ${route} ${status}`
    const prevCount = this.httpRequestsTotal.get(counterKey) ?? 0
    this.bump(this.httpRequestsTotal, counterKey, prevCount + 1)

    // Real histogram: per-route bucket counts + sum. We keep durationsByRoute and
    // durationSumByRoute in strict sync — eviction removes the same key from both.
    // Refresh recency on every hit (delete+set moves to end of insertion order).
    const durKey = `${method} ${route}`
    const existingBuckets = this.durationsByRoute.get(durKey)
    const idx = bucketIndex(durationSec)
    const prevSum = this.durationSumByRoute.get(durKey) ?? 0
    if (existingBuckets) {
      // Existing key — just refresh + increment (no eviction needed).
      const next = existingBuckets.slice()
      next[idx] = (next[idx] ?? 0) + 1
      this.durationsByRoute.delete(durKey)
      this.durationSumByRoute.delete(durKey)
      this.durationsByRoute.set(durKey, next)
      this.durationSumByRoute.set(durKey, prevSum + durationSec)
    } else {
      // New key — may need to evict the least-recent from both maps together.
      if (this.durationsByRoute.size >= this.maxLabels) {
        const evictKey = this.durationsByRoute.keys().next().value as string
        this.durationsByRoute.delete(evictKey)
        this.durationSumByRoute.delete(evictKey)
      }
      const fresh = new Array(DURATION_BUCKETS_SECONDS.length + 1).fill(0)
      fresh[idx] = 1
      this.durationsByRoute.set(durKey, fresh)
      this.durationSumByRoute.set(durKey, durationSec)
    }

    // Global aggregations (kept for compatibility + totals).
    this.httpRequestDurationSecondsSum += durationSec
    this.httpRequestDurationSecondsCount += 1
  }
}
