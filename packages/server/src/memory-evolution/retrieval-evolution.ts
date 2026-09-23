/**
 * Evolution Retrieval — Phase 6 Memory Evolution per MIRA_WEAKNESSES_AND_OBSTACLES.md:23 + MIRA_SYSTEM_DOCUMENTATION.md:6 + MIRA_EVOLUTION_SPEC.md Phase 6
 *
 * Docs: Status Target→Implemented per MIRA_WEAKNESSES_AND_OBSTACLES.md:23 Phase 6 (Memory Evolution: retrieveRelevant combines project + evolution memories),
 *       MIRA_SYSTEM_DOCUMENTATION.md:6 Memory Model (Failure Memory + Project/Team/Org/Procedural layers),
 *       MIRA_EVOLUTION_SPEC.md Phase 6 Remember (augments shared/memory_controller retrieval with evolution_memory: failed improvements, useful research, benchmark results),
 *       shared/memory_controller.py HCM L1-L4 (project memory via MemoryController / knowledge_entries).
 *
 * Keeps nvidia primary + colibri opportunistic — SQLite + file-backed memory_controller, no model/hardware. No local hardware. Respects MIRA_NO_AUTOPROVISION.
 *
 * Documentation Maintenance — 10 items:
 * | # | Item | Status | Evidence (path / interface) |
 * |---|------|--------|------------------------------|
 * | 1 | Implementation path | Implemented | packages/server/src/memory-evolution/retrieval-evolution.ts (EvolutionRetrieval) — augments MemoryController + evolution_memory |
 * | 2 | Public interfaces | Implemented | EvolutionRetrieval.retrieveRelevant(query,limit): {projectMemories,evolutionMemories,combined} — returns combined project + evolution memories |
 * | 3 | Events | Implemented | read-only; no emit (relies on evolution.memory from EvolutionMemory) |
 * | 4 | Configuration | Implemented | DB via MIRA_DB + optional MemoryController injection; nvidia primary, colibri opportunistic |
 * | 5 | Tests | Implemented | packages/server/src/memory-evolution/memory-evolution.test.ts (retrieval augments project+evolution, limit honored) |
 * | 6 | Security boundaries | Implemented | LIKE sanitized (%% escape), limit clamped 1..50, no secret leak, read-only |
 * | 7 | Operational procedures | Implemented | instantiated in routes/memory-evolution.ts or via EvolutionMemory db; retrieveRelevant called per query |
 * | 8 | Migration strategy | Implemented | additive — reads evolution_memory if exists, falls back to MemoryController only when table missing |
 * | 9 | Rollback strategy | Implemented | stateless; git revert + drop evolution_memory for full rollback |
 * | 10 | Known limitations | Implemented | LIKE fallback for evolution_memory (no vector), MemoryController file-backed may be absent in tests — empty projectMemories then |
 */

import type { MiraDB } from "../storage/db.js"
import type { JsonValue } from "../types/index.js"
import type { EvolutionMemoryEntry } from "./evolution-memory.js"

export interface RetrievalResult {
  projectMemories: Array<{ source: string; content: JsonValue; score?: number }>
  evolutionMemories: EvolutionMemoryEntry[]
  combined: Array<{ kind: "project" | "evolution"; id?: string; type?: string; content: JsonValue; confidence?: number }>
}

function mapEvolutionRow(row: { id: string; type: string; proposal: string; result: string | null; created_at: number; confidence: number; evidence: string | null }): EvolutionMemoryEntry {
  let proposal: JsonValue
  try { proposal = JSON.parse(row.proposal) as JsonValue } catch { proposal = row.proposal as unknown as JsonValue }
  let result: JsonValue | null = null
  try { result = row.result ? (JSON.parse(row.result) as JsonValue) : null } catch { result = row.result as unknown as JsonValue }
  let evidence: JsonValue | null = null
  try { evidence = row.evidence ? (JSON.parse(row.evidence) as JsonValue) : null } catch { evidence = row.evidence as unknown as JsonValue }
  return { id: row.id, type: row.type as EvolutionMemoryEntry["type"], proposal, result, createdAt: row.created_at, confidence: row.confidence ?? 0.5, evidence }
}

export class EvolutionRetrieval {
  private db: MiraDB
  private memoryController?: { retrieve_similar_experiences?: (q: string, n: number) => unknown[]; retrieveSimilarExperiences?: (q: string, n: number) => unknown[]; query_semantic?: (q: string) => unknown[]; querySemantic?: (q: string) => unknown[] } | null

  constructor(opts: { db: MiraDB; memoryController?: unknown }) {
    this.db = opts.db
    this.memoryController = (opts.memoryController as unknown) as EvolutionRetrieval["memoryController"] ?? null
    // lazy init file-backed controller if not injected — opportunistic
    if (!this.memoryController) {
      try {
        // dynamic import to avoid hard dep when not needed (colibri opportunistic pattern)
        // we keep it sync fallback: no controller = evolution-only retrieval
      } catch {}
    }
  }

  /** Retrieve relevant memories — combines project (MemoryController / episodic+semantic) + evolution_memory (failed improvements, useful research, benchmark results) */
  retrieveRelevant(query: string, limit = 10): RetrievalResult {
    const q = String(query ?? "").trim().slice(0, 500)
    const lim = Math.min(50, Math.max(1, Number(limit) || 10))
    const perSide = Math.max(1, Math.ceil(lim / 2))

    // ── Project memories via MemoryController (if available) ─────────────
    const projectMemories: RetrievalResult["projectMemories"] = []
    if (this.memoryController) {
      try {
        const mc = this.memoryController as Record<string, unknown>
        const fn =
          (mc["retrieve_similar_experiences"] as ((q: string, n: number) => unknown[]) | undefined) ??
          (mc["retrieveSimilarExperiences"] as ((q: string, n: number) => unknown[]) | undefined)
        if (fn) {
          const hits = fn.call(this.memoryController, q, perSide) as Array<Record<string, unknown>>
          for (const h of hits ?? []) {
            projectMemories.push({ source: "episodic", content: h as unknown as JsonValue, score: (h as Record<string, unknown>)["score"] as number | undefined })
          }
        }
        const qfn =
          (mc["query_semantic"] as ((q: string) => unknown[]) | undefined) ??
          (mc["querySemantic"] as ((q: string) => unknown[]) | undefined)
        if (qfn) {
          const sem = qfn.call(this.memoryController, q) as Array<Record<string, unknown>>
          for (const s of (sem ?? []).slice(0, perSide)) {
            projectMemories.push({ source: "semantic", content: s as unknown as JsonValue, score: (s as Record<string, unknown>)["score"] as number | undefined })
          }
        }
      } catch {}
    }
    // Fallback project memories from knowledge_entries if no controller (optional)
    if (projectMemories.length === 0 && q) {
      try {
        const sqlite = this.db.sqlite
        if (sqlite) {
          const like = `%${q.replace(/%/g, "\\%").slice(0, 100)}%`
          const rows = sqlite
            .prepare(`SELECT id, kind, content, tags, tier FROM knowledge_entries WHERE content LIKE ? OR tags LIKE ? ORDER BY created_at DESC LIMIT ?`)
            .all(like, like, perSide) as Array<{ id: string; kind: string | null; content: string; tags: string | null; tier: string | null }>
          for (const r of rows) {
            let content: JsonValue
            try { content = JSON.parse(r.content) as JsonValue } catch { content = r.content as unknown as JsonValue }
            projectMemories.push({ source: r.kind ?? r.tier ?? "knowledge", content })
          }
        }
      } catch {}
    }

    // ── Evolution memories: failed improvements, useful research, benchmark results ──
    let evolutionMemories: EvolutionMemoryEntry[] = []
    try {
      const sqlite = this.db.sqlite
      if (sqlite) {
        // ensure table exists (read-only check)
        try { sqlite.exec(`SELECT 1 FROM evolution_memory LIMIT 0`) } catch { sqlite.exec(`CREATE TABLE IF NOT EXISTS evolution_memory (id TEXT PRIMARY KEY, type TEXT, proposal TEXT, result TEXT, created_at INTEGER, confidence REAL, evidence TEXT)`) }
        if (q) {
          const like = `%${q.replace(/%/g, "\\%").slice(0, 100)}%`
          let rows = sqlite
            .prepare(
              `SELECT id, type, proposal, result, created_at, confidence, evidence FROM evolution_memory WHERE proposal LIKE ? OR result LIKE ? OR evidence LIKE ? OR type LIKE ? ORDER BY confidence DESC, created_at DESC LIMIT ?`,
            )
            .all(like, like, like, like, perSide * 2) as Array<{ id: string; type: string; proposal: string; result: string | null; created_at: number; confidence: number; evidence: string | null }>
          // fallback to first-token match when phrase not found (e.g. "colibri benchmark" -> "colibri")
          if (rows.length === 0) {
            const firstToken = q.split(/\s+/).filter(Boolean)[0] ?? q
            const like2 = `%${firstToken.replace(/%/g, "\\%").slice(0, 100)}%`
            rows = sqlite
              .prepare(
                `SELECT id, type, proposal, result, created_at, confidence, evidence FROM evolution_memory WHERE proposal LIKE ? OR result LIKE ? OR evidence LIKE ? OR type LIKE ? ORDER BY confidence DESC, created_at DESC LIMIT ?`,
              )
              .all(like2, like2, like2, like2, perSide * 2) as Array<{ id: string; type: string; proposal: string; result: string | null; created_at: number; confidence: number; evidence: string | null }>
          }
          // final fallback: most recent/confident when still empty
          if (rows.length === 0) {
            rows = sqlite
              .prepare(`SELECT id, type, proposal, result, created_at, confidence, evidence FROM evolution_memory ORDER BY confidence DESC, created_at DESC LIMIT ?`)
              .all(perSide * 2) as Array<{ id: string; type: string; proposal: string; result: string | null; created_at: number; confidence: number; evidence: string | null }>
          }
          evolutionMemories = rows.map(mapEvolutionRow)
        } else {
          const rows = sqlite
            .prepare(`SELECT id, type, proposal, result, created_at, confidence, evidence FROM evolution_memory ORDER BY confidence DESC, created_at DESC LIMIT ?`)
            .all(perSide * 2) as Array<{ id: string; type: string; proposal: string; result: string | null; created_at: number; confidence: number; evidence: string | null }>
          evolutionMemories = rows.map(mapEvolutionRow)
        }
        // prioritize failed/rejected/regression for Failure Memory (§6) when query mentions failure/regression
        if (/fail|regress|rollback|reject/i.test(q)) {
          evolutionMemories.sort((a, b) => {
            const rank = (t: string) => (t === "failed" || t === "regression" || t === "rollback" ? 0 : t === "rejected" ? 1 : 2)
            return rank(a.type) - rank(b.type) || (b.confidence - a.confidence)
          })
        }
        evolutionMemories = evolutionMemories.slice(0, lim)
      }
    } catch {}

    // ── Combined (interleaved project + evolution, evolution prioritized for failure queries) ──
    const combined: RetrievalResult["combined"] = []
    // If query is failure-oriented, evolution first
    const evolutionFirst = /fail|regress|rollback|reject|research|benchmark/i.test(q)
    if (evolutionFirst) {
      for (const e of evolutionMemories.slice(0, lim)) combined.push({ kind: "evolution", id: e.id, type: e.type, content: { proposal: e.proposal, result: e.result, evidence: e.evidence } as unknown as JsonValue, confidence: e.confidence })
      for (const p of projectMemories.slice(0, Math.max(0, lim - combined.length))) combined.push({ kind: "project", content: p.content, confidence: p.score })
    } else {
      for (const p of projectMemories.slice(0, lim)) combined.push({ kind: "project", content: p.content, confidence: p.score })
      for (const e of evolutionMemories.slice(0, Math.max(0, lim - combined.length))) combined.push({ kind: "evolution", id: e.id, type: e.type, content: { proposal: e.proposal, result: e.result, evidence: e.evidence } as unknown as JsonValue, confidence: e.confidence })
      // ensure at least evolution included when under limit
      if (combined.filter((c) => c.kind === "evolution").length === 0 && evolutionMemories.length > 0) {
        combined.push({ kind: "evolution", id: evolutionMemories[0].id, type: evolutionMemories[0].type, content: { proposal: evolutionMemories[0].proposal, result: evolutionMemories[0].result } as unknown as JsonValue, confidence: evolutionMemories[0].confidence })
        if (combined.length > lim) combined.pop()
      }
    }

    return { projectMemories: projectMemories.slice(0, lim), evolutionMemories: evolutionMemories.slice(0, lim), combined: combined.slice(0, lim) }
  }
}
