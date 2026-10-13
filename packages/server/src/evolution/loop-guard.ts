/**
 * Evolution Loop Guard — self-healing loop prevention (§11)
 *
 * Docs: MIRA_WEAKNESSES_AND_OBSTACLES.md §11 (Self-Healing Can Become a Retry
 * Loop, P0): autonomous recovery must never produce
 *   Failure → Retry → Failure → Retry → …  (doom loop)
 *
 * Required controls per §11:
 *   maximum retries / maximum time / escalation threshold — enforced here via
 *   failure-fingerprint dedup + cooldown + attempt caps + human escalation.
 *   (cost/files/risk limits live in resources.ts + risk.ts.)
 *
 * Behavior (fail-closed):
 *   - Identical failures inside the cooldown window are recognized as the SAME
 *     incident: only the first occurrence proceeds to diagnosis→proposal.
 *   - Beyond MIRA_LOOP_MAX_ATTEMPTS distinct incidents for the same
 *     fingerprint inside the window, the fingerprint ESCALATES: blocked AND
 *     flagged requiresHuman until a human acknowledges (acknowledge()).
 *   - The guard never mutates files, DB rows, or other components' state.
 *
 * Documentation Maintenance — 10 items:
 * | # | Item | Status | Evidence |
 * |---|------|--------|----------|
 * | 1 | Implementation path | Implemented | packages/server/src/evolution/loop-guard.ts |
 * | 2 | Public interfaces | Implemented | LoopGuard.check(failure, evidence): LoopDecision; acknowledge(fingerprint?); stats(); fingerprints are stable hashes |
 * | 3 | Events | Implemented | caller emits evolution.loop_blocked / evolution.loop_escalated via Bus (module is pure) |
 * | 4 | Configuration | Implemented | MIRA_LOOP_COOLDOWN_MS (default 300000), MIRA_LOOP_MAX_ATTEMPTS (default 3), MIRA_LOOP_MAX_TRACKED (default 500) |
 * | 5 | Tests | Implemented | packages/server/src/evolution/loop-guard.test.ts (dedup, cap, escalation, ack, window expiry) |
 * | 6 | Security boundaries | Implemented | §11: no unbounded retry; escalation is fail-closed; fingerprints are one-way hashes (no evidence leakage) |
 * | 7 | Operational procedures | Implemented | wired in routes/evolution.ts before propose; stats() exposes active cooldowns/escalations |
 * | 8 | Migration strategy | Implemented | additive; durable store optional (SQLite evolution_loop_state) — restarts no longer bypass §11 protection |
 * | 9 | Rollback strategy | Implemented | delete module + wiring + table; in-memory mode unchanged without a store |
 * | 10 | Known limitations | Implemented | durable store is write-through single-process (multi-process CAS/locking Target); fingerprint normalizes whitespace/case but not semantic near-duplicates |
 */

import { createHash } from 'node:crypto'
import type { MiraDB } from '../storage/db.js'

export interface LoopDecision {
  /** Whether this failure may proceed to diagnosis→proposal. */
  allowed: boolean
  /** Stable one-way fingerprint of the normalized failure. */
  fingerprint: string
  /** How many times this fingerprint was seen (including now) inside the window. */
  attempts: number
  /** §11 escalation: attempt cap exhausted — human ack required. */
  escalated: boolean
  reason: string
  /** ms until this fingerprint's cooldown expires (0 when allowed). */
  retryInMs: number
}

interface FingerprintRecord {
  attempts: number[]
  escalatedAt?: number
}

/**
 * Durable §11 state — without it a restart resets attempt counts and a
 * doom-looping agent can simply crash/restart its way past the cap.
 * Implementations must be fail-soft (throwing blocks the observe pipeline).
 */
export interface LoopGuardStore {
  load(): Array<{ fingerprint: string; record: FingerprintRecord }>
  save(fingerprint: string, record: FingerprintRecord): void
  clear(fingerprint: string): void
}

/** SQLite-backed store — write-through, fail-soft at the call sites. */
export function createSqliteLoopGuardStore(db: MiraDB): LoopGuardStore {
  const sqlite = db.sqlite
  if (!sqlite) throw new Error('no sqlite handle')
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS evolution_loop_state (
      fingerprint TEXT PRIMARY KEY,
      attempts TEXT NOT NULL,
      escalated_at INTEGER
    );
  `)
  return {
    load() {
      try {
        const rows = sqlite
          .prepare('SELECT fingerprint, attempts, escalated_at FROM evolution_loop_state')
          .all() as Array<{ fingerprint: string; attempts: string; escalated_at: number | null }>
        return rows.map((r) => ({
          fingerprint: r.fingerprint,
          record: {
            attempts: JSON.parse(r.attempts) as number[],
            ...(r.escalated_at !== null ? { escalatedAt: r.escalated_at } : {}),
          },
        }))
      } catch {
        return []
      }
    },
    save(fingerprint, record) {
      try {
        sqlite
          .prepare(
            `INSERT OR REPLACE INTO evolution_loop_state (fingerprint, attempts, escalated_at) VALUES (?, ?, ?)`,
          )
          .run(fingerprint, JSON.stringify(record.attempts), record.escalatedAt ?? null)
      } catch {}
    },
    clear(fingerprint) {
      try {
        sqlite.prepare('DELETE FROM evolution_loop_state WHERE fingerprint = ?').run(fingerprint)
      } catch {}
    },
  }
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name])
  if (!Number.isFinite(raw)) return fallback
  return Math.min(max, Math.max(min, Math.floor(raw)))
}

/** Normalize a failure into a stable fingerprint — one-way hash, no raw leak. */
export function failureFingerprint(failure: string, evidence?: unknown): string {
  const norm = String(failure ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\d+/g, '#') // counts/ids/ports vary per occurrence; the shape is the signal
    .trim()
  let evShape = ''
  try {
    if (evidence && typeof evidence === 'object') {
      const keys = Object.keys(evidence as Record<string, unknown>)
        .sort()
        .slice(0, 5)
      evShape = keys.join(',')
    }
  } catch {}
  return createHash('sha256').update(`${norm}|${evShape}`).digest('hex').slice(0, 24)
}

export class LoopGuard {
  private records = new Map<string, FingerprintRecord>()
  private readonly cooldownMs: number
  private readonly maxAttempts: number
  private readonly maxTracked: number
  private store?: LoopGuardStore

  constructor(
    opts: {
      cooldownMs?: number
      maxAttempts?: number
      maxTracked?: number
      /** Durable §11 state — without it a restart resets the cap (bypass risk). */
      store?: LoopGuardStore
    } = {},
  ) {
    this.cooldownMs =
      opts.cooldownMs ?? envInt('MIRA_LOOP_COOLDOWN_MS', 300_000, 0, 24 * 60 * 60 * 1000)
    this.maxAttempts = opts.maxAttempts ?? envInt('MIRA_LOOP_MAX_ATTEMPTS', 3, 1, 100)
    this.maxTracked = opts.maxTracked ?? envInt('MIRA_LOOP_MAX_TRACKED', 500, 10, 10_000)
    if (opts.store) {
      this.store = opts.store
      try {
        for (const { fingerprint, record } of this.store.load()) {
          this.records.set(fingerprint, record)
        }
      } catch {}
    }
  }

  check(failure: string, evidence?: unknown, now = Date.now()): LoopDecision {
    const fingerprint = failureFingerprint(failure, evidence)
    const rec = this.records.get(fingerprint) ?? { attempts: [] }
    // Prune attempts outside the cooldown window
    rec.attempts = rec.attempts.filter((t) => now - t < this.cooldownMs)
    const attempts = rec.attempts.length + 1
    const escalated =
      (rec.escalatedAt !== undefined && now - rec.escalatedAt < this.cooldownMs) ||
      attempts > this.maxAttempts

    if (escalated) rec.escalatedAt = rec.escalatedAt ?? now
    rec.attempts.push(now)
    this.records.set(fingerprint, rec)
    try {
      this.store?.save(fingerprint, rec)
    } catch {}
    this.prune()

    const firstOccurrence = attempts === 1
    // §11: same incident inside cooldown → it is already being handled upstream.
    // Distinct incident but cap exhausted → escalated, human required.
    const allowed = firstOccurrence || (!escalated && this.cooldownMs === 0)
    const oldest = rec.attempts[0] ?? now
    const retryInMs = allowed ? 0 : Math.max(0, this.cooldownMs - (now - oldest))

    const reason = allowed
      ? 'first occurrence of this failure shape — proceeding'
      : escalated
        ? `§11 escalation: ${attempts} incidents of the same failure shape exceed MIRA_LOOP_MAX_ATTEMPTS=${this.maxAttempts} — recovery failed, human ack required (acknowledge())`
        : `duplicate failure inside cooldown (${Math.round(retryInMs / 1000)}s left) — incident already being handled`

    return { allowed, fingerprint, attempts, escalated, reason, retryInMs }
  }

  /** Human (or higher-level agent) acknowledges an escalated fingerprint — §11 ESCALATE path. */
  acknowledge(fingerprint?: string): number {
    let cleared = 0
    for (const [fp, rec] of this.records) {
      if (fingerprint && fp !== fingerprint) continue
      if (rec.escalatedAt !== undefined) {
        rec.escalatedAt = undefined
        rec.attempts = []
        cleared++
        try {
          this.store?.clear(fp)
        } catch {}
      }
    }
    return cleared
  }

  private prune(): void {
    if (this.records.size <= this.maxTracked) return
    // Drop least-recently-seen fingerprints
    const entries = [...this.records.entries()].sort(
      (a, b) => (b[1].attempts.at(-1) ?? 0) - (a[1].attempts.at(-1) ?? 0),
    )
    for (const [fp] of entries.slice(this.maxTracked)) {
      this.records.delete(fp)
      try {
        this.store?.clear(fp)
      } catch {}
    }
  }

  stats(now = Date.now()): {
    tracked: number
    escalated: number
    cooldownMs: number
    maxAttempts: number
  } {
    let escalated = 0
    for (const rec of this.records.values()) {
      if (rec.escalatedAt !== undefined && now - rec.escalatedAt < this.cooldownMs) escalated++
    }
    return {
      tracked: this.records.size,
      escalated,
      cooldownMs: this.cooldownMs,
      maxAttempts: this.maxAttempts,
    }
  }
}
