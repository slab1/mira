/**
 * Evolution Routes — GET /evolution/health, POST /evolution/observe, GET /evolution/ledger
 *
 * Docs: Status Target→Implemented per MIRA_WEAKNESSES_AND_OBSTACLES.md:23 Phase 1 (read-only ledger),
 *       MIRA_EVOLUTION_SPEC.md + MIRA_SYSTEM_DOCUMENTATION.md:2 §12 Definition of Done.
 *
 * Read-only, no auto-promote, no canary/shadow (Phase 4/5 Target).
 * Keeps nvidia primary + colibri opportunistic — health probes colibri but never requires it.
 *
 * Documentation Maintenance — 10 items:
 * | # | Item | Status | Evidence |
 * |---|------|--------|----------|
 * | 1 | Implementation path | Implemented | packages/server/src/routes/evolution.ts |
 * | 2 | Public interfaces | Implemented | GET /evolution/health, POST /evolution/observe, GET /evolution/ledger |
 * | 3 | Events | Implemented | POST /evolution/observe → observer.observe() → evolution.observed; ledger queries |
 * | 4 | Configuration | Implemented | no new config; respects MIRA_NO_AUTOPROVISION, nvidia primary |
 * | 5 | Tests | Implemented | evolution.test.ts covers health+observe+ledger |
 * | 6 | Security boundaries | Implemented | read-only ledger, observe validates body, no promotion, no secret leak |
 * | 7 | Operational procedures | Implemented | mountEvolutionRoutes(app, {db,bus,ledger,observer}) on boot |
 * | 8 | Migration strategy | Implemented | additive routes, additive evolution_ledger table |
 * | 9 | Rollback strategy | Implemented | remove route mount + table, no cascade |
 * | 10 | Known limitations | Implemented | no shadow/canary/promote yet; ledger limit 50, evidence truncated |
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

export interface EvolutionRouteDeps {
  db: MiraDB
  bus: Bus
  ledger?: ImprovementLedger
  observer?: EvolutionObserver
}

export function mountEvolutionRoutes(
  app: Hono<{ Variables: { requestId: string } }>,
  deps: EvolutionRouteDeps,
) {
  const { db, bus } = deps
  const ledger = deps.ledger ?? new ImprovementLedger(db, bus)
  const observer = deps.observer ?? new EvolutionObserver({ bus })

  // ── GET /evolution/health ────────────────────────────────────────
  app.get("/evolution/health", (c) => {
    return c.json({
      ok: true,
      status: "Target→Implemented per MIRA_WEAKNESSES_AND_OBSTACLES.md:23 + MIRA_EVOLUTION_SPEC.md + MIRA_SYSTEM_DOCUMENTATION.md:2",
      phase: "Phase 1 Evolution Core (read-only, no auto-promote, no canary/shadow)",
      primary: "nvidia",
      fallback: "colibri",
      hardware: "no local hardware required (colibri opportunistic)",
      observer: observer.health(),
      ledger: ledger.health(),
      routes: ["GET /evolution/health", "POST /evolution/observe", "GET /evolution/ledger"],
      canary: "Target (Phase 5)",
      shadow: "Target (Phase 4)",
      timestamp: Date.now(),
    })
  })

  // ── POST /evolution/observe ──────────────────────────────────────
  // Body: { failure: string, evidence?: JsonValue, sessionID?: string }
  app.post("/evolution/observe", async (c) => {
    let body: { failure?: unknown; evidence?: unknown; sessionID?: unknown } | null = null
    try { body = await c.req.json() as typeof body } catch { body = null }
    if (!body || typeof body.failure !== "string" || !body.failure.trim()) {
      return c.json({ error: "body.failure string required" }, 400)
    }
    const failure = String(body.failure).slice(0, 500)
    const evidence = (body.evidence ?? null) as JsonValue
    const sessionID = body.sessionID ? String(body.sessionID).slice(0, 100) : undefined

    const observed = observer.observe(failure, evidence, sessionID)

    // Minimal pipeline Phase 1: Failure → Observer → Proposal → Sandbox → Verifier → Ledger
    // Do not auto-promote — just record observed + diagnosis+proposal+experiment+verify+evaluate for ledger preview
    const diagnosis = diagnose(observed)
    const proposal = propose(diagnosis)
    const experiment = createExperiment(proposal)
    const verification = await verify(experiment)
    const evaluation = evaluate(verification)

    // remember after verify (per spec) — read-only decision, no promotion
    const verdict = evaluation.decision === "accept" ? "verified" : "rejected"
    try {
      ledger.remember({
        id: proposal.id,
        proposal,
        verdict: verdict as "verified" | "rejected",
        evidence: { observed, diagnosis, experiment: { id: experiment.simulationId, sandboxPath: experiment.sandboxPath, riskScore: experiment.riskScore }, verification, evaluation } as unknown as JsonValue,
      })
    } catch {}

    return c.json({
      ok: true,
      observed,
      diagnosis,
      proposal,
      experiment: { proposalId: experiment.proposalId, sandboxPath: experiment.sandboxPath, simulationId: experiment.simulationId, riskScore: experiment.riskScore },
      verification: { verified: verification.verified, regression: verification.regression, security: verification.security, static: verification.static },
      evaluation: { decision: evaluation.decision, reason: evaluation.reason },
      ledger: { verdict, id: proposal.id },
      note: "read-only Phase 1 — no auto-promote, no canary/shadow",
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
}
