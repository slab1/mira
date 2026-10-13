/**
 * Governance — benchmark measurement source.
 *
 * `BenchmarkRunner` compares a baseline snapshot against a candidate snapshot,
 * but nothing in the pipeline ever produced those snapshots: `advance()` called
 * `benchmark.run()` with no arguments at all.
 *
 * This module is that missing half, and it is deliberately explicit about the
 * one thing that cannot be faked. Measuring a candidate means running the
 * candidate. Until an executable variant exists (a patch applied to a separate
 * worktree that can actually serve traffic), there is no candidate to measure,
 * and the only honest answer is "no candidate measurement is available".
 *
 * Deliberately NOT implemented here: synthesising a candidate snapshot from
 * production telemetry. That is what `shadow/benchmark.ts` currently does
 * (`candidate = { ...production }` plus one overlay), and feeding it here would
 * turn "the candidate was never run" into a benchmark that passes by comparing
 * production against itself — the exact failure §3 exists to prevent.
 */

import type { MetricSnapshot, PatchProposal } from './types.js'
import type { LatencyTracker } from '../latency.js'

export interface MeasurementPair {
  before: MetricSnapshot
  after: MetricSnapshot
}

export interface MeasurementSource {
  measure(proposal: PatchProposal): Promise<MeasurementPair | null>
}

/** Attribution key for baseline-observed traffic. */
export const BASELINE_KEY = 'baseline'

export interface TrackerMeasurementOptions {
  tracker: LatencyTracker
  /** Window over which baseline traffic is summarised. */
  baselineWindowMs?: number
  /** p50/p95 must exceed this floor to count as a real measurement. */
  minBaselineSamples?: number
}

/** Default minimum baseline samples for measurement, configurable via MIRA_MIN_BASELINE_SAMPLES. */
const DEFAULT_MIN_BASELINE_SAMPLES = Number(process.env.MIRA_MIN_BASELINE_SAMPLES ?? 1)

/**
 * Measures whatever real traffic exists, split by attribution key.
 *
 * Returns a pair ONLY when both sides were genuinely observed. When the
 * candidate side has no samples, it returns null — the caller's benchmark
 * stage then BLOCKs with "no candidate measurement", which is accurate.
 *
 * This is real routing-derived evidence (see traffic.ts / attribution.ts), so
 * once a proposal has an executable variant and has served routed traffic, the
 * benchmark compares two real observations rather than assuming an improvement.
 */
export class TrackerMeasurementSource implements MeasurementSource {
  constructor(private opts: TrackerMeasurementOptions) {}

  async measure(proposal: PatchProposal): Promise<MeasurementPair | null> {
    const windowMs = this.opts.baselineWindowMs ?? 300_000
    const minSamples = this.opts.minBaselineSamples ?? DEFAULT_MIN_BASELINE_SAMPLES

    const baseline = this.opts.tracker.stats(windowMs, BASELINE_KEY)
    const candidate = this.opts.tracker.stats(windowMs, proposal.id)

    if (Number(baseline.count) < minSamples || Number(candidate.count) < minSamples) return null

    // p50/p95 are the axes BenchmarkRunner validates; only pass through what was
    // actually measured rather than filling gaps with zeros.
    const before: MetricSnapshot = { p50: Number(baseline.p50), p95: Number(baseline.p95) }
    const after: MetricSnapshot = { p50: Number(candidate.p50), p95: Number(candidate.p95) }
    return { before, after }
  }
}

/**
 * Production source used until a variant execution environment exists.
 *
 * Always returns null, so the benchmark stage blocks with an explanation a
 * human can act on. This is a deliberate, visible gap — not a stub that
 * silently reports success.
 */
export class UnavailableMeasurementSource implements MeasurementSource {
  async measure(): Promise<MeasurementPair | null> {
    return null
  }
}
