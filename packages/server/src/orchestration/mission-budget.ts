/**
 * Orchestration — mission budget (§8).
 *
 * §8 of docs/LONG_TERM_RISK_AND_SCALABILITY_PLAN.md:
 *   "The orchestration tool limits task count and parallelism, but local caps do
 *    not guarantee a bounded overall mission." and "A task that exceeds its
 *    budget must stop or request approval. It must not spawn additional tasks to
 *    evade its parent budget."
 *
 * What was actually true: `orchestrateSchema` capped a single call at 12 tasks,
 * and `budgetSteps` was declared on every task but enforced nowhere — grep found
 * it only in the schema and the tool description. Nothing was shared, so a
 * mission was bounded by nothing except whatever the caller typed:
 *
 *   orchestrate(12) → each child orchestrate(12) → 144 agents, each with a
 *   full fresh allowance, and the parent budget never moved.
 *
 * This is the fix, and its whole design is the anti-evasion property: a nested
 * orchestrate call INHERITS its parent's MissionBudget instead of creating a new
 * one. Aggregate counters are therefore per-mission, not per-call, so spawning
 * more work always charges the same budget that would otherwise be evaded.
 *
 * Admission is decided BEFORE any agent runs (admit()), so a refused spawn costs
 * nothing — the check cannot be raced by doing the work and reconciling after.
 */

export interface MissionBudgetCaps {
  /** Total agents spawnable across the whole mission tree, including the root. */
  maxAgents: number
  /** Maximum nesting depth. Root task = depth 1. */
  maxDepth: number
  /** Total retries across the mission. */
  maxRetries: number
  /** Shared wall clock for the mission, ms. */
  maxWallClockMs: number
  /** Shared spend for the mission, USD. */
  maxCostUSD: number
  /** Total tool calls across the mission. */
  maxToolCalls: number
  /**
   * Headroom required before admitting one more agent, in USD.
   *
   * Checking only "is the cap reached yet" lets the final agent overshoot it,
   * because its cost is unknown until it has run. Admission therefore reserves
   * this much, the same reserve-before-spend discipline as the durable budget
   * ledger in evolution/budget-ledger.ts.
   */
  costReservePerAgent?: number
  /** As above, for tool calls. */
  toolCallReservePerAgent?: number
}

export const DEFAULT_MISSION_CAPS: MissionBudgetCaps = {
  maxAgents: 48,
  maxDepth: 4,
  maxRetries: 12,
  maxWallClockMs: 30 * 60_000,
  maxCostUSD: 5,
  maxToolCalls: 500,
  // costReservePerAgent / toolCallReservePerAgent are intentionally left
  // undefined here and derived per-instance in withDerivedReserves(). Baking
  // concrete numbers into the defaults made them win the spread below, so a
  // caller that overrode maxAgents kept a reserve sized for the default 48 —
  // which refused every admission against a smaller budget.
}

/** Fill in derived per-agent reserves when a caller overrides the totals. */
function withDerivedReserves(caps: MissionBudgetCaps): MissionBudgetCaps {
  const out: MissionBudgetCaps = { ...caps }
  if (out.costReservePerAgent === undefined) {
    out.costReservePerAgent = out.maxCostUSD / Math.max(1, out.maxAgents)
  }
  if (out.toolCallReservePerAgent === undefined) {
    out.toolCallReservePerAgent = Math.ceil(out.maxToolCalls / Math.max(1, out.maxAgents))
  }
  return out
}

export interface MissionUsage {
  agents: number
  retries: number
  costUSD: number
  toolCalls: number
  startedAt: number
  /** Deepest nesting level reached so far. */
  maxDepthSeen: number
}

export type DenialReason =
  'max-agents' | 'max-depth' | 'max-retries' | 'wall-clock' | 'cost' | 'max-tool-calls' | 'finished'

export interface AdmissionDecision {
  allowed: boolean
  reason?: DenialReason
  /** Human-readable explanation, safe to surface to the agent. */
  detail?: string
  /** Usage after a successful admission. */
  usage?: MissionUsage
}

export class MissionBudgetExhausted extends Error {
  constructor(
    readonly reason: DenialReason,
    message: string,
  ) {
    super(message)
    this.name = 'MissionBudgetExhausted'
  }
}

export interface MissionBudgetOptions {
  missionID?: string
  caps?: Partial<MissionBudgetCaps>
  now?: () => number
  /** Shared sink so nested budgets report into the same place. */
  onCharge?: (u: MissionUsage) => void
}

/**
 * One budget for an entire mission tree. Children inherit the SAME instance —
 * see derive(), which is deliberately the only way to get a child budget.
 */
/** Mutable state shared by every budget handle in one mission tree. */
interface SharedState {
  usage: MissionUsage
  cancelled: boolean
}

export class MissionBudget {
  readonly missionID: string
  readonly caps: MissionBudgetCaps
  readonly depth: number
  private readonly shared: SharedState
  private readonly now: () => number
  private readonly onCharge?: (u: MissionUsage) => void

  constructor(opts: MissionBudgetOptions & { shared?: SharedState; depth?: number } = {}) {
    this.missionID = opts.missionID ?? `mission_${Math.random().toString(36).slice(2, 10)}`
    this.caps = withDerivedReserves({ ...DEFAULT_MISSION_CAPS, ...(opts.caps ?? {}) })
    this.depth = opts.depth ?? 1
    this.now = opts.now ?? (() => Date.now())
    this.onCharge = opts.onCharge
    // A derived handle adopts its parent's SharedState, which is what makes the
    // counters aggregate across the whole tree instead of resetting per call.
    this.shared = opts.shared ?? {
      usage: {
        agents: 0,
        retries: 0,
        costUSD: 0,
        toolCalls: 0,
        startedAt: this.now(),
        maxDepthSeen: 0,
      },
      cancelled: false,
    }
  }

  /**
   * A handle for a child at `depth`, sharing this mission's counters. This is
   * the anti-evasion mechanism: a nested orchestrate call cannot obtain a fresh
   * allowance, because `derive()` deliberately takes no caps argument.
   */
  derive(depth: number): MissionBudget {
    const child = new MissionBudget({
      missionID: this.missionID,
      caps: this.caps,
      now: this.now,
      shared: this.shared,
      depth,
    })
    // preserve the parent's charge hook for observability
    if (this.onCharge) Object.assign(child, { onCharge: this.onCharge })
    return child
  }

  getUsage(): MissionUsage {
    return { ...this.shared.usage }
  }

  getCaps(): MissionBudgetCaps {
    return { ...this.caps }
  }

  /** Elapsed mission wall clock, ms. */
  elapsedMs(): number {
    return this.now() - this.shared.usage.startedAt
  }

  isExhausted(): boolean {
    return this.check().reason !== undefined
  }

  /** Cancel the whole mission — propagates because counters/cancel are shared. */
  cancel(): void {
    this.shared.cancelled = true
  }

  isCancelled(): boolean {
    return this.shared.cancelled
  }

  /** The cap that would block right now, if any. */
  private check(): AdmissionDecision {
    const s = this.shared
    if (s.cancelled) return { allowed: false, reason: 'finished', detail: 'mission was cancelled' }
    const u = s.usage
    if (u.agents >= this.caps.maxAgents) {
      return {
        allowed: false,
        reason: 'max-agents',
        detail: `mission agent budget exhausted (${u.agents}/${this.caps.maxAgents})`,
      }
    }
    if (u.retries >= this.caps.maxRetries) {
      return {
        allowed: false,
        reason: 'max-retries',
        detail: `mission retry budget exhausted (${u.retries}/${this.caps.maxRetries})`,
      }
    }
    const costReserve = this.caps.costReservePerAgent ?? 0
    if (u.costUSD + costReserve > this.caps.maxCostUSD) {
      return {
        allowed: false,
        reason: 'cost',
        detail: `mission cost budget exhausted: $${u.costUSD.toFixed(3)} spent + $${costReserve.toFixed(3)} reserve > $${this.caps.maxCostUSD.toFixed(2)} cap`,
      }
    }
    const callReserve = this.caps.toolCallReservePerAgent ?? 0
    if (u.toolCalls + callReserve > this.caps.maxToolCalls) {
      return {
        allowed: false,
        reason: 'max-tool-calls',
        detail: `mission tool-call budget exhausted: ${u.toolCalls} used + ${callReserve} reserve > ${this.caps.maxToolCalls}`,
      }
    }
    if (this.elapsedMs() >= this.caps.maxWallClockMs) {
      return {
        allowed: false,
        reason: 'wall-clock',
        detail: `mission wall clock exhausted (${Math.round(this.elapsedMs() / 1000)}s/${Math.round(this.caps.maxWallClockMs / 1000)}s)`,
      }
    }
    return { allowed: true }
  }

  /**
   * Reserve `count` agent slots at `depth`. Throws MissionBudgetExhausted when
   * refused, so a caller cannot accidentally continue on a denied admission.
   */
  admit(count: number, depth: number): AdmissionDecision {
    const n = Math.max(1, Math.floor(count))
    if (depth > this.caps.maxDepth) {
      return {
        allowed: false,
        reason: 'max-depth',
        detail: `nesting depth ${depth} exceeds mission maximum ${this.caps.maxDepth}`,
      }
    }
    const s = this.shared
    if (s.usage.agents + n > this.caps.maxAgents) {
      return {
        allowed: false,
        reason: 'max-agents',
        detail: `requesting ${n} agent(s) would exceed the mission budget (${s.usage.agents}/${this.caps.maxAgents})`,
      }
    }
    const base = this.check()
    if (!base.allowed) return base

    s.usage.agents += n
    s.usage.maxDepthSeen = Math.max(s.usage.maxDepthSeen, depth)
    this.onCharge?.({ ...s.usage })
    return { allowed: true, usage: this.getUsage() }
  }

  /** Throw if the mission is already over budget (checked before big work). */
  assertCanContinue(): void {
    const r = this.check()
    if (!r.allowed)
      throw new MissionBudgetExhausted(r.reason!, r.detail ?? 'mission budget exhausted')
  }

  /** Record spend against the shared mission budget. */
  chargeSpend(costUSD: number): void {
    if (!Number.isFinite(costUSD) || costUSD <= 0) return
    const s = this.shared
    s.usage.costUSD += costUSD
    this.onCharge?.({ ...s.usage })
  }

  chargeToolCalls(n = 1): void {
    const s = this.shared
    s.usage.toolCalls += Math.max(0, Math.floor(n))
    this.onCharge?.({ ...s.usage })
  }

  /**
   * Reserve `count` retries. Refused when the mission has none left, so a
   * failing child cannot retry its way past the cap.
   */
  admitRetries(count: number): AdmissionDecision {
    const n = Math.max(1, Math.floor(count))
    const s = this.shared
    if (s.usage.retries + n > this.caps.maxRetries) {
      return {
        allowed: false,
        reason: 'max-retries',
        detail: `requesting ${n} retry(ies) would exceed the mission budget (${s.usage.retries}/${this.caps.maxRetries})`,
      }
    }
    s.usage.retries += n
    this.onCharge?.({ ...s.usage })
    return { allowed: true, usage: this.getUsage() }
  }

  /** Snapshot for an audit record / progress report. */
  snapshot(): {
    missionID: string
    caps: MissionBudgetCaps
    usage: MissionUsage
    elapsedMs: number
    cancelled: boolean
    blockedBy?: DenialReason
  } {
    const blocked = this.check().reason
    return {
      missionID: this.missionID,
      caps: this.getCaps(),
      usage: this.getUsage(),
      elapsedMs: this.elapsedMs(),
      cancelled: this.isCancelled(),
      ...(blocked ? { blockedBy: blocked } : {}),
    }
  }
}

/**
 * Per-thread current mission, so a nested orchestrate call finds the budget its
 * parent is already charging rather than starting a new one. This is the other
 * half of the anti-evasion property: even if a caller forgets to pass the budget
 * explicitly, the ambient one is found.
 */
let ambient: MissionBudget | undefined

export function setAmbientMission(b: MissionBudget | undefined): void {
  ambient = b
}

export function getAmbientMission(): MissionBudget | undefined {
  return ambient
}

/** Run `fn` with `b` as the ambient mission (restores the previous one). */
export async function withAmbientMission<T>(b: MissionBudget, fn: () => Promise<T>): Promise<T> {
  const prev = ambient
  ambient = b
  try {
    return await fn()
  } finally {
    ambient = prev
  }
}
