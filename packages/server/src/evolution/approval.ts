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
import { roleAtLeast, type Role } from '../auth/roles.js'
import { artifactHash, type ApprovalArtifact } from './artifact-hash.js'
import {
  SIGNING_KEY_ENV,
  WARNING_SIGNING_DISABLED,
  signReceipt,
  signingEnabled,
  verifyReceipt,
  type ApprovalReceipt,
} from './approval-signing.js'

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
  /**
   * Content hash of the artifact this request authorizes (the exact diff and
   * target file). The approval is bound to these bytes, not just to the
   * proposal id: a decision or a promotion whose artifact no longer hashes to
   * this value is refused, so an approval can never be spent on different
   * content.
   */
  artifactHash?: string
  /** The artifact itself, retained so the hash can be re-verified at decision
   *  time rather than trusted from the stored field. */
  artifact?: { targetFile?: string | null; change?: string | null }
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
  /**
   * Hash of the artifact this decision authorized. Persisted with the decision
   * so an approval survives a restart: the promotion path resolves approvals by
   * artifact, and without this a restart would silently invalidate every
   * previously-granted approval.
   */
  artifactHash?: string
  /** When the decision was made. Part of the signed receipt. */
  decidedAt?: number
  /**
   * HMAC over the receipt (see approval-signing.ts). Present only when
   * MIRA_APPROVAL_SIGNING_KEY is configured. Its absence is NOT a pass: an
   * unsigned receipt never satisfies `authorizesArtifact` once signing is on.
   */
  signature?: string
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
  /**
   * RBAC role resolved from the caller's credentials. Approval authority is a
   * capability, so it is enforced here — in the domain object — rather than only
   * in HTTP middleware: the gate is reachable from more than the route (tools,
   * orchestration, future callers), and a capability that is checked in one
   * caller is not enforced anywhere.
   *
   * Omitting it is treated as "capability not established" and fails closed.
   */
  role?: Role
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
  /**
   * Atomically record a decision AND clear the pending request in one
   * transaction. Without this, a crash between `deletePending` and
   * `saveDecided` leaves the case in neither queue: the operator's request
   * vanishes and no decision is replayable — a silent lost approval.
   *
   * Optional so existing stores keep working; callers fall back to the
   * two-step sequence when it is absent.
   */
  commitDecision?(id: string, result: ApprovalResult): void
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
    commitDecision(id, result) {
      // One transaction: the decision lands and the pending row disappears
      // atomically, so a crash can never strand a request in neither queue.
      try {
        const tx = sqlite.transaction(() => {
          sqlite
            .prepare(`DELETE FROM evolution_approvals WHERE id = ? AND kind = 'pending'`)
            .run(id)
          sqlite
            .prepare(
              `INSERT OR REPLACE INTO evolution_approvals (id, kind, payload, updated_at) VALUES (?, 'decided', ?, ?)`,
            )
            .run(id, JSON.stringify(result), Date.now())
        })
        tx()
      } catch {}
    },
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

/**
 * Process-wide handle on the live ApprovalGate.
 *
 * The gate is constructed by mountEvolutionRoutes() while the governance
 * pipeline is constructed independently in learning/index.ts, so the promotion
 * path needs a way to reach the one authoritative gate. This follows the
 * codebase's existing setShared* convention rather than threading the instance
 * through every constructor.
 *
 * Fail-closed: with no gate registered, promotion is refused — a pipeline that
 * cannot find the approval authority must not assume approval.
 */
let activeGate: ApprovalGate | null = null

export function setActiveApprovalGate(gate: ApprovalGate | null): void {
  activeGate = gate
}

/** The live gate, for callers that need to act on it directly. */
export function getActiveApprovalGate(): ApprovalGate | null {
  return activeGate
}

/**
 * Raise an approval request for a change that is ABOUT TO BECOME PROMOTABLE,
 * binding the request to the exact bytes.
 *
 * This is the bridge between the two halves of the system. Governance
 * proposals are created by the patching engine, which never touched the
 * approval gate; without raising a request here, no approval could ever match
 * a promotable artifact and the fail-closed promotion gate would block every
 * promotion permanently.
 *
 * The request is raised as high-risk so it always waits for a human: this is
 * the point where a diff becomes eligible to become a real change.
 */
export function raiseApprovalForArtifact(
  proposal: ImprovementProposal,
  artifact: ApprovalArtifact,
): ApprovalResult | null {
  if (!activeGate) return null
  return activeGate.requestApproval(proposal, 1, HIGH_RISK, artifact)
}

const HIGH_RISK: RiskAssessment = {
  level: 'high',
  score: 0.9,
  reasons: ['candidate change is eligible for promotion'],
}

/** Authorize promoting a candidate change. Used as GovernanceGate's approvalCheck. */
export function authorizePromotion(artifact: ApprovalArtifact): {
  ok: boolean
  reason?: string
  approver?: string
} {
  if (!activeGate) {
    return {
      ok: false,
      reason: 'no approval gate is configured — refusing to promote an unapproved change',
    }
  }
  return activeGate.authorizesArtifact(artifact)
}

/** Whoever produced the proposal — used to forbid self-approval. */
function proposalAuthor(proposal: ImprovementProposal): string | undefined {
  const p = proposal as unknown as {
    createdBy?: unknown
    author?: unknown
    by?: unknown
    agent?: unknown
    painPointId?: unknown
  }
  // Prefer the immutable createdBy field (set at proposal creation)
  if (typeof p.createdBy === 'string' && p.createdBy.length > 0) return p.createdBy
  // Fallback to legacy fields for backward compatibility
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
  /** Minimum RBAC role that may approve/deny. Approval is a capability, and it
   *  is enforced here so it holds for every caller, not just the HTTP route. */
  private minApproverRole: Role
  /** Pending requests older than this can no longer be decided — a decision
   *  must be made against current evidence, not evidence the operator last saw
   *  months ago. 0/undefined disables expiry. */
  private maxRequestAgeMs: number
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
    /**
     * Minimum RBAC role permitted to approve/deny. Default 'operator' — a
     * read-only `viewer` key must never be able to authorize a change, even if
     * the HTTP route's RBAC gate is bypassed or another caller reaches the gate.
     * Pass 'viewer' only on deliberately open single-operator deployments.
     */
    minApproverRole?: Role
    /**
     * Pending requests older than this are refused (stale evidence). Default
     * 24h; 0 disables.
     */
    maxRequestAgeMs?: number
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
    this.minApproverRole = opts?.minApproverRole ?? 'operator'
    this.maxRequestAgeMs = opts?.maxRequestAgeMs ?? 24 * 3_600_000
    this.refreshPolicy()
    if (opts?.store) {
      this.store = opts.store
      try {
        for (const req of this.store.loadPending()) this.pending.set(req.id, req)
        for (const { id, result } of this.store.loadDecided()) {
          this.decided.set(id, result)
          // Re-index the artifact binding so approvals recorded before a
          // restart still authorize the same bytes afterwards.
          if (result.artifactHash && result.approver) {
            this.approvedArtifacts.set(result.artifactHash, {
              id,
              approver: result.approver,
              signature: result.signature,
              decidedAt: result.decidedAt,
            })
          }
        }
      } catch {}
    }
  }

  /**
   * Build and register a pending request. Every request is stamped with the
   * artifact it authorizes so a later decision — or a promotion — can prove it
   * is acting on the same bytes the operator saw.
   */
  private raisePending(
    proposal: ImprovementProposal,
    level: number,
    risk: RiskAssessment,
    artifact?: ApprovalArtifact,
    extra?: Partial<ApprovalRequest>,
  ): ApprovalRequest {
    const req: ApprovalRequest = {
      id: proposal.id,
      level,
      risk,
      proposal,
      requestedAt: Date.now(),
      status: 'pending',
      ...(artifact ? { artifactHash: artifactHash(artifact), artifact: { ...artifact } } : {}),
      ...extra,
    }
    this.pending.set(proposal.id, req)
    try {
      this.store?.savePending(req)
    } catch {}
    this.emit(proposal, level, risk, 'pending', undefined)
    return req
  }

  requestApproval(
    proposal: ImprovementProposal,
    level: number,
    risk?: RiskAssessment,
    /**
     * The change being authorized. Supplying it binds the approval to these
     * exact bytes; omit it and the approval is bound to the proposal record
     * only (legacy behaviour, and the promotion path will not accept it).
     */
    artifact?: ApprovalArtifact,
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
        this.raisePending(proposal, level, r, artifact)
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
      const req = this.raisePending(proposal, level, r, artifact, {
        approvers: [],
        requiredApprovals: this.twoPersonRule ? 2 : 1,
        policyFingerprint: this.fingerprint,
      })
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
      this.raisePending(proposal, level, r, artifact)
      return {
        approved: false,
        pending: true,
        reason: 'approval required — no mock approver is configured; POST /evolution/approve/:id',
      }
    }

    // Reached when approval is required for a reason not covered above. Stay
    // pending rather than inventing an approver.
    this.raisePending(proposal, level, r, artifact)
    return {
      approved: false,
      pending: true,
      reason: 'approval required — POST /evolution/approve/:id',
    }
  }

  /**
   * Capabilities every approver must hold, checked identically by approve() and
   * deny() so the two paths can never drift apart.
   *
   * Returns null when the identity may act, or a rejection reason.
   */
  private checkCapabilities(
    identity: ApproverIdentity | undefined,
    req: ApprovalRequest | undefined,
    verb: 'approve' | 'deny',
  ): string | null {
    if (!identity?.authenticated) {
      return `${verb} rejected: approver identity is not authenticated`
    }
    // The artifact must still be the one the operator was shown. The stored
    // hash is recomputed from the retained artifact rather than trusted, so
    // mutating either field is detected.
    const artifactError = this.verifyArtifact(req, verb)
    if (artifactError) return artifactError
    // Capability check — fails closed when the role was never resolved, so a
    // caller that forgets to pass it cannot approve by omission.
    if (!identity.role) {
      return `${verb} rejected: approver capability not established (missing role)`
    }
    if (!roleAtLeast(identity.role, this.minApproverRole)) {
      return `${verb} rejected: role "${identity.role}" lacks the "${this.minApproverRole}" approval capability`
    }
    // Stale evidence: a decision must be made against what the operator can see
    // now, not against a request that has been sitting for months.
    if (req && this.maxRequestAgeMs > 0 && Date.now() - req.requestedAt > this.maxRequestAgeMs) {
      return `${verb} refused: approval request expired (raised ${Math.round((Date.now() - req.requestedAt) / 3_600_000)}h ago, limit ${Math.round(this.maxRequestAgeMs / 3_600_000)}h) — re-raise the proposal to be decided against current evidence`
    }
    return null
  }

  /** Authenticated human approvals, indexed by the artifact they authorize.
   *  Populated on approve(); this is what the promotion path consults. */
  private approvedArtifacts = new Map<
    string,
    { id: string; approver?: string; signature?: string; decidedAt?: number }
  >()

  /** True when receipts are being signed (MIRA_APPROVAL_SIGNING_KEY set). */
  private receiptsSigned(): boolean {
    return signingEnabled()
  }

  /**
   * Build the signed receipt for a decision, when one can be built.
   * Returns undefined for anything that is not an authoritative human approval
   * of a specific artifact — policy auto-approvals, mocks and denials produce
   * no receipt because they must never authorize a promotion.
   */
  private buildReceipt(
    id: string,
    result: ApprovalResult,
  ): { receipt: ApprovalReceipt; signature: string } | undefined {
    if (!result.approved || !result.authoritative || !result.approver || !result.artifactHash) {
      return undefined
    }
    if (!this.receiptsSigned()) return undefined
    const receipt: ApprovalReceipt = {
      id,
      approved: true,
      authoritative: true,
      approver: result.approver,
      artifactHash: result.artifactHash,
      decidedAt: result.decidedAt ?? Date.now(),
    }
    const signature = signReceipt(receipt)
    if (!signature) return undefined
    return { receipt, signature }
  }

  /**
   * Confirm the request's artifact still hashes to what was recorded. Guards
   * the window between "the operator saw this diff" and "a human decided":
   * if the artifact or its hash is mutated in between, the decision is refused.
   */
  private verifyArtifact(req: ApprovalRequest | undefined, verb: string): string | null {
    if (!req?.artifactHash) return null
    if (!req.artifact) {
      return `${verb} refused: the approval artifact is missing but a hash was recorded — refusing to decide on unverifiable content`
    }
    const actual = artifactHash(req.artifact)
    if (actual !== req.artifactHash) {
      return `${verb} refused: the artifact changed after this approval was raised (expected ${req.artifactHash}, got ${actual}) — re-raise the proposal so the operator reviews the current content`
    }
    return null
  }

  /**
   * Whether an authoritative human approval exists for exactly this artifact.
   *
   * This is the check the promotion path uses. It is content-addressed on
   * purpose: the promotion pipeline and the approval pipeline use different id
   * spaces, so a proposal id proves nothing about which bytes are being shipped.
   * Policy and mock approvals never count — only an authenticated human does.
   */
  authorizesArtifact(artifact: ApprovalArtifact): {
    ok: boolean
    reason?: string
    approver?: string
  } {
    const h = artifactHash(artifact)
    const hit = this.approvedArtifacts.get(h)
    if (!hit) {
      return {
        ok: false,
        reason: `no authoritative human approval for this exact change (artifact ${h}) — an operator must approve it via POST /evolution/approve/:id`,
      }
    }
    // With signing enabled, a decision only counts if its receipt verifies
    // against the key. This is what stops someone who can write the database
    // from minting an approval: the signature needs a key the store does not
    // contain. Unsigned or altered decisions are refused with an actionable
    // reason rather than silently accepted.
    if (this.receiptsSigned()) {
      if (!hit.signature) {
        return {
          ok: false,
          reason: `approval for ${hit.id} has no signed receipt and ${SIGNING_KEY_ENV} is set — re-approve it so the decision is signed (it was recorded before signing was enabled, or the signature was stripped)`,
        }
      }
      const valid = verifyReceipt(
        {
          id: hit.id,
          approved: true,
          authoritative: true,
          approver: hit.approver ?? '',
          artifactHash: h,
          decidedAt: hit.decidedAt ?? 0,
        },
        hit.signature,
      )
      if (!valid) {
        return {
          ok: false,
          reason: `approval receipt for ${hit.id} failed signature verification — the decision was altered after it was recorded, or was signed with a different key`,
        }
      }
    }
    return { ok: true, approver: hit.approver }
  }

  /** Record an authoritative approval against the artifact it authorized. */
  private indexApprovedArtifact(req: ApprovalRequest, result: ApprovalResult): void {
    if (!req.artifactHash || !result.approver) return
    this.approvedArtifacts.set(req.artifactHash, {
      id: req.id,
      approver: result.approver,
      signature: result.signature,
      decidedAt: result.decidedAt,
    })
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

    // Capability + staleness gate, shared with deny() so the paths cannot drift.
    const capabilityError = this.checkCapabilities(identity, req, 'approve')
    if (capabilityError) {
      return { approved: false, pending: true, reason: capabilityError }
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
      ...(req.artifactHash ? { artifactHash: req.artifactHash } : {}),
      decidedAt: Date.now(),
      reason:
        required > 1
          ? 'approved by human operators (two-person rule)'
          : 'approved by human operator',
    }
    // Sign the receipt when MIRA_APPROVAL_SIGNING_KEY is configured. The
    // signature is computed before persisting so the stored decision is the
    // signed one — a receipt can never be added later by whoever can write the
    // database.
    const signed = this.buildReceipt(id, result)
    if (signed) result.signature = signed.signature
    this.decided.set(id, result)
    // Bind the decision to the bytes it authorized so the promotion path can
    // verify it is shipping exactly what was approved.
    this.indexApprovedArtifact(req, result)
    // Durable transition: record the decision and clear the pending request
    // atomically, so a crash between the two writes cannot strand the case in
    // neither queue (a silently lost approval).
    try {
      if (this.store?.commitDecision) this.store.commitDecision(id, result)
      else {
        this.store?.deletePending(id)
        this.store?.saveDecided(id, result)
      }
    } catch {}
    return result
  }

  deny(id: string, identity: ApproverIdentity): ApprovalResult {
    const approver = identity?.owner ?? 'unauthenticated'
    const reqForCaps = this.pending.get(id)
    // Same capability + staleness gate as approve() — an unauthorized caller must
    // not be able to deny a proposal simply by reaching deny() first.
    const capabilityError = this.checkCapabilities(identity, reqForCaps, 'deny')
    if (capabilityError) {
      return { approved: false, approver, reason: capabilityError }
    }
    // Same operator restriction as approve() — only designated operators.
    if (this.operators && !this.operators.has(approver)) {
      return {
        approved: false,
        reason: `denial rejected: "${approver}" is not a designated operator (MIRA_OPERATORS)`,
      }
    }
    // Same meta-rule as approve(): a policy edit mid-flight invalidates the
    // case, so a denial cannot be recorded under stale rules either.
    const req = reqForCaps
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
    // Same atomic transition as approve() — see the comment there.
    try {
      if (this.store?.commitDecision) this.store.commitDecision(id, result)
      else {
        this.store?.deletePending(id)
        this.store?.saveDecided(id, result)
      }
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
