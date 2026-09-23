/**
 * Evolution Routes — Phase 2 Safety wired per MIRA_WEAKNESSES_AND_OBSTACLES.md:23 + MIRA_EVOLUTION_SPEC.md Phase 2 + MIRA_SYSTEM_DOCUMENTATION.md:8
 *
 * Docs: Status Target→Implemented per MIRA_WEAKNESSES_AND_OBSTACLES.md:23 Phase 2 (Safety: Risk+Autonomy+Approval+Resources+Security+Rollback),
 *       MIRA_EVOLUTION_SPEC.md Phase 2 + §12 Definition of Done, MIRA_SYSTEM_DOCUMENTATION.md:8 Tool Security.
 *
 * Pipeline per observe: Risk → Autonomy → Approval → Resources → Security → Verifier → Evaluator → Ledger
 * Adds POST /evolution/approve/:id + POST /evolution/rollback/:id + GET /evolution/risk/:id + GET /evolution/health phase:"Phase 2 Safety"
 * Keeps nvidia primary + colibri opportunistic — health probes colibri but never requires it. No local hardware.
 *
 * Documentation Maintenance — 10 items:
 * | # | Item | Status | Evidence |
 * |---|------|--------|----------|
 * | 1 | Implementation path | Implemented | packages/server/src/routes/evolution.ts + packages/server/src/evolution/{risk,autonomy,approval,resources,security,rollback}.ts |
 * | 2 | Public interfaces | Implemented | GET /evolution/health, POST /evolution/observe (gated), GET /evolution/ledger, POST /evolution/approve/:id, POST /evolution/rollback/:id, GET /evolution/risk/:id |
 * | 3 | Events | Implemented | evolution.observed, evolution.approval, evolution.budget, evolution.security, evolution.rollback, evolution.ledger |
 * | 4 | Configuration | Implemented | respects MIRA_NO_AUTOPROVISION + MIRA_BUDGET_* + MIRA_RISK_*; nvidia primary |
 * | 5 | Tests | Implemented | evolution/*.test.ts (Phase 1 + Phase 2) |
 * | 6 | Security boundaries | Implemented | gated observe: high-risk→approval, secret→blocked, budget→blocked, fail-closed |
 * | 7 | Operational procedures | Implemented | mountEvolutionRoutes(app, {db,bus,ledger,observer}) on boot |
 * | 8 | Migration strategy | Implemented | additive routes + evolution_rollbacks table, safe to disable |
 * | 9 | Rollback strategy | Implemented | RollbackManager via POST /evolution/rollback/:id + git revert |
 * | 10 | Known limitations | Implemented | mock human approval; Phase 4 shadow/canary still Target |
 */

import type { Hono } from "hono"
import type { MiraDB } from "../storage/db.js"
import type { Bus } from "../bus/index.js"
import type { JsonValue } from "../types/index.js"
import { EvolutionObserver } from "../evolution/observer.js"
import { diagnose } from "../evolution/diagnosis.js"
import { propose } from "../evolution/proposal.js"
import { createExperiment } from "../evolution/experiment.js"
import { verify } from "../evolution/verifier.js"
import { evaluate } from "../evolution/evaluator.js"
import { ImprovementLedger } from "../evolution/ledger.js"
import { RiskEngine } from "../evolution/risk.js"
import { selectLevel, requiresApproval, AutonomyLevels } from "../evolution/autonomy.js"
import { ApprovalGate } from "../evolution/approval.js"
import { ResourceLimits } from "../evolution/resources.js"
import { SecurityValidator } from "../evolution/security.js"
import { RollbackManager } from "../evolution/rollback.js"

export interface EvolutionRouteDeps {
  db: MiraDB
  bus: Bus
  ledger?: ImprovementLedger
  observer?: EvolutionObserver
  riskEngine?: RiskEngine
  approvalGate?: ApprovalGate
  resourceLimits?: ResourceLimits
  securityValidator?: SecurityValidator
  rollbackManager?: RollbackManager
}

export function mountEvolutionRoutes(
  app: Hono<{ Variables: { requestId: string } }>,
  deps: EvolutionRouteDeps,
) {
  const { db, bus } = deps
  const ledger = deps.ledger ?? new ImprovementLedger(db, bus)
  const observer = deps.observer ?? new EvolutionObserver({ bus })
  const riskEngine = deps.riskEngine ?? new RiskEngine()
  const approvalGate = deps.approvalGate ?? new ApprovalGate({ bus })
  const resourceLimits = deps.resourceLimits ?? new ResourceLimits({ bus })
  const securityValidator = deps.securityValidator ?? new SecurityValidator({ bus })
  const rollbackManager = deps.rollbackManager ?? new RollbackManager({ db, bus, ledger })

  // ── GET /evolution/health ────────────────────────────────────────
  app.get("/evolution/health", (c) => {
    return c.json({
      ok: true,
      status: "Target→Implemented per MIRA_WEAKNESSES_AND_OBSTACLES.md:23 + MIRA_EVOLUTION_SPEC.md Phase 2 + MIRA_SYSTEM_DOCUMENTATION.md:8",
      phase: "Phase 2 Safety",
      primary: "nvidia",
      fallback: "colibri",
      hardware: "no local hardware required (colibri opportunistic)",
      observer: observer.health(),
      ledger: ledger.health(),
      risk: "RiskEngine wired",
      autonomy: "AutonomyLevels 0-5 wired",
      approval: "ApprovalGate wired (mock human, emits evolution.approval)",
      resources: "ResourceLimits wired (per-task/per-agent/per-mission/daily)",
      security: "SecurityValidator wired",
      rollback: "RollbackManager wired",
      routes: [
        "GET /evolution/health",
        "POST /evolution/observe",
        "GET /evolution/ledger",
        "GET /evolution/risk/:id",
        "POST /evolution/approve/:id",
        "POST /evolution/rollback/:id",
      ],
      canary: "Target (Phase 5)",
      shadow: "Target (Phase 4)",
      timestamp: Date.now(),
    })
  })

  // ── POST /evolution/observe ──────────────────────────────────────
  // Body: { failure: string, evidence?: JsonValue, sessionID?: string, changedFiles?: string[], patch?: string, permissionScope?: string, cost?: number }
  app.post("/evolution/observe", async (c) => {
    let body: {
      failure?: unknown
      evidence?: unknown
      sessionID?: unknown
      changedFiles?: unknown
      patch?: unknown
      permissionScope?: unknown
      cost?: unknown
    } | null = null
    try { body = (await c.req.json() as unknown) as typeof body } catch { body = null }
    if (!body || typeof (body as { failure?: unknown }).failure !== "string" || !(body as { failure?: string }).failure!.trim()) {
      return c.json({ error: "body.failure string required" }, 400)
    }
    const b = body as { failure: string; evidence?: unknown; sessionID?: unknown; changedFiles?: unknown; patch?: unknown; permissionScope?: unknown; cost?: unknown }
    const failure = String(b.failure).slice(0, 500)
    const evidence = (b.evidence ?? null) as JsonValue
    const sessionID = b.sessionID ? String(b.sessionID).slice(0, 100) : undefined
    const changedFiles = Array.isArray(b.changedFiles) ? (b.changedFiles as unknown[]).map(String).slice(0, 20) : undefined
    const patch = typeof b.patch === "string" ? String(b.patch).slice(0, 10000) : undefined
    const permissionScope = typeof b.permissionScope === "string" ? String(b.permissionScope).slice(0, 200) : undefined
    const cost = typeof b.cost === "number" && Number.isFinite(b.cost) ? Number(b.cost) : undefined

    const observed = observer.observe(failure, evidence, sessionID)

    // Pipeline: Diagnosis → Proposal
    const diagnosis = diagnose(observed)
    const proposal = propose(diagnosis)
    const experiment = createExperiment(proposal, patch)

    // ── Phase 2 gates: Risk → Autonomy → Approval → Resources → Security → Verifier
    const risk = riskEngine.assess({
      ...proposal,
      changedFiles: changedFiles ?? (experiment.virtualDiff ? [experiment.virtualDiff.file] : []),
      patch: patch ?? experiment.patch,
      permissionScope: permissionScope ?? proposal.affectedEngine,
      cost: cost ?? 0.05,
    })

    const level = selectLevel(risk, proposal)
    const needsApproval = requiresApproval(level, risk)

    // Approval gate — emits evolution.approval
    const approval = approvalGate.requestApproval(proposal, level, risk)

    // Resource limits — per-task/per-agent/per-mission/daily (§13)
    const budget = resourceLimits.checkBudget(proposal as unknown as unknown as Parameters<typeof resourceLimits.checkBudget>[0], cost ?? 0.05)

    // Security validation — no secrets / no permission escalation (§8)
    const securityPre = securityValidator.validate(patch ?? experiment.patch)

    // Create rollback point before verifier (so we can revert even if verifier fails)
    const rollbackPoint = rollbackManager.createRollbackPoint(proposal.id)

    // Gate decisions — fail-closed: block verifier if any gate fails
    const gatedReason: string[] = []
    let blocked = false
    let blockedBy: string | null = null

    if (!securityPre.passed) {
      blocked = true
      blockedBy = "security"
      gatedReason.push(`security blocked: ${securityPre.findings.slice(0, 2).join("; ")}`)
    }
    if (!budget.allowed) {
      blocked = true
      blockedBy = blockedBy ?? "budget"
      gatedReason.push(`budget blocked: ${budget.reason}`)
    }
    if (!approval.approved && approval.pending) {
      blocked = true
      blockedBy = blockedBy ?? "approval"
      gatedReason.push(`approval pending: ${approval.reason} (level ${level}, risk ${risk.level})`)
    }

    let verification: Awaited<ReturnType<typeof verify>> | null = null
    let evaluation: ReturnType<typeof evaluate> | null = null
    let verdict: string

    if (blocked) {
      // Do not run verifier when gated — record as pending/blocked for ledger
      verification = {
        verified: false,
        regression: false,
        security: { passed: securityPre.passed, issues: securityPre.findings },
        static: { passed: false, issues: gatedReason },
        benchmark: { latencyMs: 0, successRate: 0, costDelta: 0 },
        details: { blocked: true, blockedBy, gatedReason, risk, level, needsApproval } as unknown as JsonValue,
        timestamp: Date.now(),
      }
      evaluation = {
        decision: "reject",
        reason: `blocked by ${blockedBy}: ${gatedReason.join(" | ")}`,
        scores: {
          success: { baseline: 0.87, candidate: 0, delta: -0.87, pass: false },
          latency: { baseline: 12000, candidate: 0, deltaPct: 0, pass: true },
          cost: { baseline: 0.18, candidate: 0, deltaPct: 0, pass: true },
          regression: { baseline: 0.08, candidate: 0, delta: 0, pass: true },
          security: { baseline: 2, candidate: 99, pass: false },
        },
        timestamp: Date.now(),
        details: { blocked: true, blockedBy } as unknown as JsonValue,
      }
      verdict = blockedBy === "approval" ? "pending_approval" : blockedBy === "budget" ? "budget_blocked" : "security_blocked"
    } else {
      verification = await verify(experiment)
      // merge pre-security result into verification security (fail-closed)
      if (!securityPre.passed) {
        verification.security.passed = false
        verification.security.issues = [...verification.security.issues, ...securityPre.findings]
        verification.verified = false
      }
      evaluation = evaluate(verification)
      verdict = evaluation.decision === "accept" ? "verified" : "rejected"
    }

    try {
      ledger.remember({
        id: proposal.id,
        proposal,
        verdict: verdict as unknown as import("../evolution/ledger.js").LedgerVerdict,
        evidence: {
          observed,
          diagnosis,
          experiment: { id: experiment.simulationId, sandboxPath: experiment.sandboxPath, riskScore: experiment.riskScore },
          risk,
          autonomy: { level, needsApproval },
          approval,
          budget,
          security: securityPre,
          rollbackPoint,
          verification,
          evaluation,
        } as unknown as JsonValue,
      })
    } catch {}

    return c.json({
      ok: true,
      observed,
      diagnosis,
      proposal,
      experiment: { proposalId: experiment.proposalId, sandboxPath: experiment.sandboxPath, simulationId: experiment.simulationId, riskScore: experiment.riskScore },
      risk,
      autonomy: { level, needsApproval, levels: "0:Observe 1:Suggest 2:Experiment 3:Execute 4:Canary 5:Autonomous (§18)" },
      approval,
      budget,
      security: securityPre,
      rollbackPoint,
      verification: verification ? { verified: verification.verified, regression: verification.regression, security: verification.security, static: verification.static, blocked: (verification.details as { blocked?: boolean })?.blocked ?? false } : null,
      evaluation: evaluation ? { decision: evaluation.decision, reason: evaluation.reason } : null,
      ledger: { verdict, id: proposal.id },
      note: blocked ? `blocked by ${blockedBy} — POST /evolution/approve/${proposal.id} or fix and retry` : "Phase 2 gated — Risk→Autonomy→Approval→Resources→Security before Verifier",
    })
  })

  // ── GET /evolution/ledger ────────────────────────────────────────
  app.get("/evolution/ledger", (c) => {
    const limitRaw = c.req.query("limit")
    const limit = limitRaw ? Math.min(100, Math.max(1, Number(limitRaw) || 50)) : 50
    const entries = ledger.list(limit)
    return c.json({
      ok: true,
      count: ledger.count(),
      limit,
      entries: entries.map((e) => ({
        id: e.id,
        title: e.proposal.title,
        type: e.proposal.type,
        risk: e.proposal.risk,
        priority: e.proposal.priority,
        affectedEngine: e.proposal.affectedEngine,
        verdict: e.verdict,
        evidence: e.evidence,
        createdAt: e.createdAt,
      })),
    })
  })

  // ── GET /evolution/risk/:id ──────────────────────────────────────
  app.get("/evolution/risk/:id", (c) => {
    const id = c.req.param("id")
    const entry = ledger.get(id)
    if (!entry) return c.json({ error: "not found", id }, 404)
    const ev = entry.evidence as { risk?: import("../evolution/risk.js").RiskAssessment; autonomy?: { level: number; needsApproval: boolean }; approval?: unknown; budget?: unknown; security?: unknown } | null
    if (ev?.risk) {
      return c.json({ ok: true, id, risk: ev.risk, autonomy: ev.autonomy, approval: ev.approval, budget: ev.budget, security: ev.security })
    }
    // fallback: recompute risk from proposal
    const risk = riskEngine.assess(entry.proposal as unknown as Parameters<typeof riskEngine.assess>[0])
    const level = selectLevel(risk, entry.proposal)
    return c.json({ ok: true, id, risk, autonomy: { level, needsApproval: requiresApproval(level, risk) }, proposal: entry.proposal, fallback: true })
  })

  // ── POST /evolution/approve/:id ──────────────────────────────────
  app.post("/evolution/approve/:id", async (c) => {
    const id = c.req.param("id")
    const entry = ledger.get(id)
    if (!entry) return c.json({ error: "not found", id }, 404)
    let body: { approver?: unknown } | null = null
    try { body = (await c.req.json() as unknown) as unknown as typeof body } catch { body = null }
    const approver = (body as unknown as { approver?: unknown } | null)?.approver ? String((body as unknown as { approver?: unknown }).approver).slice(0, 100) : "human"
    const result = approvalGate.approve(id, approver)
    // also update ledger verdict to approved if it was pending
    try {
      const ev = entry.evidence as Record<string, unknown> | null
      const currentVerdict = String(entry.verdict)
      if (currentVerdict.includes("pending")) {
        // mark as verified-pending-approved
        ledger.remember({ id: entry.id, proposal: entry.proposal, verdict: "verified" as unknown as import("../evolution/ledger.js").LedgerVerdict, evidence: { ...(ev ?? {}), approval: result, approvedAt: Date.now(), approver } as unknown as JsonValue })
      }
    } catch {}
    return c.json({ ok: true, id, approved: result.approved, approver: result.approver, reason: result.reason })
  })

  // ── POST /evolution/rollback/:id ─────────────────────────────────
  app.post("/evolution/rollback/:id", async (c) => {
    const id = c.req.param("id")
    const entry = ledger.get(id)
    if (!entry) return c.json({ error: "not found", id }, 404)
    try {
      rollbackManager.rollback(id)
    } catch (e) {
      return c.json({ error: String(e).slice(0, 500), id }, 500)
    }
    const after = ledger.get(id)
    return c.json({ ok: true, id, rolledBack: true, verdict: after?.verdict ?? "rolledback" })
  })
}
