/**
 * Memory Eviction Engine — Phase 4 of Mira Improvement Plan.
 *
 * Scans for stale memories and evicts (deletes) those below a confidence
 * threshold or past a maximum age. Uses `effectiveConfidence` from
 * provenance.ts to determine staleness.
 *
 * Design:
 *   - Eviction is opt-in via `MIRA_EVICT_ON_STARTUP=1` or manual call.
 *   - Dry-run mode reports what would be evicted without deleting.
 *   - Thresholds are configurable via options.
 *   - Eviction runs in a transaction for atomicity.
 */
import { effectiveConfidence, STALE_AFTER_MS } from './provenance.js'
import type { ProvenanceLevel } from '../learning/knowledge.js'
import type { Database } from 'bun:sqlite'

const VALID_PROVENANCE_LEVELS: readonly ProvenanceLevel[] = [
  'human-verified',
  'ci-verified',
  'benchmark-verified',
  'agent-generated',
  'unverified',
]

function toProvenanceLevel(value: string | null | undefined): ProvenanceLevel | undefined {
  if (!value) return undefined
  return VALID_PROVENANCE_LEVELS.includes(value as ProvenanceLevel)
    ? (value as ProvenanceLevel)
    : undefined
}

// ── Types ──────────────────────────────────────────────────────────

export interface EvictionOptions {
  /** Minimum effective confidence to keep (default 0.3) */
  minConfidence?: number
  /** Maximum age in ms before eviction (default 180 days) */
  maxAgeMs?: number
  /** If true, only report what would be evicted (default false) */
  dryRun?: boolean
  /** If true, also evict memories flagged by cautionFlag (default true) */
  evictCautioned?: boolean
}

export interface EvictionEntry {
  id: string
  kind: string
  confidence: number
  lastVerifiedAt: number
  createdAt: number
  provenance?: string
}

export interface EvictionReport {
  scanned: number
  evicted: number
  kept: number
  dryRun: boolean
  evictedIds: string[]
  durationMs: number
}

// ── Constants ──────────────────────────────────────────────────────

const DEFAULT_MIN_CONFIDENCE = 0.3
const DEFAULT_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000 // 180 days

// ── Eviction Logic ─────────────────────────────────────────────────

/**
 * Determine if a memory entry should be evicted based on confidence and age.
 * Returns true if the entry is stale enough to evict.
 */
export function shouldEvict(
  entry: {
    confidence?: number
    lastVerifiedAt?: number
    createdAt?: number
    provenance?: ProvenanceLevel | string
  },
  now: number,
  options: EvictionOptions = {},
): boolean {
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS

  const effective = effectiveConfidence(entry, now)
  if (effective < minConfidence) return true

  const verifiedAt = entry.lastVerifiedAt ?? entry.createdAt ?? now
  if (now - verifiedAt > maxAgeMs) return true

  if (options.evictCautioned !== false) {
    const provenance = toProvenanceLevel(entry.provenance)
    const isCautioned =
      effective < minConfidence || provenance === 'unverified' || now - verifiedAt > STALE_AFTER_MS
    if (isCautioned) return true
  }

  return false
}

/**
 * Evict stale memories from the database.
 * Returns a report of what was evicted (or what would be evicted in dry-run mode).
 */
export function evictStaleMemories(db: Database, options: EvictionOptions = {}): EvictionReport {
  const t0 = Date.now()
  const now = t0
  const dryRun = options.dryRun ?? false

  const entries = db
    .prepare(
      `SELECT id, kind, confidence, lastVerifiedAt, createdAt, provenance
       FROM knowledge
       WHERE deleted_at IS NULL`,
    )
    .all() as EvictionEntry[]

  const evictedIds: string[] = []
  let evicted = 0
  let kept = 0

  for (const entry of entries) {
    if (shouldEvict(entry, now, options)) {
      evictedIds.push(entry.id)
      evicted++
    } else {
      kept++
    }
  }

  if (!dryRun && evictedIds.length > 0) {
    const placeholders = evictedIds.map(() => '?').join(',')
    db.prepare(`UPDATE knowledge SET deleted_at = ? WHERE id IN (${placeholders})`).run(
      now,
      ...evictedIds,
    )
  }

  return {
    scanned: entries.length,
    evicted,
    kept,
    dryRun,
    evictedIds,
    durationMs: Date.now() - t0,
  }
}

/**
 * Get a preview of what would be evicted without actually deleting.
 * Convenience wrapper around evictStaleMemories with dryRun: true.
 */
export function previewEviction(db: Database, options: EvictionOptions = {}): EvictionReport {
  return evictStaleMemories(db, { ...options, dryRun: true })
}
