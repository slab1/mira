/**
 * §8 acceptance — a mission is bounded as a whole, not per call.
 *
 * docs/LONG_TERM_RISK_AND_SCALABILITY_PLAN.md §8:
 *   "local caps do not guarantee a bounded overall mission" and "A task that
 *    exceeds its budget must stop or request approval. It must not spawn
 *    additional tasks to evade its parent budget."
 *
 * Previously `orchestrateSchema` capped one call at 12 tasks and `budgetSteps`
 * was declared on every task but enforced nowhere, so a mission was bounded by
 * nothing the caller chose to type.
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import {
  MissionBudget,
  MissionBudgetExhausted,
  DEFAULT_MISSION_CAPS,
  getAmbientMission,
  setAmbientMission,
  withAmbientMission,
} from './mission-budget.js'

const caps = {
  maxAgents: 5,
  maxDepth: 3,
  maxRetries: 4,
  maxWallClockMs: 60_000,
  maxCostUSD: 1,
  maxToolCalls: 10,
}

let clock = 0
beforeEach(() => {
  clock = 1_000_000
  setAmbientMission(undefined)
})

const budget = () => new MissionBudget({ caps, now: () => clock })

describe('§8: aggregate admission', () => {
  test('agents are counted across the whole mission', () => {
    const b = budget()
    expect(b.admit(3, 1).allowed).toBe(true)
    expect(b.getUsage().agents).toBe(3)
    // a second call continues against the SAME total
    expect(b.admit(3, 1).allowed).toBe(false)
    expect(b.getUsage().agents).toBe(3) // unchanged on refusal
  })

  test('admission is decided before work runs, so a refusal costs nothing', () => {
    const b = budget()
    b.admit(5, 1)
    const r = b.admit(1, 1)
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('max-agents')
    expect(b.getUsage().agents).toBe(5)
  })

  test('a single admission larger than the cap is refused outright', () => {
    const b = new MissionBudget({ caps: { ...caps, maxAgents: 3 }, now: () => clock })
    expect(b.admit(10, 1).allowed).toBe(false)
    expect(b.getUsage().agents).toBe(0)
  })

  test('a budget that allows nothing charges nothing', () => {
    const b = new MissionBudget({ caps: { ...caps, maxAgents: 0 }, now: () => clock })
    expect(b.admit(1, 1).allowed).toBe(false)
    expect(b.getUsage().agents).toBe(0)
  })
})

describe('§8: nesting depth is bounded', () => {
  test('admission beyond maxDepth is refused', () => {
    const b = budget() // maxDepth 3
    expect(b.admit(1, 3).allowed).toBe(true)
    const deep = b.admit(1, 4)
    expect(deep.allowed).toBe(false)
    expect(deep.reason).toBe('max-depth')
  })

  test('depth is recorded for the audit record', () => {
    const b = budget()
    b.admit(1, 2)
    b.admit(1, 3)
    expect(b.getUsage().maxDepthSeen).toBe(3)
  })
})

describe('§8: a child cannot evade its parent budget', () => {
  test('a derived child shares the parent counters', () => {
    const root = budget()
    root.admit(3, 1)
    const child = root.derive(2)
    // the child sees what the parent already spent...
    expect(child.getUsage().agents).toBe(3)
    // ...and its own admission charges the SAME total
    expect(child.admit(2, 2).allowed).toBe(true)
    expect(root.getUsage().agents).toBe(5)
    expect(child.getUsage().agents).toBe(5)
  })

  test('nested spawning is bounded by the mission, not per call', () => {
    const root = budget() // maxAgents 5

    // Simulate the evasion the old caps allowed: spawn 3, then have children
    // each try to spawn 3 more.
    root.admit(3, 1)
    const children = [root.derive(2), root.derive(2), root.derive(2)]
    const outcomes = children.map((c) => c.admit(3, 2).allowed)

    expect(outcomes.filter(Boolean).length).toBeLessThanOrEqual(1)
    expect(root.getUsage().agents).toBeLessThanOrEqual(5)
  })

  test('an unbounded nest terminates instead of exploding', () => {
    const root = budget()
    root.admit(1, 1)
    let spawned = root.getUsage().agents
    let depth = 2
    // each generation tries to spawn 3
    while (depth < 50) {
      const child = root.derive(depth)
      const r = child.admit(3, depth)
      if (!r.allowed) break
      spawned = root.getUsage().agents
      depth++
    }
    expect(spawned).toBeLessThanOrEqual(caps.maxAgents)
    expect(depth).toBeLessThan(50)
  })

  test('derive() cannot be used to mint a bigger allowance', () => {
    const root = new MissionBudget({ caps: { ...caps, maxAgents: 2 }, now: () => clock })
    root.admit(2, 1)
    // a derived handle keeps the parent's caps — there is no caps parameter
    const child = root.derive(2)
    expect(child.getCaps().maxAgents).toBe(2)
    expect(child.admit(1, 2).allowed).toBe(false)
  })
})

describe('§8: retries, cost, tool calls and wall clock are shared', () => {
  test('retry budget is mission-wide', () => {
    const b = budget() // maxRetries 4
    expect(b.admitRetries(3).allowed).toBe(true)
    expect(b.admitRetries(2).allowed).toBe(false)
    expect(b.getUsage().retries).toBe(3)
  })

  test('spend is charged against the mission and blocks past the cap', () => {
    const b = budget() // maxCostUSD 1
    b.chargeSpend(0.9)
    expect(b.getUsage().costUSD).toBeCloseTo(0.9, 6)
    // the next admission is refused because the cap is already passed
    expect(b.admit(1, 1).allowed).toBe(false)
    expect(b.admit(1, 1).reason).toBe('cost')
  })

  test('a child charges the same spend pool', () => {
    const root = budget()
    root.derive(2).chargeSpend(0.5)
    root.derive(3).chargeSpend(0.25)
    expect(root.getUsage().costUSD).toBeCloseTo(0.75, 6)
  })

  test('nonsense spend is ignored rather than corrupting the total', () => {
    const b = budget()
    b.chargeSpend(Number.NaN)
    b.chargeSpend(-5)
    b.chargeSpend(0)
    expect(b.getUsage().costUSD).toBe(0)
  })

  test('tool calls are counted and bounded', () => {
    const b = budget() // maxToolCalls 10, reserve = ceil(10/5) = 2
    b.chargeToolCalls(7)
    // 7 used + 2 reserve <= 10, so one more agent still fits
    expect(b.admit(1, 1).allowed).toBe(true)
    b.chargeToolCalls(2) // 9 used
    // 9 + 2 > 10 — refused rather than overshooting the ceiling
    expect(b.admit(1, 1).reason).toBe('max-tool-calls')
  })

  test('a reserve is required so the last agent cannot overshoot the cap', () => {
    const b = budget() // maxCostUSD 1, reserve = 1/5 = 0.2
    // under the headroom threshold: fine
    b.chargeSpend(0.5) // 0.5 + 0.2 <= 1
    expect(b.admit(1, 1).allowed).toBe(true)
    // past it: refused before the agent could overshoot the ceiling
    b.chargeSpend(0.35) // 0.85 + 0.2 > 1
    expect(b.admit(1, 1).reason).toBe('cost')
  })

  test('wall clock expires the mission', () => {
    const b = budget() // 60s
    b.admit(1, 1)
    clock += 61_000
    const r = b.admit(1, 1)
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('wall-clock')
  })

  test('assertCanContinue throws a typed error once exhausted', () => {
    const b = budget()
    b.admit(5, 1)
    expect(() => b.assertCanContinue()).toThrow(MissionBudgetExhausted)
  })
})

describe('§8: cancellation propagates to the whole tree', () => {
  test('cancelling the root stops every derived handle', () => {
    const root = budget()
    const child = root.derive(2)
    const grandchild = child.derive(3)
    root.cancel()
    expect(child.isCancelled()).toBe(true)
    expect(grandchild.isCancelled()).toBe(true)
    expect(grandchild.admit(1, 3).allowed).toBe(false)
  })

  test('a cancelled mission reports why', () => {
    const b = budget()
    b.cancel()
    expect(b.admit(1, 1).reason).toBe('finished')
  })
})

describe('§8: ambient mission is found rather than re-created', () => {
  test('a nested call finds the parent budget via the ambient handle', () => {
    const root = budget()
    setAmbientMission(root)
    expect(getAmbientMission()).toBe(root)
  })

  test('withAmbientMission restores the previous handle afterwards', async () => {
    const outer = budget()
    const inner = new MissionBudget({ caps, now: () => clock })
    await withAmbientMission(outer, async () => {
      expect(getAmbientMission()).toBe(outer)
      await withAmbientMission(inner, async () => {
        expect(getAmbientMission()).toBe(inner)
      })
      expect(getAmbientMission()).toBe(outer)
    })
    expect(getAmbientMission()).toBeUndefined()
  })

  test('withAmbientMission restores the handle even when the body throws', async () => {
    const outer = budget()
    await expect(
      withAmbientMission(outer, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(getAmbientMission()).toBeUndefined()
  })
})

describe('§8: snapshot is auditable', () => {
  test('snapshot reports caps, usage, elapsed and any blocking cap', () => {
    const b = budget()
    b.admit(2, 2)
    b.chargeSpend(0.1)
    clock += 5_000
    const snap = b.snapshot()
    expect(snap.missionID).toBe(b.missionID)
    expect(snap.usage.agents).toBe(2)
    expect(snap.usage.costUSD).toBeCloseTo(0.1, 6)
    expect(snap.elapsedMs).toBe(5_000)
    expect(snap.blockedBy).toBeUndefined()
  })

  test('a blocked mission names the cap that is stopping it', () => {
    const b = budget()
    b.admit(5, 1)
    expect(b.snapshot().blockedBy).toBe('max-agents')
  })

  test('defaults are sane and finite', () => {
    const d = DEFAULT_MISSION_CAPS
    for (const v of Object.values(d)) {
      expect(Number.isFinite(v), String(v)).toBe(true)
      expect(v, String(v)).toBeGreaterThan(0)
    }
  })
})
