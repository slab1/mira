/**
 * Evolution — durable budget ledger (§9).
 *
 * §9 of docs/LONG_TERM_RISK_AND_SCALABILITY_PLAN.md:
 *   "Move authoritative accounting to durable storage. Reserve budget
 *    atomically before expensive work, reconcile actual usage afterward, and
 *    make retries idempotent."
 *
 * ResourceLimits kept four counters in process memory, which meant:
 *   - a restart reset the daily budget to zero (documented limitation #10), so
 *     the authoritative budget for a long-running autonomous platform was the
 *     one thing that could not be trusted after a crash;
 *   - checkBudget() read the counters and then wrote them with no lock, so two
 *     concurrent calls could both observe headroom and both charge it;
 *   - `reset()` — documented as the "rollback strategy" — erased the spend
 *     history that an audit trail depends on.
 *
 * This is an append-only ledger. Spend is RESERVED before work starts and
 * SETTLED with the real cost afterwards; an unsettled reservation still counts
 * against the cap, so a crash mid-task cannot hand back budget that was already
 * committed.
 */

import type { MiraDB } from '../storage/db.js'
import type { BudgetCaps } from './resources.js'

export type BudgetScope = 'agent' | 'mission' | 'daily'

export type ReservationState = 'reserved' | 'settled' | 'released'

export interface BudgetReservation {
  id: string
  agent: string
  missionID: string
  day: string
  /** Amount held up-front. Counts against the cap until settled or released. */
  reservedUSD: number
  /** Real cost once known; null while still in flight. */
  actualUSD: number | null
  state: ReservationState
  /** Why the reservation was released. Null unless state is 'released'. */
  releaseReason: string | null
  createdAt: number
}

export interface ReservationDecision {
  allowed: boolean
  /** The reservation id — pass to settle()/release(). Null when denied. */
  reservationId: string | null
  reason?: string
  /** Which scope denied it, when denied. */
  scope?: BudgetScope
  cost: number
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS budget_reservations (
    id TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    mission_id TEXT NOT NULL,
    day TEXT NOT NULL,
    reserved_usd REAL NOT NULL,
    actual_usd REAL,
    state TEXT NOT NULL,
    release_reason TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS budget_reservations_agent ON budget_reservations(day, agent);
  CREATE INDEX IF NOT EXISTS budget_reservations_mission ON budget_reservations(day, mission_id);
  CREATE INDEX IF NOT EXISTS budget_reservations_day ON budget_reservations(day);
`

/** Effective spend = settled actual, or the full reservation while in flight. */
const EFFECTIVE_SPEND = `
  SELECT
    COALESCE(SUM(CASE WHEN state = 'settled' THEN actual_usd ELSE reserved_usd END), 0) AS total
  FROM budget_reservations
  WHERE state IN ('reserved','settled')
`

export class DurableBudgetLedger {
  constructor(private db: MiraDB) {
    this.init()
  }

  init(): void {
    this.db.sqlite.exec(SCHEMA)
    // CREATE TABLE IF NOT EXISTS does not add columns to a table that already
    // exists, so a DB created before release_reason existed needs an explicit
    // add (same idempotent pattern as storage/db.ts — SQLite has no
    // ADD COLUMN IF NOT EXISTS).
    try {
      this.db.sqlite.exec(`ALTER TABLE budget_reservations ADD COLUMN release_reason TEXT;`)
    } catch (e) {
      const msg = String(e)
      if (!msg.includes('duplicate column name')) {
        console.warn('[budget] addColumn budget_reservations.release_reason failed:', msg)
      }
    }
  }

  private spendFor(scope: BudgetScope, key: string, day: string): number {
    const where =
      scope === 'daily'
        ? 'day = ?'
        : scope === 'agent'
          ? 'day = ? AND agent = ?'
          : 'day = ? AND mission_id = ?'
    const row = this.db.sqlite
      .prepare(`${EFFECTIVE_SPEND} AND ${where}`)
      .get(...(scope === 'daily' ? [day] : [day, key])) as { total: number }
    return Number(row?.total ?? 0)
  }

  getSpend(opts: { agent?: string; missionID?: string; day?: string }): {
    daily: number
    agent: number
    mission: number
  } {
    const day = opts.day ?? today()
    return {
      daily: this.spendFor('daily', '', day),
      agent: this.spendFor('agent', opts.agent ?? 'default', day),
      mission: this.spendFor('mission', opts.missionID ?? 'default', day),
    }
  }

  /**
   * Atomically reserve budget for work that is about to happen.
   *
   * `idempotencyKey` makes retries safe: replaying the same key returns the
   * original decision instead of charging twice. Pass a stable key (task id,
   * job id) — omitting it disables replay protection for that call.
   *
   * Atomicity: BEGIN IMMEDIATE takes the write lock up front, so a concurrent
   * reserve cannot interleave between our read of the totals and our insert.
   */
  reserve(opts: {
    cost: number
    agent: string
    missionID: string
    caps: BudgetCaps
    idempotencyKey?: string
    /** Hard per-task ceiling, checked before any scope total. */
    perTaskCap?: number
    now?: number
  }): ReservationDecision {
    const cost = Number(opts.cost)
    if (!Number.isFinite(cost) || cost <= 0) {
      return {
        allowed: false,
        reservationId: null,
        reason: `invalid cost ${String(opts.cost)}`,
        cost: 0,
      }
    }

    const day = dayOf(opts.now ?? Date.now())
    const id =
      opts.idempotencyKey ??
      `res_${(opts.now ?? Date.now()).toString(36)}_${Math.random().toString(36).slice(2, 10)}`

    const perTaskCap = opts.perTaskCap ?? opts.caps.perTask
    if (cost > perTaskCap) {
      return {
        allowed: false,
        reservationId: null,
        scope: 'daily',
        reason: `per-task budget exceeded: cost $${cost.toFixed(3)} > cap $${perTaskCap.toFixed(2)} (per-task)`,
        cost,
      }
    }

    // Replay protection — an existing reservation for this key means this call
    // is a retry of work already accounted for.
    const existing = this.get(id)
    if (existing) {
      return {
        allowed: existing.state !== 'released',
        reservationId: existing.id,
        cost: existing.reservedUSD,
        ...(existing.state === 'released'
          ? {
              reason: `reservation ${existing.id} was released; retry requires a new idempotency key`,
            }
          : {}),
      }
    }

    const sqlite = this.db.sqlite
    sqlite.exec('BEGIN IMMEDIATE')
    try {
      const agentSpent = this.spendFor('agent', opts.agent, day)
      if (agentSpent + cost > opts.caps.perAgent) {
        sqlite.exec('COMMIT')
        return {
          allowed: false,
          reservationId: null,
          scope: 'agent',
          reason: `per-agent budget exceeded: agent "${opts.agent}" would be $${(agentSpent + cost).toFixed(3)} > cap $${opts.caps.perAgent.toFixed(2)}`,
          cost,
        }
      }

      const missionSpent = this.spendFor('mission', opts.missionID, day)
      if (missionSpent + cost > opts.caps.perMission) {
        sqlite.exec('COMMIT')
        return {
          allowed: false,
          reservationId: null,
          scope: 'mission',
          reason: `per-mission budget exceeded: mission "${opts.missionID}" would be $${(missionSpent + cost).toFixed(3)} > cap $${opts.caps.perMission.toFixed(2)}`,
          cost,
        }
      }

      const dailySpent = this.spendFor('daily', '', day)
      if (dailySpent + cost > opts.caps.daily) {
        sqlite.exec('COMMIT')
        return {
          allowed: false,
          reservationId: null,
          scope: 'daily',
          reason: `daily budget exceeded: daily would be $${(dailySpent + cost).toFixed(3)} > cap $${opts.caps.daily.toFixed(2)}`,
          cost,
        }
      }

      sqlite
        .prepare(
          `INSERT INTO budget_reservations (id, agent, mission_id, day, reserved_usd, actual_usd, state, created_at)
           VALUES (?, ?, ?, ?, ?, NULL, 'reserved', ?)`,
        )
        .run(id, opts.agent, opts.missionID, day, cost, opts.now ?? Date.now())
      sqlite.exec('COMMIT')
      return { allowed: true, reservationId: id, cost }
    } catch (e) {
      try {
        sqlite.exec('ROLLBACK')
      } catch {}
      return {
        allowed: false,
        reservationId: null,
        reason: `budget reservation failed: ${String(e)}`,
        cost,
      }
    }
  }

  /** Reconcile a reservation with the real cost. */
  settle(id: string, actualUSD: number): boolean {
    if (!Number.isFinite(actualUSD) || actualUSD < 0) return false
    const res = this.db.sqlite
      .prepare(
        `UPDATE budget_reservations SET actual_usd = ?, state = 'settled' WHERE id = ? AND state = 'reserved'`,
      )
      .run(actualUSD, id)
    return res.changes > 0
  }

  /**
   * Return an unspent reservation to the budget.
   *
   * `reason` is retained on the row: the ledger is append-only, so an operator
   * auditing spend later needs to know why budget was handed back — "the work
   * never ran" and "the estimate was wrong" are very different events.
   */
  release(id: string, reason?: string): boolean {
    const res = this.db.sqlite
      .prepare(
        `UPDATE budget_reservations
         SET state = 'released', actual_usd = 0, release_reason = ?
         WHERE id = ? AND state = 'reserved'`,
      )
      .run(reason ?? null, id)
    return res.changes > 0
  }

  get(id: string): BudgetReservation | null {
    const row = this.db.sqlite.prepare(`SELECT * FROM budget_reservations WHERE id = ?`).get(id) as
      Record<string, unknown> | undefined
    if (!row) return null
    return {
      id: String(row.id),
      agent: String(row.agent),
      missionID: String(row.mission_id),
      day: String(row.day),
      reservedUSD: Number(row.reserved_usd),
      actualUSD: row.actual_usd === null ? null : Number(row.actual_usd),
      state: String(row.state) as ReservationState,
      releaseReason:
        row.release_reason === null || row.release_reason === undefined
          ? null
          : String(row.release_reason),
      createdAt: Number(row.created_at),
    }
  }

  list(day?: string): BudgetReservation[] {
    const rows = this.db.sqlite
      .prepare(
        `SELECT id FROM budget_reservations ${day ? 'WHERE day = ?' : ''} ORDER BY created_at DESC`,
      )
      .all(...(day ? [day] : [])) as Array<{ id: string }>
    return rows.map((r) => this.get(r.id)).filter((r): r is BudgetReservation => r !== null)
  }

  /**
   * Reservations left in-flight past their TTL. These represent work that may
   * have crashed mid-flight; their budget stays held until an operator (or a
   * reconciler) settles or releases them.
   */
  staleReservations(ttlMs: number, now = Date.now()): BudgetReservation[] {
    const cutoff = now - ttlMs
    const rows = this.db.sqlite
      .prepare(`SELECT id FROM budget_reservations WHERE state = 'reserved' AND created_at < ?`)
      .all(cutoff) as Array<{ id: string }>
    return rows.map((r) => this.get(r.id)).filter((r): r is BudgetReservation => r !== null)
  }
}

const today = (): string => dayOf(Date.now())

function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}
