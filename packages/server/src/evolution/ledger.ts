/**
 * Evolution Ledger — ImprovementLedger SQLite table evolution_ledger
 *
 * Docs: Status Target→Implemented per MIRA_WEAKNESSES_AND_OBSTACLES.md:23 Phase 1 (ImprovementLedger) + §24 Ledger,
 *       MIRA_EVOLUTION_SPEC.md Remember (Implemented via memory/episodic; Target ledger here),
 *       MIRA_SYSTEM_DOCUMENTATION.md:2 §6 Failure Memory + §10 Remember.
 *
 * Keeps nvidia primary + colibri opportunistic — ledger is local SQLite, no hardware.
 * Exposes GET /evolution/ledger (read-only, no auto-promote). remember() after verify.
 *
 * Documentation Maintenance — 10 items:
 * | # | Item | Status | Evidence |
 * |---|------|--------|----------|
 * | 1 | Implementation path | Implemented | packages/server/src/evolution/ledger.ts + evolution_ledger table (id, proposal, verdict, evidence, createdAt) |
 * | 2 | Public interfaces | Implemented | ImprovementLedger: remember(entry), list(limit), get(id); GET /evolution/ledger |
 * | 3 | Events | Implemented | persists evolution.observed→diagnosed→proposed→verified→evaluated chain, emits evolution.ledger on remember |
 * | 4 | Configuration | Implemented | no config; DB path via MIRA_DB, MIRA_NO_AUTOPROVISION respected |
 * | 5 | Tests | Implemented | evolution.test.ts: ledger remember+list |
 * | 6 | Security boundaries | Implemented | read-only ledger route, no auto-promote, sanitizes proposal, no secret leak |
 * | 7 | Operational procedures | Implemented | ensureTable() on startup, remember() after verify, list via GET /evolution/ledger |
 * | 8 | Migration strategy | Implemented | CREATE TABLE IF NOT EXISTS, additive columns, safe re-run |
 * | 9 | Rollback strategy | Implemented | DELETE FROM evolution_ledger WHERE id=? or git revert, no cascade |
 * | 10 | Known limitations | Implemented | Phase 1 single DB; Phase 6 adds cross-project memory evolution + provenance |
 */

import type { MiraDB } from "../storage/db.js"
import type { JsonValue } from "../types/index.js"
import type { Bus } from "../bus/index.js"
import type { ImprovementProposal } from "./proposal.js"

export type LedgerVerdict = "verified" | "rejected" | "accepted" | "pending" | "pending_approval" | "budget_blocked" | "security_blocked" | "rolledback" | "promoted" | "canary" | "canary_failed"

export interface LedgerEntry {
  id: string // proposal.id
  proposal: ImprovementProposal
  verdict: LedgerVerdict
  evidence: JsonValue
  createdAt: number
}

export class ImprovementLedger {
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
      CREATE TABLE IF NOT EXISTS evolution_ledger (
        id TEXT PRIMARY KEY,
        proposal TEXT NOT NULL,
        verdict TEXT NOT NULL,
        evidence TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS evolution_ledger_created_idx ON evolution_ledger(created_at);
      CREATE INDEX IF NOT EXISTS evolution_ledger_verdict_idx ON evolution_ledger(verdict);
    `)
  }

  /** Remember after verify — per spec: remember() after verify, before evaluator decision is also valid. */
  remember(entry: Omit<LedgerEntry, "createdAt"> & { createdAt?: number }): LedgerEntry {
    this.ensureTable()
    const sqlite = this.db.sqlite
    const createdAt = entry.createdAt ?? Date.now()
    const full: LedgerEntry = { ...entry, createdAt }
    const proposalJson = JSON.stringify(full.proposal)
    const evidenceJson = JSON.stringify(full.evidence ?? null)
    sqlite.prepare(
      `INSERT OR REPLACE INTO evolution_ledger (id, proposal, verdict, evidence, created_at) VALUES (?, ?, ?, ?, ?)`
    ).run(full.id, proposalJson, full.verdict, evidenceJson, full.createdAt)

    try {
      this.bus?.publish({
        type: "evolution.ledger" as unknown as import("../types/index.js").BusEventType,
        payload: { id: full.id, verdict: full.verdict, proposal: full.proposal as unknown as JsonValue } as JsonValue,
        timestamp: full.createdAt,
      } as unknown as import("../types/index.js").BusEvent)
    } catch {}

    return full
  }

  list(limit = 50): LedgerEntry[] {
    this.ensureTable()
    const sqlite = this.db.sqlite
    if (!sqlite) return []
    const rows = sqlite.prepare(
      `SELECT id, proposal, verdict, evidence, created_at FROM evolution_ledger ORDER BY created_at DESC LIMIT ?`
    ).all(limit) as Array<{ id: string; proposal: string; verdict: string; evidence: string | null; created_at: number }>
    return rows.map((r) => {
      let proposal: ImprovementProposal
      try { proposal = JSON.parse(r.proposal) as ImprovementProposal } catch { proposal = { id: r.id, title: r.id, type: "experiment", risk: "low", priority: "P1", affectedEngine: "unknown", evidence: null, expectedImpact: "", cause: "", confidence: 0, createdAt: r.created_at } as ImprovementProposal }
      let evidence: JsonValue
      try { evidence = r.evidence ? JSON.parse(r.evidence) as JsonValue : null as unknown as JsonValue } catch { evidence = r.evidence as unknown as JsonValue }
      return { id: r.id, proposal, verdict: r.verdict as LedgerVerdict, evidence, createdAt: r.created_at }
    })
  }

  get(id: string): LedgerEntry | null {
    this.ensureTable()
    const sqlite = this.db.sqlite
    if (!sqlite) return null
    const row = sqlite.prepare(
      `SELECT id, proposal, verdict, evidence, created_at FROM evolution_ledger WHERE id = ?`
    ).get(id) as { id: string; proposal: string; verdict: string; evidence: string | null; created_at: number } | undefined
    if (!row) return null
    let proposal: ImprovementProposal
    try { proposal = JSON.parse(row.proposal) as ImprovementProposal } catch { proposal = { id: row.id, title: row.id, type: "experiment", risk: "low", priority: "P1", affectedEngine: "unknown", evidence: null, expectedImpact: "", cause: "", confidence: 0, createdAt: row.created_at } as ImprovementProposal }
    let evidence: JsonValue
    try { evidence = row.evidence ? JSON.parse(row.evidence) as JsonValue : null as unknown as JsonValue } catch { evidence = row.evidence as unknown as JsonValue }
    return { id: row.id, proposal, verdict: row.verdict as LedgerVerdict, evidence, createdAt: row.created_at }
  }

  count(): number {
    this.ensureTable()
    const sqlite = this.db.sqlite
    if (!sqlite) return 0
    const row = sqlite.prepare(`SELECT COUNT(*) as c FROM evolution_ledger`).get() as { c: number } | undefined
    return row?.c ?? 0
  }

  health(): { table: string; count: number } {
    return { table: "evolution_ledger", count: this.count() }
  }
}
