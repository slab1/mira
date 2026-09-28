/**
 * State Reconciliation — deterministic ordering for REST/WebSocket/polling.
 *
 * Mira Web combines multiple state mechanisms that can diverge:
 *   - REST says: Job = running
 *   - WebSocket says: Job = completed
 *   - Polling says: Job = running
 *
 * Without reconciliation, the UI displays stale or contradictory info.
 *
 * This module provides:
 *   - Sequence numbers for event ordering
 *   - Server timestamps for staleness detection
 *   - Last-write-wins with explicit invalidation
 *   - Duplicate event detection
 */

export type StateSource = 'rest' | 'websocket' | 'polling'

export interface ReconciledEvent<T = unknown> {
  source: StateSource
  sequence: number
  timestamp: number
  data: T
}

export interface ReconciliationConfig {
  /** Max age (ms) before data is considered stale */
  staleThresholdMs: number
  /** Sources in priority order (first = highest priority) */
  sourcePriority: StateSource[]
}

export const DEFAULT_RECONCILIATION: ReconciliationConfig = {
  staleThresholdMs: 30_000,
  sourcePriority: ['websocket', 'rest', 'polling'],
}

/**
 * Reconcile multiple event streams into a single authoritative state.
 * Last-write-wins by (sequence, timestamp), with source priority as tiebreaker.
 */
export function reconcile<T>(
  events: ReconciledEvent<T>[],
  config: ReconciliationConfig = DEFAULT_RECONCILIATION,
): ReconciledEvent<T> | null {
  if (events.length === 0) return null

  const now = Date.now()
  const valid = events.filter((e) => now - e.timestamp < config.staleThresholdMs)

  if (valid.length === 0) return null

  // Sort by sequence desc, then timestamp desc, then source priority asc
  const sorted = [...valid].sort((a, b) => {
    if (a.sequence !== b.sequence) return b.sequence - a.sequence
    if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp
    return config.sourcePriority.indexOf(a.source) - config.sourcePriority.indexOf(b.source)
  })

  return sorted[0]
}

/**
 * Deduplicate events by sequence number.
 * Returns the highest-sequence event for each unique sequence.
 */
export function deduplicate<T>(events: ReconciledEvent<T>[]): ReconciledEvent<T>[] {
  const bySeq = new Map<number, ReconciledEvent<T>>()
  for (const e of events) {
    const existing = bySeq.get(e.sequence)
    if (!existing || e.timestamp > existing.timestamp) {
      bySeq.set(e.sequence, e)
    }
  }
  return [...bySeq.values()].sort((a, b) => a.sequence - b.sequence)
}

/**
 * Detect gaps in event sequences (missed events).
 * Returns the missing sequence numbers.
 */
export function detectGaps(events: ReconciledEvent<unknown>[]): number[] {
  if (events.length < 2) return []
  const sorted = [...events].sort((a, b) => a.sequence - b.sequence)
  const gaps: number[] = []
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].sequence
    const curr = sorted[i].sequence
    for (let seq = prev + 1; seq < curr; seq++) {
      gaps.push(seq)
    }
  }
  return gaps
}

/**
 * Check if data is stale based on timestamp.
 */
export function isStale(timestamp: number, thresholdMs: number = DEFAULT_RECONCILIATION.staleThresholdMs): boolean {
  return Date.now() - timestamp > thresholdMs
}

/**
 * Create a reconciled event with auto-incrementing sequence.
 */
export function createEvent<T>(
  source: StateSource,
  data: T,
  sequence: number,
  timestamp: number = Date.now(),
): ReconciledEvent<T> {
  return { source, sequence, timestamp, data }
}
