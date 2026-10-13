/**
 * §9 acceptance — durable, atomic, idempotent budget accounting.
 *
 * docs/LONG_TERM_RISK_AND_SCALABILITY_PLAN.md §9:
 *   "Move authoritative accounting to durable storage. Reserve budget
 *    atomically before expensive work, reconcile actual usage afterward, and
 *    make retries idempotent."
 *
 * ResourceLimits previously kept four counters in process memory, which meant a
 * restart reset the daily budget to zero and concurrent checkBudget() calls
 * could each observe the same headroom and both charge it.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createDatabase, migrate, type MiraDB } from '../storage/db.js'
import { DurableBudgetLedger } from './budget-ledger.js'
import { ResourceLimits } from './resources.js'

const CAPS = { perTask: 5, perAgent: 1, perMission: 2, daily: 3 }
const DAY = Date.now()

let db: MiraDB
beforeEach(async () => {
  db = createDatabase(':memory:')
  await migrate(db)
})
afterEach(() => {
  try {
    db.sqlite.close()
  } catch {}
})

describe('§9: spend is durable, not process state', () => {
  test('spend survives losing the in-memory instance entirely', () => {
    const a = new DurableBudgetLedger(db)
    const r1 = a.reserve({ cost: 0.9, agent: 'fixer', missionID: 'm1', caps: CAPS })
    expect(r1.allowed).toBe(true)

    // A brand-new ledger over the same DB is what a process restart looks like.
    const afterRestart = new DurableBudgetLedger(db)
    expect(afterRestart.getSpend({ agent: 'fixer', missionID: 'm1' }).daily).toBeCloseTo(0.9, 6)

    // The restarted budget has less headroom — it did not reset to zero.
    const denied = afterRestart.reserve({ cost: 0.9, agent: 'fixer', missionID: 'm1', caps: CAPS })
    expect(denied.allowed).toBe(false)
    expect(denied.scope).toBe('agent')
  })

  test('ResourceLimits uses the ledger when given a db', () => {
    const rl = new ResourceLimits({ db, caps: CAPS })
    expect(rl.budgetLedger).toBeTruthy()
    const ok = rl.checkBudget({ id: 'p1' }, 0.4)
    expect(ok.allowed).toBe(true)
    expect(ok.reservationId).toBeTruthy()

    // second call sees the first call's spend
    expect(rl.checkBudget({ id: 'p2' }, 0.4).allowed).toBe(true)
    const third = rl.checkBudget({ id: 'p3' }, 0.4)
    expect(third.allowed).toBe(false)
  })

  test('without a db it keeps the legacy in-memory behaviour', () => {
    const rl = new ResourceLimits({ caps: CAPS })
    expect(rl.budgetLedger).toBeUndefined()
    expect(rl.checkBudget({ id: 'p1' }, 0.4).allowed).toBe(true)
  })
})

describe('§9: reserve before spend, reconcile after', () => {
  test('an unsettled reservation still counts against the cap', () => {
    const l = new DurableBudgetLedger(db)
    const r = l.reserve({ cost: 0.9, agent: 'a', missionID: 'm', caps: CAPS })
    expect(r.allowed).toBe(true)
    // nothing settled yet, but the budget is already held
    expect(l.getSpend({ agent: 'a', missionID: 'm' }).daily).toBeCloseTo(0.9, 6)
    expect(l.get(r.reservationId!)!.state).toBe('reserved')
  })

  test('settling replaces the reservation with the real cost', () => {
    const l = new DurableBudgetLedger(db)
    const r = l.reserve({ cost: 1, agent: 'a', missionID: 'm', caps: { ...CAPS, perAgent: 9 } })
    expect(r.allowed).toBe(true)
    expect(l.settle(r.reservationId!, 0.2)).toBe(true)
    const row = l.get(r.reservationId!)!
    expect(row.state).toBe('settled')
    expect(row.actualUSD).toBe(0.2)
    // the over-reservation is handed back
    expect(l.getSpend({ agent: 'a', missionID: 'm' }).daily).toBeCloseTo(0.2, 6)
  })

  test('releasing returns the budget when the work never ran', () => {
    const l = new DurableBudgetLedger(db)
    const r = l.reserve({ cost: 1, agent: 'a', missionID: 'm', caps: { ...CAPS, perAgent: 1.5 } })
    expect(r.allowed).toBe(true)
    expect(l.release(r.reservationId!)).toBe(true)
    expect(l.getSpend({ agent: 'a', missionID: 'm' }).daily).toBe(0)
    // and the freed budget is usable again
    expect(
      l.reserve({ cost: 1, agent: 'a', missionID: 'm', caps: { ...CAPS, perAgent: 1.5 } }).allowed,
    ).toBe(true)
  })

  test('a crashed reservation is held until reconciled, not auto-returned', () => {
    const l = new DurableBudgetLedger(db)
    l.reserve({ cost: 0.9, agent: 'a', missionID: 'm', caps: CAPS, now: DAY - 10 * 60_000 })
    // even 10 minutes later the budget has not silently come back
    expect(l.getSpend({ agent: 'a', missionID: 'm' }).daily).toBeCloseTo(0.9, 6)
    expect(l.staleReservations(60_000, DAY).length).toBe(1)
  })
})

describe('§9: retries are idempotent', () => {
  test('the same idempotency key does not charge twice', () => {
    const l = new DurableBudgetLedger(db)
    const first = l.reserve({
      cost: 0.6,
      agent: 'a',
      missionID: 'm',
      caps: { ...CAPS, perAgent: 1 },
      idempotencyKey: 'task-1',
    })
    expect(first.allowed).toBe(true)
    const retry = l.reserve({
      cost: 0.6,
      agent: 'a',
      missionID: 'm',
      caps: { ...CAPS, perAgent: 1 },
      idempotencyKey: 'task-1',
    })
    expect(retry.allowed).toBe(true)
    expect(retry.reservationId).toBe(first.reservationId)
    expect(l.getSpend({ agent: 'a', missionID: 'm' }).daily).toBeCloseTo(0.6, 6)
  })

  test('a retry that would otherwise breach the cap still succeeds as a replay', () => {
    const l = new DurableBudgetLedger(db)
    l.reserve({
      cost: 0.9,
      agent: 'a',
      missionID: 'm',
      caps: { ...CAPS, perAgent: 1 },
      idempotencyKey: 'task-1',
    })
    // a DIFFERENT task genuinely breaches
    expect(
      l.reserve({
        cost: 0.9,
        agent: 'a',
        missionID: 'm',
        caps: { ...CAPS, perAgent: 1 },
        idempotencyKey: 'task-2',
      }).allowed,
    ).toBe(false)
    // the same task replaying does not
    expect(
      l.reserve({
        cost: 0.9,
        agent: 'a',
        missionID: 'm',
        caps: { ...CAPS, perAgent: 1 },
        idempotencyKey: 'task-1',
      }).allowed,
    ).toBe(true)
  })

  test('a released reservation cannot be replayed as a fresh charge', () => {
    const l = new DurableBudgetLedger(db)
    const r = l.reserve({
      cost: 0.5,
      agent: 'a',
      missionID: 'm',
      caps: CAPS,
      idempotencyKey: 'task-1',
    })
    l.release(r.reservationId!)
    const replay = l.reserve({
      cost: 0.5,
      agent: 'a',
      missionID: 'm',
      caps: CAPS,
      idempotencyKey: 'task-1',
    })
    expect(replay.allowed).toBe(false)
  })
})

describe('§9: each scope is enforced independently', () => {
  test('per-task cap', () => {
    const l = new DurableBudgetLedger(db)
    const r = l.reserve({ cost: 2, agent: 'a', missionID: 'm', caps: { ...CAPS, perTask: 0.5 } })
    expect(r.allowed).toBe(false)
    expect(r.reason).toContain('per-task')
  })

  test('per-mission cap', () => {
    const l = new DurableBudgetLedger(db)
    const caps = { ...CAPS, perMission: 1 }
    expect(l.reserve({ cost: 0.6, agent: 'a', missionID: 'm1', caps }).allowed).toBe(true)
    const d = l.reserve({ cost: 0.6, agent: 'b', missionID: 'm1', caps })
    expect(d.allowed).toBe(false)
    expect(d.scope).toBe('mission')
  })

  test('daily cap spans all agents and missions', () => {
    const l = new DurableBudgetLedger(db)
    const caps = { ...CAPS, daily: 1 }
    expect(l.reserve({ cost: 0.6, agent: 'a', missionID: 'm1', caps }).allowed).toBe(true)
    expect(l.reserve({ cost: 0.6, agent: 'b', missionID: 'm2', caps }).allowed).toBe(false)
  })

  test('a new day gets a fresh budget without wiping history', () => {
    const l = new DurableBudgetLedger(db)
    const caps = { ...CAPS, daily: 1 }
    l.reserve({ cost: 0.9, agent: 'a', missionID: 'm', caps, now: DAY })
    expect(l.reserve({ cost: 0.9, agent: 'a', missionID: 'm', caps, now: DAY }).allowed).toBe(false)
    // tomorrow
    const tomorrow = DAY + 86_400_000
    expect(l.reserve({ cost: 0.9, agent: 'a', missionID: 'm', caps, now: tomorrow }).allowed).toBe(
      true,
    )
    // yesterday's record is still there for audit
    expect(l.list().length).toBe(2)
  })

  test('invalid or non-positive cost is refused', () => {
    const l = new DurableBudgetLedger(db)
    for (const bad of [0, -1, NaN, Infinity]) {
      const r = l.reserve({ cost: bad, agent: 'a', missionID: 'm', caps: CAPS })
      expect(r.allowed, String(bad)).toBe(false)
    }
  })
})

describe('§9: atomicity', () => {
  test('concurrent reserves cannot both spend the same headroom', async () => {
    const l = new DurableBudgetLedger(db)
    const caps = { ...CAPS, perAgent: 1, daily: 1 }
    // 10 concurrent 0.3 reservations against a 1.0 budget: at most 3 may pass.
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        Promise.resolve().then(() => l.reserve({ cost: 0.3, agent: 'a', missionID: 'm', caps })),
      ),
    )
    const allowed = results.filter((r) => r.allowed).length
    expect(allowed).toBeLessThanOrEqual(3)
    const spent = l.getSpend({ agent: 'a', missionID: 'm' }).daily
    expect(spent).toBeLessThanOrEqual(1.0000001)
    // the ledger total always equals the sum of the accepted reservations
    expect(spent).toBeCloseTo(allowed * 0.3, 6)
  })

  test('a denied reserve writes nothing', () => {
    const l = new DurableBudgetLedger(db)
    const before = l.list().length
    l.reserve({ cost: 99, agent: 'a', missionID: 'm', caps: CAPS })
    expect(l.list().length).toBe(before)
  })
})
describe('§9: the release reason is retained for audit', () => {
  test('release() keeps the reason on the row', () => {
    const l = new DurableBudgetLedger(db)
    const r = l.reserve({ cost: 0.5, agent: 'a', missionID: 'm', caps: CAPS })
    expect(l.release(r.reservationId!, 'verifier crashed before any work ran')).toBe(true)
    const row = l.get(r.reservationId!)!
    expect(row.state).toBe('released')
    expect(row.releaseReason).toBe('verifier crashed before any work ran')
    // still queryable in the audit listing, and still returns the budget
    expect(l.list().some((x) => x.id === r.reservationId)).toBe(true)
    expect(l.getSpend({ agent: 'a', missionID: 'm' }).daily).toBe(0)
  })

  test('releasing without a reason is allowed and records null', () => {
    const l = new DurableBudgetLedger(db)
    const r = l.reserve({ cost: 0.5, agent: 'a', missionID: 'm', caps: CAPS })
    expect(l.release(r.reservationId!)).toBe(true)
    expect(l.get(r.reservationId!)!.releaseReason).toBeNull()
  })

  test('a settled reservation cannot be released, so its reason is not lost', () => {
    const l = new DurableBudgetLedger(db)
    const r = l.reserve({ cost: 0.5, agent: 'a', missionID: 'm', caps: CAPS })
    expect(l.settle(r.reservationId!, 0.4)).toBe(true)
    expect(l.release(r.reservationId!, 'too late')).toBe(false)
    const row = l.get(r.reservationId!)!
    expect(row.state).toBe('settled')
    expect(row.actualUSD).toBe(0.4)
  })

  test('ResourceLimits.releaseReservation forwards the reason', () => {
    const rl = new ResourceLimits({ db, caps: CAPS })
    const check = rl.checkBudget({ id: 'p1' }, 0.2)
    expect(check.allowed).toBe(true)
    expect(rl.releaseReservation(check.reservationId!, 'aborted by operator')).toBe(true)
    expect(rl.budgetLedger!.get(check.reservationId!)!.releaseReason).toBe('aborted by operator')
  })
})

describe('§9: schema migration for pre-existing databases', () => {
  test('a table created before release_reason gains the column', async () => {
    // simulate a DB written by the first version of this table
    db.sqlite.exec(`DROP TABLE IF EXISTS budget_reservations`)
    db.sqlite.exec(`
      CREATE TABLE budget_reservations (
        id TEXT PRIMARY KEY, agent TEXT NOT NULL, mission_id TEXT NOT NULL,
        day TEXT NOT NULL, reserved_usd REAL NOT NULL, actual_usd REAL,
        state TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `)
    // re-running init() must add the missing column rather than fail
    new DurableBudgetLedger(db)

    const cols = db.sqlite.prepare(`PRAGMA table_info(budget_reservations)`).all() as Array<{
      name: string
    }>
    expect(cols.map((c) => c.name)).toContain('release_reason')

    // and the table is still usable
    const l = new DurableBudgetLedger(db)
    const r = l.reserve({ cost: 0.5, agent: 'a', missionID: 'm', caps: CAPS })
    expect(r.allowed).toBe(true)
    expect(l.release(r.reservationId!, 'migrated row')).toBe(true)
    expect(l.get(r.reservationId!)!.releaseReason).toBe('migrated row')
  })
})
