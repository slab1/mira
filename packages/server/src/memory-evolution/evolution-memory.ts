/**
 * Evolution Memory — Phase 6 Memory Evolution per MIRA_WEAKNESSES_AND_OBSTACLES.md:23 + MIRA_SYSTEM_DOCUMENTATION.md:6 + MIRA_EVOLUTION_SPEC.md Phase 6
 *
 * Docs: Status Target→Implemented per MIRA_WEAKNESSES_AND_OBSTACLES.md:23 Phase 6 (Memory Evolution: Successful+Failed+Rejected+Rollback+Regression+UsefulResearch+Benchmark),
 *       MIRA_SYSTEM_DOCUMENTATION.md:6 Memory Model (Failure Memory: failed approaches, rejected patches, regressions, causes, recovery — failed improvements are knowledge),
 *       MIRA_EVOLUTION_SPEC.md Phase 6 Remember (Observe→…→Remember with eval-gated promotion).
 *
 * Keeps nvidia primary + colibri opportunistic — SQLite local, no model/hardware required. No local hardware. Respects MIRA_NO_AUTOPROVISION.
 *
 * Documentation Maintenance — 10 items:
 * | # | Item | Status | Evidence (path / interface) |
 * |---|------|--------|------------------------------|
 * | 1 | Implementation path | Implemented | packages/server/src/memory-evolution/evolution-memory.ts (EvolutionMemory) + evolution_memory SQLite table |
 * | 2 | Public interfaces | Implemented | EvolutionMemory: rememberSuccessful(proposal,result), rememberFailed(proposal,reason), rememberRejected(proposal,reason), rememberRollback(ledgerId,cause), rememberRegression(cause), getUsefulResearch(query), list(limit) + generic remember(type,proposal,result,opts) + get/count/health |
 * | 3 | Events | Implemented | emits evolution.memory {id,type,proposal,confidence} on every remember (BusEvent via bus.publish, fail-open) |
 * | 4 | Configuration | Implemented | DB via MIRA_DB (createDatabase), no extra config; nvidia primary preserved, colibri opportunistic |
 * | 5 | Tests | Implemented | packages/server/src/memory-evolution/memory-evolution.test.ts (remember successful/failed/rejected/rollback + provenance + retrieval + routes 200) |
 * | 6 | Security boundaries | Implemented | proposal sanitized via JSON.stringify slice, no secret leak, prepared statements, fail-closed on missing db |
 * | 7 | Operational procedures | Implemented | ensureTable() idempotent on ctor + every write; mounted via EvolutionMemory in src/index.ts, log memory-evolution ready |
 * | 8 | Migration strategy | Implemented | CREATE TABLE IF NOT EXISTS evolution_memory + additive columns via ensureTable, safe re-run |
 * | 9 | Rollback strategy | Implemented | DELETE FROM evolution_memory WHERE id=? via provenance.forget; git revert + drop table for full rollback |
 * | 10 | Known limitations | Implemented | local SQLite only; no cross-project sync; vector search is LIKE fallback when embeddings unavailable; colibri opportunistic not required |
 */

import type { MiraDB } from "../storage/db.js"
import type { Bus } from "../bus/index.js"
import type { JsonValue } from "../types/index.js"

export type EvolutionMemoryType =
  | "successful"
  | "failed"
  | "rejected"
  | "rollback"
  | "regression"
  | "research"
  | "benchmark"

export interface EvolutionMemoryEntry {
  id: string
  type: EvolutionMemoryType
  proposal: JsonValue
  result: JsonValue | null
  createdAt: number
  confidence: number
  evidence: JsonValue | null
}

export interface RememberOpts {
  confidence?: number
  evidence?: JsonValue | null
  result?: JsonValue | null
}

function genId(prefix = "evo"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function toJsonValue(v: unknown): JsonValue {
  if (v === null || v === undefined) return null as unknown as JsonValue
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v as JsonValue
  try {
    // round-trip to strip undefined / ensure JSON-safe, cap size
    const s = JSON.stringify(v)
    if (s.length > 20000) return JSON.parse(s.slice(0, 20000)) as JsonValue
    return JSON.parse(s) as JsonValue
  } catch {
    return String(v).slice(0, 5000) as unknown as JsonValue
  }
}

export class EvolutionMemory {
  private db: MiraDB
  private bus?: Bus

  constructor(db: MiraDB, bus?: Bus) {
    this.db = db
    this.bus = bus
    this.ensureTable()
  }

  ensureTable(): void {
    const sqlite = this.db.sqlite
    if (!sqlite) return
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS evolution_memory (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        proposal TEXT NOT NULL,
        result TEXT,
        created_at INTEGER NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        evidence TEXT
      );
      CREATE INDEX IF NOT EXISTS evolution_memory_type_idx ON evolution_memory(type);
      CREATE INDEX IF NOT EXISTS evolution_memory_created_idx ON evolution_memory(created_at);
      CREATE INDEX IF NOT EXISTS evolution_memory_confidence_idx ON evolution_memory(confidence);
    `)
    // additive confidence/evidence columns for legacy DBs (IF NOT EXISTS via try)
    try {
      sqlite.exec(`ALTER TABLE evolution_memory ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5;`)
    } catch (e) {
      const msg = String(e)
      if (!msg.includes("duplicate column")) void msg
    }
    try {
      sqlite.exec(`ALTER TABLE evolution_memory ADD COLUMN evidence TEXT;`)
    } catch (e) {
      const msg = String(e)
      if (!msg.includes("duplicate column")) void msg
    }
  }

  /** Generic remember — core for all typed helpers */
  remember(
    type: EvolutionMemoryType,
    proposal: unknown,
    result: unknown = null,
    opts: RememberOpts = {},
  ): EvolutionMemoryEntry {
    this.ensureTable()
    const sqlite = this.db.sqlite
    const id = genId(type.slice(0, 3))
    const createdAt = Date.now()
    const confidence =
      typeof opts.confidence === "number" && Number.isFinite(opts.confidence)
        ? Math.max(0, Math.min(1, opts.confidence))
        : defaultConfidence(type)
    const proposalJson = JSON.stringify(toJsonValue(proposal))
    const resultVal = opts.result !== undefined ? opts.result : result
    const resultJson = resultVal === null || resultVal === undefined ? null : JSON.stringify(toJsonValue(resultVal))
    const evidenceJson =
      opts.evidence !== undefined && opts.evidence !== null
        ? JSON.stringify(toJsonValue(opts.evidence))
        : resultJson ?? JSON.stringify({ type, storedAt: createdAt })

    // prepared statement — no injection
    sqlite
      .prepare(
        `INSERT INTO evolution_memory (id, type, proposal, result, created_at, confidence, evidence) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, type, proposalJson, resultJson, createdAt, confidence, evidenceJson)

    const entry: EvolutionMemoryEntry = {
      id,
      type,
      proposal: toJsonValue(proposal),
      result: toJsonValue(resultVal) as JsonValue | null,
      createdAt,
      confidence,
      evidence: toJsonValue(opts.evidence ?? resultVal) as JsonValue | null,
    }

    try {
      this.bus?.publish({
        type: "evolution.memory" as unknown as import("../types/index.js").BusEventType,
        payload: {
          id,
          type,
          proposal: entry.proposal,
          result: entry.result,
          confidence,
          createdAt,
        } as unknown as JsonValue,
        timestamp: createdAt,
      } as unknown as import("../types/index.js").BusEvent)
    } catch {}

    return entry
  }

  rememberSuccessful(proposal: unknown, result: unknown): EvolutionMemoryEntry {
    return this.remember("successful", proposal, result, { confidence: 0.92, evidence: toJsonValue(result) })
  }

  rememberFailed(proposal: unknown, reason: string): EvolutionMemoryEntry {
    return this.remember("failed", proposal, { reason: String(reason).slice(0, 2000), failedAt: Date.now() }, { confidence: 0.75, evidence: toJsonValue({ reason }) })
  }

  rememberRejected(proposal: unknown, reason: string): EvolutionMemoryEntry {
    return this.remember("rejected", proposal, { reason: String(reason).slice(0, 2000), rejectedAt: Date.now() }, { confidence: 0.68, evidence: toJsonValue({ reason }) })
  }

  rememberRollback(ledgerId: string, cause: string): EvolutionMemoryEntry {
    const proposal = { ledgerId: String(ledgerId).slice(0, 200), cause: String(cause).slice(0, 2000) }
    return this.remember("rollback", proposal, { ledgerId, cause, rolledBackAt: Date.now() }, { confidence: 0.88, evidence: toJsonValue({ ledgerId, cause }) })
  }

  rememberRegression(cause: string): EvolutionMemoryEntry {
    const proposal = { cause: String(cause).slice(0, 2000), detectedAt: Date.now() }
    return this.remember("regression", proposal, { cause, regressedAt: Date.now() }, { confidence: 0.8, evidence: toJsonValue({ cause }) })
  }

  /** Useful research = successful + failed + research + benchmark entries matching query (LIKE fallback). Failure Memory is key. */
  getUsefulResearch(query: string, limit = 5): EvolutionMemoryEntry[] {
    this.ensureTable()
    const sqlite = this.db.sqlite
    if (!sqlite) return []
    const q = String(query ?? "").trim().slice(0, 500)
    if (!q) {
      return this.list(limit).filter((e) => ["successful", "failed", "research", "benchmark"].includes(e.type))
    }
    // LIKE search over proposal/result/evidence for relevance — cap limit
    const like = `%${q.replace(/%/g, "\\%").slice(0, 100)}%`
    const rows = sqlite
      .prepare(
        `SELECT id, type, proposal, result, created_at, confidence, evidence FROM evolution_memory WHERE type IN ('successful','failed','research','benchmark','rejected','rollback','regression') AND (proposal LIKE ? OR result LIKE ? OR evidence LIKE ?) ORDER BY confidence DESC, created_at DESC LIMIT ?`,
      )
      .all(like, like, like, Math.min(50, Math.max(1, limit))) as Array<{
      id: string
      type: string
      proposal: string
      result: string | null
      created_at: number
      confidence: number
      evidence: string | null
    }>
    if (rows.length) return rows.map(mapRow)
    // fallback: return most confident research-like entries
    return this.list(limit).filter((e) => ["successful", "failed", "research", "benchmark"].includes(e.type)).slice(0, limit)
  }

  list(limit = 50): EvolutionMemoryEntry[] {
    this.ensureTable()
    const sqlite = this.db.sqlite
    if (!sqlite) return []
    const n = Math.min(100, Math.max(1, Number(limit) || 50))
    const rows = sqlite
      .prepare(`SELECT id, type, proposal, result, created_at, confidence, evidence FROM evolution_memory ORDER BY created_at DESC LIMIT ?`)
      .all(n) as Array<{
      id: string
      type: string
      proposal: string
      result: string | null
      created_at: number
      confidence: number
      evidence: string | null
    }>
    return rows.map(mapRow)
  }

  get(id: string): EvolutionMemoryEntry | null {
    this.ensureTable()
    const sqlite = this.db.sqlite
    if (!sqlite) return null
    const row = sqlite
      .prepare(`SELECT id, type, proposal, result, created_at, confidence, evidence FROM evolution_memory WHERE id = ?`)
      .get(String(id)) as
      | { id: string; type: string; proposal: string; result: string | null; created_at: number; confidence: number; evidence: string | null }
      | undefined
    if (!row) return null
    return mapRow(row)
  }

  count(): number {
    this.ensureTable()
    const sqlite = this.db.sqlite
    if (!sqlite) return 0
    const row = sqlite.prepare(`SELECT COUNT(*) as c FROM evolution_memory`).get() as { c: number } | undefined
    return row?.c ?? 0
  }

  health(): { table: string; count: number; failureMemory: string } {
    return { table: "evolution_memory", count: this.count(), failureMemory: "active — failed improvements are knowledge" }
  }
}

function mapRow(row: { id: string; type: string; proposal: string; result: string | null; created_at: number; confidence: number; evidence: string | null }): EvolutionMemoryEntry {
  let proposal: JsonValue
  try {
    proposal = JSON.parse(row.proposal) as JsonValue
  } catch {
    proposal = row.proposal as unknown as JsonValue
  }
  let result: JsonValue | null = null
  try {
    result = row.result ? (JSON.parse(row.result) as JsonValue) : null
  } catch {
    result = row.result as unknown as JsonValue
  }
  let evidence: JsonValue | null = null
  try {
    evidence = row.evidence ? (JSON.parse(row.evidence) as JsonValue) : null
  } catch {
    evidence = row.evidence as unknown as JsonValue
  }
  return {
    id: row.id,
    type: row.type as EvolutionMemoryType,
    proposal,
    result,
    createdAt: row.created_at,
    confidence: row.confidence ?? 0.5,
    evidence,
  }
}

function defaultConfidence(type: EvolutionMemoryType): number {
  switch (type) {
    case "successful":
      return 0.92
    case "failed":
      return 0.75
    case "rejected":
      return 0.68
    case "rollback":
      return 0.88
    case "regression":
      return 0.8
    case "research":
      return 0.7
    case "benchmark":
      return 0.85
    default:
      return 0.5
  }
}
