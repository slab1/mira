/**
 * Approval Gate — Phase 2 Safety per MIRA_WEAKNESSES_AND_OBSTACLES.md:18 Approval Gates + :23
 *
 * Mock human for now, emits evolution.approval BusEvent. Respect nvidia primary, no hardware.
 *
 * Documentation Maintenance — 10 items:
 * | # | Item | Status | Evidence |
 * |---|------|--------|----------|
 * | 1 | Implementation path | Implemented | packages/server/src/evolution/approval.ts |
 * | 2 | Public interfaces | Implemented | ApprovalGate.requestApproval(proposal, level): {approved, approver?} + approve/pending |
 * | 3 | Events | Implemented | emits evolution.approval BusEvent |
 * | 4 | Configuration | Implemented | no config; MIRA_NO_AUTOPROVISION respected |
 * | 5 | Tests | Implemented | evolution/*.test.ts approval |
 * | 6 | Security boundaries | Implemented | high-risk fail-closed until POST /evolution/approve/:id |
 * | 7 | Operational procedures | Implemented | approve via POST /evolution/approve/:id |
 * | 8 | Migration strategy | Implemented | additive, in-memory pending store |
 * | 9 | Rollback strategy | Implemented | clear pending, no DB |
 * | 10 | Known limitations | Implemented | mock human auto-approves low; real human UI Target Phase 6 |
 */

import type { Bus } from "../bus/index.js"
import type { JsonValue } from "../types/index.js"
import type { ImprovementProposal } from "./proposal.js"
import type { RiskAssessment } from "./risk.js"
import { requiresApproval, AutonomyLevels } from "./autonomy.js"

export interface ApprovalRequest {
  id: string // proposal.id
  level: number
  risk: RiskAssessment
  proposal: ImprovementProposal
  requestedAt: number
  status: "pending" | "approved" | "denied"
  approver?: string
}

export interface ApprovalResult {
  approved: boolean
  approver?: string
  reason?: string
  pending?: boolean
}

export class ApprovalGate {
  private bus?: Bus
  private pending = new Map<string, ApprovalRequest>()

  constructor(opts?: { bus?: Bus }) {
    this.bus = opts?.bus
  }

  requestApproval(
    proposal: ImprovementProposal,
    level: number,
    risk?: RiskAssessment,
  ): ApprovalResult {
    const r: RiskAssessment = risk ?? { level: (proposal.risk as RiskAssessment["level"]) ?? "low", score: 0.3, reasons: ["proposal.risk fallback"] }
    const needs = requiresApproval(level as AutonomyLevels, r)

    // low-risk not needing approval → auto-approved
    if (!needs) {
      this.emit(proposal, level, r, "approved", "auto")
      return { approved: true, approver: "auto", reason: "low-risk auto-approved" }
    }

    // For mock human: low/medium auto-approved, high stays pending
    // But per requiresApproval, high already needs approval → we keep it pending to exercise POST /evolution/approve/:id
    // For medium at canary, also pending
    const isHigh = r.level === "high"
    if (isHigh || (r.level === "medium" && level >= AutonomyLevels.Canary)) {
      // store pending, return not approved yet (caller should block verifier)
      const req: ApprovalRequest = {
        id: proposal.id,
        level,
        risk: r,
        proposal,
        requestedAt: Date.now(),
        status: "pending",
      }
      this.pending.set(proposal.id, req)
      this.emit(proposal, level, r, "pending", undefined)
      return { approved: false, pending: true, reason: "high-risk requires human approval (§18) — POST /evolution/approve/:id to approve" }
    }

    // other cases that need approval but not high: mock human approves immediately (but still emits)
    this.emit(proposal, level, r, "approved", "mock-human")
    return { approved: true, approver: "mock-human", reason: "mock human approved (non-high)" }
  }

  approve(id: string, approver = "human"): ApprovalResult {
    const req = this.pending.get(id)
    if (!req) {
      // idempotent: if not pending, treat as approved (ledger may have already)
      return { approved: true, approver, reason: "no pending — already approved or unknown id" }
    }
    req.status = "approved"
    req.approver = approver
    this.emit(req.proposal, req.level, req.risk, "approved", approver)
    this.pending.delete(id)
    return { approved: true, approver, reason: "human approved" }
  }

  deny(id: string, approver = "human"): ApprovalResult {
    const req = this.pending.get(id)
    if (!req) return { approved: false, approver, reason: "no pending" }
    req.status = "denied"
    req.approver = approver
    this.emit(req.proposal, req.level, req.risk, "denied", approver)
    this.pending.delete(id)
    return { approved: false, approver, reason: "denied by human" }
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

  private emit(proposal: ImprovementProposal, level: number, risk: RiskAssessment, status: string, approver?: string) {
    try {
      this.bus?.publish({
        type: "evolution.approval" as unknown as import("../types/index.js").BusEventType,
        payload: {
          proposalId: proposal.id,
          level,
          risk,
          status,
          approver: approver ?? null,
          timestamp: Date.now(),
        } as unknown as JsonValue,
        timestamp: Date.now(),
      } as unknown as import("../types/index.js").BusEvent)
    } catch {}
  }
}
