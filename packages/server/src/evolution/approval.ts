/**
 * Approval Gate — §18 human approval boundaries (P0) per MIRA_WEAKNESSES_AND_OBSTACLES.md:18 + :23
 *
 * §18 Level 5 (Autonomous) allows promoting LOW-risk improvements "within
 * strict policy" — auto-approval of low-risk IS that policy, and it is now
 * explicit + configurable: MIRA_APPROVAL_AUTO_LOW=0 (or autoApproveLowRisk:
 * false) requires an explicit authenticated POST /evolution/approve/:id even
 * for low risk. Medium risk auto-approves ONLY with allowMockApproval and the
 * result is non-authoritative; HIGH risk ALWAYS waits for a real human.
 *
 * Documentation Maintenance — 10 items:
 * | # | Item | Status | Evidence |
 * |---|------|--------|----------|
 * | 1 | Implementation path | Implemented | packages/server/src/evolution/approval.ts |
 * | 2 | Public interfaces | Implemented | ApprovalGate.requestApproval(proposal, level): {approved, approver?, pending?, authoritative?, policyAuto?, approverKind?} + approve/deny(identity) |
 * | 3 | Events | Implemented | emits evolution.approval BusEvent |
 * | 4 | Configuration | Implemented | MIRA_APPROVAL_AUTO_LOW (default on = §18 Level 5; '0' → explicit approval for low risk too); MIRA_OPERATORS (comma-separated designated human operators — when set, ONLY they may approve/deny; unset → any authenticated non-author human is the operator, single-operator deployments); MIRA_NO_AUTOPROVISION respected |
 * | 5 | Tests | Implemented | evolution/*.test.ts approval + phase2 low-risk policy-off test + operator restriction + restart survival |
 * | 6 | Security boundaries | Implemented | fail-closed: unknown id denies, approver must be authenticated and must not be the proposal's own author, only designated operators approve when configured, mock approvals are non-authoritative |
 * | 7 | Operational procedures | Implemented | approve via POST /evolution/approve/:id |
 * | 8 | Migration strategy | Implemented | additive; durable store optional (SQLite evolution_approvals, write-through) — the operator's pending queue survives restarts |
 * | 9 | Rollback strategy | Implemented | clear pending, drop table; in-memory mode unchanged without a store |
 * | 10 | Known limitations | Implemented | no human UI yet (operator approves via API); two-person rule for high risk is Target; real human UI Target Phase 6 |
 */

import type { Bus } from '../bus/index.js'
import type { JsonValue } from '../types/index.js'
import type { ImprovementProposal } from './proposal.js'
import type { RiskAssessment } from './risk.js'
import { requiresApproval, AutonomyLevels } from './autonomy.js'
import { appendDecision } from '../learning/ledger.js'
import type { MiraDB } from '../storage/db.js'
import { createHash } from 'node:crypto'

export interface ApprovalRequest {
  id: string // proposal.id
  level: number
  risk: RiskAssessment
  proposal: ImprovementProposal
  requestedAt: number
  status: 'pending' | 'approved' | 'denied'
  approver?: string
  /** Two-person rule: distinct operator approvals collected so far. */
  approvers?: string[]
  /** How many distinct operator approvals this request needs (1 unless the
   *  two-person rule applies to this risk tier). */
  requiredApprovals?: number
  /** §18 meta-rule: fingerprint of the approval policy in force when this was
   *  raised. If the policy changes while the request pends, the decision must
   *  be re-evaluated under the NEW rules rather than the ones it was raised
   *  under — a policy edit can never smuggle an approval through. */
  policyFingerprint?: string
}

export interface ApprovalResult {
  approved: boolean
  approver?: string
  reason?: string
  pending?: boolean
  /**
   * Whether this decision may authorize a high-risk change. A mock or
   * unauthenticated approval is never authoritative, however `approved` reads.
   */
  authoritative?: boolean
  /** True when approved by §18 Level 5 low-risk policy rather than a human. */
  policyAuto?: boolean
  /** Who/what made the decision: a designated human operator, policy, or mock. */
  approverKind?: 'human-operator' | 'policy' | 'mock'
  /** Two-person rule: distinct operators that approved (mirrors request). */
  approvers?: string[]
  requiredApprovals?: number
}

/**
 * Identity of the decision-maker. §5 requires "a real, authenticated human
 * decision" and forbids a mock being represented as one.
 */
export interface ApproverIdentity {
  /** The authenticated owner resolved from the caller's credentials. */
  owner: string
  /** True only when `owner` came from verified credentials. */
  authenticated: boolean
}

/**
 * Durable approval state — the operator's pending queue must survive a
 * restart: silently forgetting what a human was asked to approve is both an
 * operational stall and an audit hole. Fail-soft at call sites.
 */
export interface ApprovalStore {
  loadPending(): ApprovalRequest[]
  loadDecided(): Array<{ id: string; result: ApprovalResult }>
  savePending(req: ApprovalRequest): void
  deletePending(id: string): void
  saveDecided(id: string, result: ApprovalResult): void
}

/** SQLite-backed store — write-through, fail-soft at the call sites. */
export function createSqliteApprovalStore(db: MiraDB): ApprovalStore {
  const sqlite = db.sqlite
  if (!sqlite) throw new Error('no sqlite handle')
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS evolution_approvals (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS evolution_approvals_kind_idx ON evolution_approvals(kind);
  `)
  const upsert = sqlite.prepare(
    `INSERT OR REPLACE INTO evolution_approvals (id, kind, payload, updated_at) VALUES (?, ?, ?, ?)`,
  )
  return {
    loadPending() {
      try {
        const rows = sqlite
          .prepare(`SELECT payload FROM evolution_approvals WHERE kind = 'pending'`)
          .all() as Array<{ payload: string }>
        return rows.map((r) => JSON.parse(r.payload) as ApprovalRequest)
      } catch {
        return []
      }
    },
    loadDecided() {
      try {
        const rows = sqlite
          .prepare(`SELECT id, payload FROM evolution_approvals WHERE kind = 'decided'`)
          .all() as Array<{ id: string; payload: string }>
        return rows.map((r) => ({ id: r.id, result: JSON.parse(r.payload) as ApprovalResult }))
      } catch {
        return []
      }
    },
    savePending(req) {
      try {
        upsert.run(req.id, 'pending', JSON.stringify(req), Date.now())
      } catch {}
    },
    deletePending(id) {
      try {
        sqlite.prepare(`DELETE FROM evolution_approvals WHERE id = ? AND kind = 'pending'`).run(id)
      } catch {}
    },
    saveDecided(id, result) {
      try {
        upsert.run(id, 'decided', JSON.stringify(result), Date.now())
      } catch {}
    },
  }
}

/** Whoever produced the proposal — used to forbid self-approval. */
function proposalAuthor(proposal: ImprovementProposal): string | undefined {
  const p = proposal as unknown as {
    author?: unknown
    by?: unknown
    agent?: unknown
    painPointId?: unknown
  }
  for (const v of [p.author, p.by, p.agent]) {
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
}

/** §18 meta-rule: stable fingerprint of the active approval policy. Any change
 *  to the rules (autoLowRisk / operators / two-person rule) invalidates in-flight
 *  approvals raised under the old rules — a policy edit cannot be used to let a
 *  pending high-risk change through. */
export function policyFingerprint(p: {
  autoApproveLowRisk: boolean
  operators: string[] | null
  twoPersonRule: boolean
}): string {
  const canonical = JSON.stringify({
    a: p.autoApproveLowRisk,
    o: p.operators ? [...p.operators].sort() : null,
    t: p.twoPersonRule,
  })
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

export class ApprovalGate {
  private bus?: Bus
  private pending = new Map<string, ApprovalRequest>()
  private rootDir?: string
  private allowMockApproval: boolean
  private autoApproveLowRisk: boolean
  /** Designated human operators — when set, ONLY they may approve/deny. */
  private operators: Set<string> | null
  /** Completed decisions, so a replay returns the recorded answer. */
  private decided = new Map<string, ApprovalResult>()
  private twoPersonRule: boolean
  private agingMs: number
  /** Aging dedupe: id → last emission bucket, so a pending item notifies once
   *  per aging window, not on every queue read. */
  private agingEmitted = new Map<string, number>()
  private store?: ApprovalStore

  /** §18 meta-rule: fingerprint of the policy in force right now. Requests
   *  stamp it; approve/deny refuse when it no longer matches. */
  private fingerprint: string = 'unset'

  /** Recompute + swap the policy fingerprint; existing pending requests keep
   *  their stale stamp and will be refused on decision until re-raised. */
  refreshPolicy(): void {
    this.fingerprint = policyFingerprint({
      autoApproveLowRisk: this.autoApproveLowRisk,
      operators: this.operators ? [...this.operators].sort() : null,
      twoPersonRule: this.twoPersonRule,
    })
  }

  /** Current policy fingerprint — exposed so the UI can show which rules a
   *  pending decision was raised under. */
  policyFingerprint(): string {
    return this.fingerprint
  }

  /**
   * @param allowMockApproval when true, medium-risk approvals may be
   * auto-granted by a mock approver. OFF by default, and even then the result
   * is marked `authoritative: false` so it cannot authorize a high-risk change.
   * @param autoApproveLowRisk §18 Level 5 policy: low-risk improvements may be
   * promoted autonomously. Default reads MIRA_APPROVAL_AUTO_LOW (on unless
   * '0'); when OFF, even low risk waits for an authenticated human approval.
   * @param operators designated human operators. Default reads MIRA_OPERATORS
   * (comma-separated). When configured, ONLY listed operators may approve/deny
   * (fail-closed for everyone else); when unset, any authenticated human who
   * is not the proposal author is the operator — single-operator deployments.
   * @param twoPersonRule high-risk changes need approvals from 2 distinct
   * operators (author excluded). Default: on when ≥2 operators are designated;
   * auto-off for single-operator deployments (a quorum of 1 is a deadlock,
   * not a rule). Override via config approvals.twoPersonRule.
   * @param agingMs pending-approval aging notification threshold (default 1h).
   * @param store durable approval state (pending queue + decided replay).
   */
  constructor(opts?: {
    bus?: Bus
    rootDir?: string
    allowMockApproval?: boolean
    autoApproveLowRisk?: boolean
    operators?: string[] | null
    twoPersonRule?: boolean
    agingMs?: number
    store?: ApprovalStore
  }) {
    this.bus = opts?.bus
    this.rootDir = opts?.rootDir
    this.allowMockApproval = opts?.allowMockApproval ?? false
    this.autoApproveLowRisk = opts?.autoApproveLowRisk ?? process.env.MIRA_APPROVAL_AUTO_LOW !== '0'
    const opRaw =
      opts?.operators !== undefined
        ? opts.operators
        : process.env.MIRA_OPERATORS
          ? process.env.MIRA_OPERATORS.split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : null
    this.operators = opRaw && opRaw.length > 0 ? new Set(opRaw) : null
    // Two-person rule default: on when ≥2 operators are designated — with a
    // single operator a quorum of 2 is a deadlock, not a rule.
    this.twoPersonRule = opts?.twoPersonRule ?? (this.operators?.size ?? 0) >= 2
    this.agingMs = opts?.agingMs ?? 3_600_000
    this.refreshPolicy()
    if (opts?.store) {
      this.store = opts.store
      try {
        for (const req of this.store.loadPending()) this.pending.set(req.id, req)
        for (const { id, result } of this.store.loadDecided()) this.decided.set(id, result)
      } catch {}
    }
  }

  requestApproval(
    proposal: ImprovementProposal,
    level: number,
    risk?: RiskAssessment,
  ): ApprovalResult {
    const r: RiskAssessment = risk ?? {
      level: (proposal.risk as RiskAssessment['level']) ?? 'low',
      score: 0.3,
      reasons: ['proposal.risk fallback'],
    }
    const needs = requiresApproval(level as AutonomyLevels, r)

    // low-risk not needing approval → §18 Level 5 auto-approval (configurable)
    if (!needs) {
      if (!this.autoApproveLowRisk) {
        // Stricter policy: no autonomous promotion at all — every change
        // requires an explicit authenticated human decision (§18 default hardening).
        const req: ApprovalRequest = {
          id: proposal.id,
          level,
          risk: r,
          proposal,
          requestedAt: Date.now(),
          status: 'pending',
        }
        this.pending.set(proposal.id, req)
        try {
          this.store?.savePending(req)
        } catch {}
        this.emit(proposal, level, r, 'pending', undefined)
        return {
          approved: false,
          pending: true,
          reason:
            'low-risk approval required by policy (MIRA_APPROVAL_AUTO_LOW=0) — POST /evolution/approve/:id',
        }
      }
      this.emit(proposal, level, r, 'approved', 'auto')
      return {
        approved: true,
        approver: 'auto',
        // A policy decision is not a human decision — it never counts as
        // `authoritative` (that is reserved for authenticated humans, §5/§18);
        // `policyAuto` marks that it proceeded via §18 Level 5 low-risk policy.
        authoritative: false,
        policyAuto: true,
        approverKind: 'policy',
        reason: 'low-risk auto-approved per §18 Level 5 (MIRA_APPROVAL_AUTO_LOW unset/1)',
      }
    }

    // For mock human: low/medium auto-approved, high stays pending
    // But per requiresApproval, high already needs approval → we keep it pending to exercise POST /evolution/approve/:id
    // For medium at canary, also pending
    // High risk ALWAYS waits for a real human, whatever the mock setting.
    // With the two-person rule on, TWO distinct operators must approve.
    if (r.level === 'high') {
      const req: ApprovalRequest = {
        id: proposal.id,
        level,
        risk: r,
        proposal,
        requestedAt: Date.now(),
        status: 'pending',
        approvers: [],
        requiredApprovals: this.twoPersonRule ? 2 : 1,
        policyFingerprint: this.fingerprint,
      }
      this.pending.set(proposal.id, req)
      try {
        this.store?.savePending(req)
      } catch {}
      this.emit(proposal, level, r, 'pending', undefined)
      return {
        approved: false,
        pending: true,
        requiredApprovals: req.requiredApprovals,
        approvers: [],
        reason:
          (req.requiredApprovals ?? 1) > 1
            ? 'high-risk requires TWO distinct operator approvals (two-person rule) — POST /evolution/approve/:id per operator'
            : 'high-risk requires an authenticated human approval — POST /evolution/approve/:id',
      }
    }

    // Medium risk at Canary or above: pending unless a mock is explicitly
    // enabled. The mock result is marked non-authoritative so it can never be
    // mistaken for a human decision on a high-risk change.
    if (r.level === 'medium' && level >= AutonomyLevels.Canary) {
      if (this.allowMockApproval) {
        this.emit(proposal, level, r, 'approved', 'mock-human')
        return {
          approved: true,
          approver: 'mock-human',
          authoritative: false,
          approverKind: 'mock',
          reason: 'mock human approved (medium risk) — not authoritative for high-risk changes',
        }
      }
      const req: ApprovalRequest = {
        id: proposal.id,
        level,
        risk: r,
        proposal,
        requestedAt: Date.now(),
        status: 'pending',
      }
      this.pending.set(proposal.id, req)
      try {
        this.store?.savePending(req)
      } catch {}
      this.emit(proposal, level, r, 'pending', undefined)
      return {
        approved: false,
        pending: true,
        reason: 'approval required — no mock approver is configured; POST /evolution/approve/:id',
      }
    }

    // Reached when approval is required for a reason not covered above. Stay
    // pending rather than inventing an approver.
    const req: ApprovalRequest = {
      id: proposal.id,
      level,
      risk: r,
      proposal,
      requestedAt: Date.now(),
      status: 'pending',
    }
    this.pending.set(proposal.id, req)
    try {
      this.store?.savePending(req)
    } catch {}
    this.emit(proposal, level, r, 'pending', undefined)
    return {
      approved: false,
      pending: true,
      reason: 'approval required — POST /evolution/approve/:id',
    }
  }

  approve(id: string, identity: ApproverIdentity): ApprovalResult {
    const prior = this.decided.get(id)
    if (prior) return { ...prior, reason: `${prior.reason ?? 'decided'} (recorded decision)` }

    const req = this.pending.get(id)
    if (!req) {
      return {
        approved: false,
        reason: `no pending approval request for ${id} — nothing to approve`,
      }
    }

    if (!identity?.authenticated) {
      return {
        approved: false,
        pending: true,
        reason: 'approval rejected: approver identity is not authenticated',
      }
    }

    // §18 meta-rule: the approval policy changed while this request was
    // pending — decide nothing under stale rules; the change must be re-raised
    // so the operator sees the new policy on the case.
    if (req.policyFingerprint && req.policyFingerprint !== this.fingerprint) {
      return {
        approved: false,
        pending: true,
        reason:
          'approval refused: the approval policy changed while this request was pending — re-raise the proposal to be decided under the current rules (meta-rule)',
      }
    }

    const approver = identity.owner
    const author = proposalAuthor(req.proposal)
    if (author && approver === author) {
      return {
        approved: false,
        pending: true,
        reason: `approval rejected: "${approver}" authored this proposal and may not approve it`,
      }
    }
    // The operator is the approval authority: when designated operators are
    // configured, only they may approve (fail-closed for everyone else).
    if (this.operators && !this.operators.has(approver)) {
      return {
        approved: false,
        pending: true,
        reason: `approval rejected: "${approver}" is not a designated operator (MIRA_OPERATORS)`,
      }
    }

    // Two-person rule (§18: high-risk needs stronger approval): collect
    // DISTINCT operator approvals until the quorum is met. Duplicate approvals
    // from the same operator do not count twice, and the required count is
    // recorded on the request so the UI can show "1 of 2".
    const required = req.requiredApprovals ?? 1
    const collected = new Set(req.approvers ?? [])
    if (required > 1) {
      if (collected.has(approver)) {
        return {
          approved: false,
          pending: true,
          approvers: [...collected],
          requiredApprovals: required,
          reason: `two-person rule: "${approver}" already approved — waiting for ${required - collected.size} more distinct operator(s)`,
        }
      }
      collected.add(approver)
      req.approvers = [...collected]
      if (collected.size < required) {
        try {
          this.store?.savePending(req)
        } catch {}
        return {
          approved: false,
          pending: true,
          approvers: [...collected],
          requiredApprovals: required,
          reason: `two-person rule: ${collected.size} of ${required} operator approvals recorded — waiting for ${required - collected.size} more`,
        }
      }
    }

    req.status = 'approved'
    req.approver = approver
    this.emit(req.proposal, req.level, req.risk, 'approved', approver)
    this.pending.delete(id)
    try {
      this.store?.deletePending(id)
    } catch {}
    // Decision log — why approved, with risk evidence; the human operator is
    // the authority of record. Two-person rule records both operators.
    try {
      appendDecision(
        {
          decision: 'approval:approved',
          context:
            required > 1
              ? `Proposal ${id} (level ${req.level}) approved by human operators ${req.approvers?.join(' + ')} (two-person rule)`
              : `Proposal ${id} (level ${req.level}) approved by human operator ${approver}`,
          by: approver,
          evidence: req.risk.reasons ?? [],
          alternatives: ['deny', 'keep pending'],
        },
        this.rootDir,
      )
    } catch {}
    const result: ApprovalResult = {
      approved: true,
      approver,
      authoritative: true,
      approverKind: 'human-operator',
      ...(required > 1 ? { approvers: [...collected], requiredApprovals: required } : {}),
      reason:
        required > 1
          ? 'approved by human operators (two-person rule)'
          : 'approved by human operator',
    }
    this.decided.set(id, result)
    try {
      this.store?.saveDecided(id, result)
    } catch {}
    return result
  }

  deny(id: string, identity: ApproverIdentity): ApprovalResult {
    if (!identity?.authenticated) {
      return { approved: false, reason: 'denial rejected: approver identity is not authenticated' }
    }
    const approver = identity.owner
    // Same operator restriction as approve() — only designated operators.
    if (this.operators && !this.operators.has(approver)) {
      return {
        approved: false,
        reason: `denial rejected: "${approver}" is not a designated operator (MIRA_OPERATORS)`,
      }
    }
    // Same meta-rule as approve(): a policy edit mid-flight invalidates the
    // case, so a denial cannot be recorded under stale rules either.
    const req = this.pending.get(id)
    if (!req) return { approved: false, approver, reason: 'no pending' }
    if (req.policyFingerprint && req.policyFingerprint !== this.fingerprint) {
      return {
        approved: false,
        approver,
        reason:
          'denial refused: the approval policy changed while this request was pending (meta-rule)',
      }
    }
    req.status = 'denied'
    req.approver = approver
    this.emit(req.proposal, req.level, req.risk, 'denied', approver)
    this.pending.delete(id)
    try {
      this.store?.deletePending(id)
    } catch {}
    // Decision log — why denied, with risk evidence; operator is the authority.
    try {
      appendDecision(
        {
          decision: 'approval:denied',
          context: `Proposal ${id} (level ${req.level}) denied by human operator ${approver}`,
          by: approver,
          evidence: req.risk.reasons ?? [],
          alternatives: ['approve', 'keep pending'],
        },
        this.rootDir,
      )
    } catch {}
    const result: ApprovalResult = {
      approved: false,
      approver,
      approverKind: 'human-operator',
      reason: 'denied by human operator',
    }
    this.decided.set(id, result)
    try {
      this.store?.saveDecided(id, result)
    } catch {}
    return result
  }

  isPending(id: string): boolean {
    return this.pending.has(id)
  }

  getPending(id: string): ApprovalRequest | undefined {
    return this.pending.get(id)
  }

  listPending(): ApprovalRequest[] {
    return [...this.pending.values()]
  }

  /**
   * Aging notifications (§18 escalation = awareness, never approval): emit
   * `evolution.approval_aging` for pending requests older than the aging
   * threshold. Deduped per id per aging window — a queue read is a notification
   * tick, and re-notify every window while still pending. Called by the
   * approvals endpoint; approval itself stays a human act, a timer never
   * promotes anything.
   */
  checkAging(now = Date.now()): number {
    let emitted = 0
    for (const req of this.pending.values()) {
      const age = now - req.requestedAt
      if (age < this.agingMs) continue
      const bucket = Math.floor(age / this.agingMs)
      if ((this.agingEmitted.get(req.id) ?? 0) >= bucket) continue
      this.agingEmitted.set(req.id, bucket)
      try {
        this.bus?.publish({
          type: 'evolution.approval_aging' as unknown as import('../types/index.js').BusEventType,
          payload: {
            proposalId: req.id,
            title: req.proposal?.title,
            risk: req.risk?.level,
            ageMs: age,
            bucket,
            requiredApprovals: req.requiredApprovals ?? 1,
            approvers: req.approvers ?? [],
            note: 'pending operator approval is aging — escalation is awareness, not approval (§18)',
          } as unknown as JsonValue,
          timestamp: now,
        } as unknown as import('../types/index.js').BusEvent)
        emitted++
      } catch {}
    }
    return emitted
  }

  private emit(
    proposal: ImprovementProposal,
    level: number,
    risk: RiskAssessment,
    status: string,
    approver?: string,
  ) {
    try {
      this.bus?.publish({
        type: 'evolution.approval' as unknown as import('../types/index.js').BusEventType,
        payload: {
          proposalId: proposal.id,
          level,
          risk,
          status,
          approver: approver ?? null,
          timestamp: Date.now(),
        } as unknown as JsonValue,
        timestamp: Date.now(),
      } as unknown as import('../types/index.js').BusEvent)
    } catch {}
  }
}
