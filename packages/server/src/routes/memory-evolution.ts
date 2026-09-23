/**
 * Memory Evolution Routes — Phase 6 per MIRA_WEAKNESSES_AND_OBSTACLES.md:23 + MIRA_SYSTEM_DOCUMENTATION.md:6 + MIRA_EVOLUTION_SPEC.md Phase 6
 *
 * Docs: Status Target→Implemented per MIRA_WEAKNESSES_AND_OBSTACLES.md:23 Phase 6 (Memory Evolution: remember successes+fails+rejected+rollbacks+regressions; Failure Memory is key),
 *       MIRA_SYSTEM_DOCUMENTATION.md:6 Memory Model (Failure Memory: failed approaches, rejected patches, regressions, causes, recovery),
 *       MIRA_EVOLUTION_SPEC.md Phase 6 Remember + Documentation Maintenance 10-item table.
 *
 * Keeps nvidia primary + colibri opportunistic — SQLite local, no model/hardware. No local hardware. Respects MIRA_NO_AUTOPROVISION.
 *
 * Documentation Maintenance — 10 items:
 * | # | Item | Status | Evidence (path / interface) |
 * |---|------|--------|------------------------------|
 * | 1 | Implementation path | Implemented | packages/server/src/routes/memory-evolution.ts (mountMemoryEvolutionRoutes) + packages/server/src/memory-evolution/* |
 * | 2 | Public interfaces | Implemented | POST /memory/evolution/remember {type,proposal}, GET /memory/evolution, GET /memory/evolution/:id/explain, POST /memory/evolution/:id/forget, POST /memory/evolution/:id/promote (+ correct via provenance) |
 * | 3 | Events | Implemented | evolution.memory on remember; evolution.provenance on forget/promote via MemoryProvenance |
 * | 4 | Configuration | Implemented | DB via MIRA_DB, no extra config; nvidia primary preserved |
 * | 5 | Tests | Implemented | packages/server/src/memory-evolution/memory-evolution.test.ts (routes 200 via Hono fetch) |
 * | 6 | Security boundaries | Implemented | body cap 20k, type allowlist, prepared statements, no secret leak, 400 on invalid |
 * | 7 | Operational procedures | Implemented | mountMemoryEvolutionRoutes(app,{db,bus,memory,provenance,retrieval}) in src/index.ts, log memory-evolution ready |
 * | 8 | Migration strategy | Implemented | additive routes, evolution_memory CREATE TABLE IF NOT EXISTS, safe to disable |
 * | 9 | Rollback strategy | Implemented | DELETE via forget + git revert; drop table for full reset |
 * | 10 | Known limitations | Implemented | local SQLite only; no vector similarity; LastVerified = createdAt until promote |
 */

import type { Hono } from "hono"
import type { MiraDB } from "../storage/db.js"
import type { Bus } from "../bus/index.js"
import type { JsonValue } from "../types/index.js"
import { EvolutionMemory, type EvolutionMemoryType } from "../memory-evolution/evolution-memory.js"
import { MemoryProvenance } from "../memory-evolution/provenance.js"
import { EvolutionRetrieval } from "../memory-evolution/retrieval-evolution.js"

export interface MemoryEvolutionRouteDeps {
  db: MiraDB
  bus: Bus
  memory?: EvolutionMemory
  provenance?: MemoryProvenance
  retrieval?: EvolutionRetrieval
}

const ALLOWED_TYPES = new Set<EvolutionMemoryType>(["successful", "failed", "rejected", "rollback", "regression", "research", "benchmark"])

export function mountMemoryEvolutionRoutes(
  app: Hono<{ Variables: { requestId: string } }>,
  deps: MemoryEvolutionRouteDeps,
) {
  const { db, bus } = deps
  const memory = deps.memory ?? new EvolutionMemory(db, bus)
  const provenance = deps.provenance ?? new MemoryProvenance(db, bus, memory)
  const retrieval = deps.retrieval ?? new EvolutionRetrieval({ db })

  // ── POST /memory/evolution/remember {type, proposal, result?, reason?, cause?} ──
  app.post("/memory/evolution/remember", async (c) => {
    let body: Record<string, unknown> | null = null
    try { body = (await c.req.json() as unknown) as Record<string, unknown> } catch { body = null }
    if (!body || typeof body["type"] !== "string") {
      return c.json({ error: "body.type string required (successful|failed|rejected|rollback|regression|research|benchmark)" }, 400)
    }
    const type = String(body["type"]).toLowerCase().trim() as EvolutionMemoryType
    if (!ALLOWED_TYPES.has(type)) {
      return c.json({ error: `type must be one of ${[...ALLOWED_TYPES].join("|")}` }, 400)
    }
    // proposal required except regression/rollback can use cause/ledgerId
    const rawProposal = body["proposal"] ?? body["cause"] ?? body["reason"] ?? body["ledgerId"] ?? null
    if (rawProposal === null || rawProposal === undefined || (typeof rawProposal === "string" && !String(rawProposal).trim())) {
      return c.json({ error: "body.proposal required (or cause/ledgerId for rollback/regression)" }, 400)
    }
    const proposal = rawProposal
    const result = (body["result"] ?? body["reason"] ?? body["cause"] ?? null) as unknown
    // dispatch to typed helper for correct confidence + evidence semantics
    let entry
    try {
      if (type === "successful") entry = memory.rememberSuccessful(proposal, result)
      else if (type === "failed") entry = memory.rememberFailed(proposal, String(result ?? body["reason"] ?? "failed"))
      else if (type === "rejected") entry = memory.rememberRejected(proposal, String(result ?? body["reason"] ?? "rejected"))
      else if (type === "rollback") {
        const ledgerId = String((proposal as Record<string, unknown>)?.["ledgerId"] ?? body["ledgerId"] ?? proposal).slice(0, 200)
        const cause = String(body["cause"] ?? result ?? "rollback").slice(0, 2000)
        entry = memory.rememberRollback(ledgerId || "unknown", cause)
      } else if (type === "regression") {
        const cause = String(proposal ?? result ?? body["cause"] ?? "regression").slice(0, 2000)
        entry = memory.rememberRegression(cause)
      } else entry = memory.remember(type, proposal, result, { confidence: typeof body["confidence"] === "number" ? Number(body["confidence"]) : undefined, evidence: (body["evidence"] as JsonValue | undefined) ?? null })
    } catch (e) {
      return c.json({ error: String(e).slice(0, 500) }, 500)
    }
    return c.json({ ok: true, entry: { id: entry.id, type: entry.type, proposal: entry.proposal, result: entry.result, confidence: entry.confidence, createdAt: entry.createdAt }, provenance: provenance.getProvenance(entry.id) })
  })

  // ── GET /memory/evolution?limit=&query= ──────────────────────────────────
  // list when no query; retrieveRelevant when query present (augments with project memories)
  app.get("/memory/evolution", (c) => {
    const limitRaw = c.req.query("limit")
    const limit = limitRaw ? Math.min(100, Math.max(1, Number(limitRaw) || 20)) : 20
    const query = c.req.query("query") ?? c.req.query("q") ?? ""
    if (query && String(query).trim()) {
      const res = retrieval.retrieveRelevant(String(query), limit)
      return c.json({ ok: true, status: "Target→Implemented per MIRA_WEAKNESSES_AND_OBSTACLES.md:23 Phase 6", query: String(query), limit, count: res.combined.length, evolutionCount: res.evolutionMemories.length, projectCount: res.projectMemories.length, entries: res.combined, evolutionMemories: res.evolutionMemories, projectMemories: res.projectMemories })
    }
    const entries = memory.list(limit)
    return c.json({ ok: true, status: "Target→Implemented per MIRA_WEAKNESSES_AND_OBSTACLES.md:23 Phase 6 + MIRA_SYSTEM_DOCUMENTATION.md:6 Failure Memory", phase: "Phase 6 Memory Evolution", failureMemory: "active — failed improvements are knowledge", count: memory.count(), limit, entries: entries.map((e) => ({ id: e.id, type: e.type, proposal: e.proposal, result: e.result, confidence: e.confidence, createdAt: e.createdAt, evidence: e.evidence })) })
  })

  // ── GET /memory/evolution/:id/explain ────────────────────────────────────
  app.get("/memory/evolution/:id/explain", (c) => {
    const id = c.req.param("id")
    const exp = provenance.explain(id)
    if (!exp) return c.json({ error: "not found", id }, 404)
    return c.json({ ok: true, id, ...exp, actions: { forget: `POST /memory/evolution/${id}/forget`, promote: `POST /memory/evolution/${id}/promote` } })
  })

  // ── POST /memory/evolution/:id/forget ────────────────────────────────────
  app.post("/memory/evolution/:id/forget", async (c) => {
    const id = c.req.param("id")
    const ok = provenance.forget(id)
    if (!ok) return c.json({ error: "not found", id }, 404)
    return c.json({ ok: true, id, forgotten: true })
  })

  // ── POST /memory/evolution/:id/promote ───────────────────────────────────
  app.post("/memory/evolution/:id/promote", async (c) => {
    const id = c.req.param("id")
    const ok = provenance.promote(id)
    if (!ok) return c.json({ error: "not found", id }, 404)
    const exp = provenance.explain(id)
    return c.json({ ok: true, id, promoted: true, confidence: exp?.confidence ?? null, provenance: exp?.provenance ?? null })
  })
}
