/**
 * Resource Limits — Phase 2 Safety per MIRA_WEAKNESSES_AND_OBSTACLES.md:13 Autonomous Cost Control + :23
 *
 * Per-task / per-agent / per-mission / daily budgets. Keeps nvidia primary + colibri opportunistic.
 *
 * Documentation Maintenance — 10 items:
 * | # | Item | Status | Evidence |
 * |---|------|--------|----------|
 * | 1 | Implementation path | Implemented | packages/server/src/evolution/resources.ts |
 * | 2 | Public interfaces | Implemented | ResourceLimits.checkBudget(proposal, cost): {allowed, reason?} |
 * | 3 | Events | Implemented | emits evolution.budget BusEvent on breach |
 * | 4 | Configuration | Implemented | env MIRA_BUDGET_* + mira.json costCap respected, defaults per §13 |
 * | 5 | Tests | Implemented | evolution/*.test.ts resources |
 * | 6 | Security boundaries | Implemented | fail-closed on breach, no auto-promote |
 * | 7 | Operational procedures | Implemented | check before verifier in POST /evolution/observe |
 * | 8 | Migration strategy | Implemented | additive, in-memory counters, no DB migration |
 * | 9 | Rollback strategy | Implemented | reset counters, revert file |
 * | 10 | Known limitations | Implemented | in-memory only; daily resets on process restart (Phase 6 persistent) |
 */

import type { Bus } from "../bus/index.js"
import type { JsonValue } from "../types/index.js"
import type { ImprovementProposal } from "./proposal.js"

export interface BudgetCaps {
  perTask: number
  perAgent: number
  perMission: number
  daily: number
}

export interface BudgetCheck {
  allowed: boolean
  reason?: string
  caps?: BudgetCaps
  cost?: number
  remaining?: Partial<BudgetCaps>
}

function defaultCaps(): BudgetCaps {
  // per §13 + §16 cost baseline 0.18/task; keep generous defaults so Phase 1 smoke not blocked
  const perTask = Number(process.env.MIRA_BUDGET_PER_TASK ?? process.env.MIRA_COST_CAP_PER_TASK ?? 0.5)
  const perAgent = Number(process.env.MIRA_BUDGET_PER_AGENT ?? 10)
  const perMission = Number(process.env.MIRA_BUDGET_PER_MISSION ?? 20)
  const daily = Number(process.env.MIRA_BUDGET_DAILY ?? 50)
  return {
    perTask: Number.isFinite(perTask) && perTask > 0 ? perTask : 0.5,
    perAgent: Number.isFinite(perAgent) && perAgent > 0 ? perAgent : 10,
    perMission: Number.isFinite(perMission) && perMission > 0 ? perMission : 20,
    daily: Number.isFinite(daily) && daily > 0 ? daily : 50,
  }
}

export class ResourceLimits {
  private caps: BudgetCaps
  private bus?: Bus
  // tracking — in-memory counters per day (Phase 6 would persist)
  private dailySpent = 0
  private dailyKey = new Date().toISOString().slice(0, 10)
  private perAgentSpent = new Map<string, number>()
  private perMissionSpent = new Map<string, number>()

  constructor(opts?: { caps?: Partial<BudgetCaps>; bus?: Bus }) {
    const d = defaultCaps()
    this.caps = { ...d, ...(opts?.caps ?? {}) }
    this.bus = opts?.bus
  }

  checkBudget(
    proposal: Partial<ImprovementProposal> & { cost?: number; agent?: string; missionID?: string },
    cost?: number,
  ): BudgetCheck {
    this.rotateDailyIfNeeded()
    const c = typeof cost === "number" ? cost : typeof proposal.cost === "number" ? proposal.cost : 0.05
    const agent = String((proposal as { agent?: string }).agent ?? proposal.affectedEngine ?? "default")
    const missionID = String((proposal as { missionID?: string }).missionID ?? "default")

    // per-task
    if (c > this.caps.perTask) {
      const reason = `per-task budget exceeded: cost $${c.toFixed(3)} > cap $${this.caps.perTask.toFixed(2)} (per-task)`
      this.emit(proposal, c, reason)
      return { allowed: false, reason, caps: this.caps, cost: c }
    }

    // per-agent
    const agentSpent = this.perAgentSpent.get(agent) ?? 0
    if (agentSpent + c > this.caps.perAgent) {
      const reason = `per-agent budget exceeded: agent "${agent}" would be $${(agentSpent + c).toFixed(3)} > cap $${this.caps.perAgent.toFixed(2)}`
      this.emit(proposal, c, reason)
      return { allowed: false, reason, caps: this.caps, cost: c }
    }

    // per-mission
    const missionSpent = this.perMissionSpent.get(missionID) ?? 0
    if (missionSpent + c > this.caps.perMission) {
      const reason = `per-mission budget exceeded: mission "${missionID}" would be $${(missionSpent + c).toFixed(3)} > cap $${this.caps.perMission.toFixed(2)}`
      this.emit(proposal, c, reason)
      return { allowed: false, reason, caps: this.caps, cost: c }
    }

    // daily
    if (this.dailySpent + c > this.caps.daily) {
      const reason = `daily budget exceeded: daily would be $${(this.dailySpent + c).toFixed(3)} > cap $${this.caps.daily.toFixed(2)} — Pause → Explain → Require approval (§13)`
      this.emit(proposal, c, reason)
      return { allowed: false, reason, caps: this.caps, cost: c }
    }

    // allowed — record spend
    this.dailySpent += c
    this.perAgentSpent.set(agent, agentSpent + c)
    this.perMissionSpent.set(missionID, missionSpent + c)

    return {
      allowed: true,
      caps: this.caps,
      cost: c,
      remaining: {
        perAgent: this.caps.perAgent - (agentSpent + c),
        perMission: this.caps.perMission - (missionSpent + c),
        daily: this.caps.daily - this.dailySpent,
      },
    }
  }

  getCaps(): BudgetCaps { return { ...this.caps } }
  getDailySpent(): number { this.rotateDailyIfNeeded(); return this.dailySpent }
  reset(): void {
    this.dailySpent = 0
    this.perAgentSpent.clear()
    this.perMissionSpent.clear()
  }

  private rotateDailyIfNeeded() {
    const k = new Date().toISOString().slice(0, 10)
    if (k !== this.dailyKey) {
      this.dailyKey = k
      this.dailySpent = 0
      // per-agent/mission also reset daily? keep but clear daily is enough per §13 daily is main; also clear agent/mission for simplicity
      this.perAgentSpent.clear()
      this.perMissionSpent.clear()
    }
  }

  private emit(proposal: Partial<ImprovementProposal>, cost: number, reason: string) {
    try {
      this.bus?.publish({
        type: "evolution.budget" as unknown as import("../types/index.js").BusEventType,
        payload: { proposalId: (proposal as ImprovementProposal).id ?? "unknown", cost, reason, timestamp: Date.now() } as unknown as JsonValue,
        timestamp: Date.now(),
      } as unknown as import("../types/index.js").BusEvent)
    } catch {}
  }
}
