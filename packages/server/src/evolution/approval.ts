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
 * | 2 | Public interfaces | Implemented | ApprovalGate.requestApproval(proposal, level): {approved, approver?, pending?, authoritative?, policyAuto?} + approve/deny(identity) |
 * | 3 | Events | Implemented | emits evolution.approval BusEvent |
 * | 4 | Configuration | Implemented | MIRA_APPROVAL_AUTO_LOW (default on = §18 Level 5; '0' → explicit approval for low risk too); MIRA_NO_AUTOPROVISION respected |
 * | 5 | Tests | Implemented | evolution/*.test.ts approval + phase2 low-risk policy-off test |
 * | 6 | Security boundaries | Implemented | fail-closed: unknown id denies, approver must be authenticated and must not be the proposal's own author, mock approvals are non-authoritative |
 * | 7 | Operational procedures | Implemented | approve via POST /evolution/approve/:id |
 * | 8 | Migration strategy | Implemented | additive, in-memory pending store; default unchanged for existing callers |
 * | 9 | Rollback strategy | Implemented | clear pending, no DB |
 * | 10 | Known limitations | Implemented | no human UI yet (approve/deny via API); real human UI Target Phase 6 |
 */

import type { Bus } from '../bus/index.js'
import type { JsonValue } from '../types/index.js'
import type { ImprovementProposal } from './proposal.js'
import type { RiskAssessment } from './risk.js'
import { requiresApproval, AutonomyLevels } from './autonomy.js'
import { appendDecision } from '../learning/ledger.js'

export interface ApprovalRequest {
  id: string // proposal.id
  level: number
  risk: RiskAssessment
  proposal: ImprovementProposal
  requestedAt: number
  status: 'pending' | 'approved' | 'denied'
  approver?: string
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

export class ApprovalGate {
  private bus?: Bus
  private pending = new Map<string, ApprovalRequest>()
  private rootDir?: string
  private allowMockApproval: boolean
  private autoApproveLowRisk: boolean
  /** Completed decisions, so a replay returns the recorded answer. */
  private decided = new Map<string, ApprovalResult>()

  /**
   * @param allowMockApproval when true, medium-risk approvals may be
   * auto-granted by a mock approver. OFF by default, and even then the result
   * is marked `authoritative: false` so it cannot authorize a high-risk change.
   * @param autoApproveLowRisk §18 Level 5 policy: low-risk improvements may be
   * promoted autonomously. Default reads MIRA_APPROVAL_AUTO_LOW (on unless
   * '0'); when OFF, even low risk waits for an authenticated human approval.
   */
  constructor(opts?: {
    bus?: Bus
    rootDir?: string
    allowMockApproval?: boolean
    autoApproveLowRisk?: boolean
  }) {
    this.bus = opts?.bus
    this.rootDir = opts?.rootDir
    this.allowMockApproval = opts?.allowMockApproval ?? false
    this.autoApproveLowRisk = opts?.autoApproveLowRisk ?? process.env.MIRA_APPROVAL_AUTO_LOW !== '0'
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
        reason: 'low-risk auto-approved per §18 Level 5 (MIRA_APPROVAL_AUTO_LOW unset/1)',
      }
    }

    // For mock human: low/medium auto-approved, high stays pending
    // But per requiresApproval, high already needs approval → we keep it pending to exercise POST /evolution/approve/:id
    // For medium at canary, also pending
    // High risk ALWAYS waits for a real human, whatever the mock setting.
    if (r.level === 'high') {
      const req: ApprovalRequest = {
        id: proposal.id,
        level,
        risk: r,
        proposal,
        requestedAt: Date.now(),
        status: 'pending',
      }
      this.pending.set(proposal.id, req)
      this.emit(proposal, level, r, 'pending', undefined)
      return {
        approved: false,
        pending: true,
        reason: 'high-risk requires an authenticated human approval — POST /evolution/approve/:id',
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

    const approver = identity.owner
    const author = proposalAuthor(req.proposal)
    if (author && approver === author) {
      return {
        approved: false,
        pending: true,
        reason: `approval rejected: "${approver}" authored this proposal and may not approve it`,
      }
    }

    req.status = 'approved'
    req.approver = approver
    this.emit(req.proposal, req.level, req.risk, 'approved', approver)
    this.pending.delete(id)
    // Decision log — why approved, with risk evidence
    try {
      appendDecision(
        {
          decision: 'approval:approved',
          context: `Proposal ${id} (level ${req.level}) approved by ${approver}`,
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
      reason: 'human approved',
    }
    this.decided.set(id, result)
    return result
  }

  deny(id: string, identity: ApproverIdentity): ApprovalResult {
    if (!identity?.authenticated) {
      return { approved: false, reason: 'denial rejected: approver identity is not authenticated' }
    }
    const approver = identity.owner
    const req = this.pending.get(id)
    if (!req) return { approved: false, approver, reason: 'no pending' }
    req.status = 'denied'
    req.approver = approver
    this.emit(req.proposal, req.level, req.risk, 'denied', approver)
    this.pending.delete(id)
    // Decision log — why denied, with risk evidence
    try {
      appendDecision(
        {
          decision: 'approval:denied',
          context: `Proposal ${id} (level ${req.level}) denied by ${approver}`,
          by: approver,
          evidence: req.risk.reasons ?? [],
          alternatives: ['approve', 'keep pending'],
        },
        this.rootDir,
      )
    } catch {}
    const result: ApprovalResult = { approved: false, approver, reason: 'denied by human' }
    this.decided.set(id, result)
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
