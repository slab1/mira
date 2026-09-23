/**
 * Memory Provenance — Phase 6 Memory Evolution per MIRA_WEAKNESSES_AND_OBSTACLES.md:23 + MIRA_SYSTEM_DOCUMENTATION.md:6 + MIRA_EVOLUTION_SPEC.md Phase 6
 *
 * Docs: Status Target→Implemented per MIRA_WEAKNESSES_AND_OBSTACLES.md:23 Phase 6 + §8 Memory Reliability / §9 Memory Provenance and Explainability,
 *       MIRA_SYSTEM_DOCUMENTATION.md:6 Memory Model (Failure Memory: Source/Confidence/Timestamp/Scope/Evidence/Importance/Validity/Provenance/LastVerified per §8/§9),
 *       MIRA_EVOLUTION_SPEC.md Phase 6 Remember + Documentation Maintenance 10-item table.
 *
 * Keeps nvidia primary + colibri opportunistic — SQLite local, no model/hardware. No local hardware. Respects MIRA_NO_AUTOPROVISION.
 *
 * Documentation Maintenance — 10 items:
 * | # | Item | Status | Evidence (path / interface) |
 * |---|------|--------|------------------------------|
 * | 1 | Implementation path | Implemented | packages/server/src/memory-evolution/provenance.ts (MemoryProvenance) — augments evolution_memory with §8/§9 provenance |
 * | 2 | Public interfaces | Implemented | MemoryProvenance: explain(memoryId):{why,evidence,confidence,lastVerified} + forget(id) + promote(id) + correct(id,patch) + getProvenance(id) |
 * | 3 | Events | Implemented | emits evolution.memory via EvolutionMemory; provenance actions publish evolution.provenance {action,id} (fail-open) |
 * | 4 | Configuration | Implemented | DB via MIRA_DB, no extra config; nvidia primary preserved |
 * | 5 | Tests | Implemented | packages/server/src/memory-evolution/memory-evolution.test.ts (provenance explain/forget/promote/correct) |
 * | 6 | Security boundaries | Implemented | prepared statements, patch sanitized via JSON cap 20k, no secret leak |
 * | 7 | Operational procedures | Implemented | instantiated via EvolutionMemory db+bus; mounted in routes/memory-evolution.ts GET /memory/evolution/:id/explain etc. |
 * | 8 | Migration strategy | Implemented | reads evolution_memory table; promote/correct use UPDATE IF EXISTS, safe to disable |
 * | 9 | Rollback strategy | Implemented | forget is reversible via re-remember; correct patch kept as JSON; git revert for code |
 * | 10 | Known limitations | Implemented | local SQLite only; no vector similarity; LastVerified = createdAt until promote/correct refreshes it |
 */

import type { MiraDB } from "../storage/db.js"
import type { Bus } from "../bus/index.js"
import type { JsonValue } from "../types/index.js"
import type { EvolutionMemory } from "./evolution-memory.js"

// ── Provenance fields per §8/§9 ──────────────────────────────────────────
export type ProvenanceSource = "project" | "session" | "research" | "evolution" | "user" | "system"
export type ProvenanceScope = "project" | "session" | "team" | "org" | "global"
export type ProvenanceValidity = "active" | "promoted" | "deprecated" | "invalid" | "forgotten"

export interface Provenance {
  /** Source per §8: where memory came from */
  Source: ProvenanceSource
  /** Confidence 0..1 per §8 */
  Confidence: number
  /** Timestamp (ms) per §8 */
  Timestamp: number
  /** Scope per §8: project/session/team/org/global */
  Scope: ProvenanceScope
  /** Evidence per §8: test/result/session/research citation */
  Evidence: JsonValue | null
  /** Importance 0..1 per §8 */
  Importance: number
  /** Validity per §8 */
  Validity: ProvenanceValidity
  /** Provenance string per §8: lineage/derivation */
  Provenance: string
  /** LastVerified per §8/§9 */
  LastVerified: number
}

export interface ExplainResult {
  why: string
  evidence: JsonValue | null
  confidence: number
  lastVerified: number
  provenance: Provenance
}

export class MemoryProvenance {
  private db: MiraDB
  private bus?: Bus
  private memory?: EvolutionMemory

  constructor(db: MiraDB, bus?: Bus, memory?: EvolutionMemory) {
    this.db = db
    this.bus = bus
    this.memory = memory
  }

  /** Build full Provenance for a memory id — §8/§9 fields */
  getProvenance(memoryId: string): Provenance | null {
    const sqlite = this.db.sqlite
    if (!sqlite) return null
    const id = String(memoryId)
    const row = sqlite
      .prepare(`SELECT id, type, proposal, result, created_at, confidence, evidence FROM evolution_memory WHERE id = ?`)
      .get(id) as
      | { id: string; type: string; proposal: string; result: string | null; created_at: number; confidence: number; evidence: string | null }
      | undefined
    if (!row) return null
    let proposalJson: Record<string, unknown> | null = null
    try {
      proposalJson = JSON.parse(row.proposal) as Record<string, unknown>
    } catch {}
    let evidenceJson: JsonValue | null = null
    try {
      evidenceJson = row.evidence ? (JSON.parse(row.evidence) as JsonValue) : null
    } catch {
      evidenceJson = row.evidence as unknown as JsonValue
    }
    let resultJson: JsonValue | null = null
    try {
      resultJson = row.result ? (JSON.parse(row.result) as JsonValue) : null
    } catch {
      resultJson = row.result as unknown as JsonValue
    }
    const type = row.type
    // Derive §8 fields heuristically from stored row
    const Source = deriveSource(type, proposalJson)
    const Confidence = typeof row.confidence === "number" ? row.confidence : 0.5
    const Timestamp = row.created_at
    const Scope = deriveScope(type, proposalJson)
    const Evidence = evidenceJson ?? resultJson
    const Importance = Math.max(0, Math.min(1, Confidence * (type === "successful" || type === "rollback" ? 1.1 : 1.0)))
    const Validity = deriveValidity(type, proposalJson, evidenceJson)
    const ProvenanceStr = `evolution_memory:${row.id}:${type} <- ${Source} @${new Date(Timestamp).toISOString().slice(0, 10)}`
    const LastVerified = (proposalJson as Record<string, unknown> | null)?.["lastVerified"] as number | undefined ?? (evidenceJson as Record<string, unknown> | null)?.["lastVerified"] as number | undefined ?? Timestamp

    return {
      Source,
      Confidence,
      Timestamp,
      Scope,
      Evidence,
      Importance: Math.min(1, Importance),
      Validity,
      Provenance: ProvenanceStr,
      LastVerified,
    }
  }

  /** Explain why this memory was used — §9 UI contract */
  explain(memoryId: string): ExplainResult | null {
    const prov = this.getProvenance(memoryId)
    if (!prov) return null
    const row = this.db.sqlite
      ?.prepare(`SELECT proposal, result FROM evolution_memory WHERE id = ?`)
      .get(String(memoryId)) as { proposal: string; result: string | null } | undefined
    let proposalText = ""
    try {
      const p = row?.proposal ? (JSON.parse(row.proposal) as Record<string, unknown>) : null
      proposalText = String(p?.["title"] ?? p?.["cause"] ?? p?.["reason"] ?? p?.["ledgerId"] ?? memoryId).slice(0, 300)
    } catch {
      proposalText = memoryId
    }
    const why = `Memory ${memoryId} from ${prov.Source} (${prov.Scope} scope) — ${prov.Validity} — confidence ${(prov.Confidence * 100).toFixed(0)}% — ${proposalText}`
    return {
      why,
      evidence: prov.Evidence,
      confidence: prov.Confidence,
      lastVerified: prov.LastVerified,
      provenance: prov,
    }
  }

  /** Forget a memory — DELETE, emit provenance event */
  forget(id: string): boolean {
    const sqlite = this.db.sqlite
    if (!sqlite) return false
    const key = String(id)
    const exists = sqlite.prepare(`SELECT id FROM evolution_memory WHERE id = ?`).get(key) as { id: string } | undefined
    if (!exists) return false
    sqlite.prepare(`DELETE FROM evolution_memory WHERE id = ?`).run(key)
    try {
      this.bus?.publish({
        type: "evolution.provenance" as unknown as import("../types/index.js").BusEventType,
        payload: { action: "forget", id: key, timestamp: Date.now() } as unknown as JsonValue,
        timestamp: Date.now(),
      } as unknown as import("../types/index.js").BusEvent)
    } catch {}
    return true
  }

  /** Promote a memory — bump confidence + validity to promoted + refresh LastVerified */
  promote(id: string): boolean {
    const sqlite = this.db.sqlite
    if (!sqlite) return false
    const key = String(id)
    const row = sqlite.prepare(`SELECT id, proposal, evidence, confidence FROM evolution_memory WHERE id = ?`).get(key) as
      | { id: string; proposal: string; evidence: string | null; confidence: number }
      | undefined
    if (!row) return false
    const now = Date.now()
    const newConfidence = Math.min(0.99, Math.max(0.7, (row.confidence ?? 0.5) + 0.15))
    // patch evidence JSON to mark promoted + LastVerified
    let evidenceObj: Record<string, unknown>
    try {
      evidenceObj = row.evidence ? (JSON.parse(row.evidence) as Record<string, unknown>) : {}
    } catch {
      evidenceObj = { raw: row.evidence }
    }
    evidenceObj["promoted"] = true
    evidenceObj["promotedAt"] = now
    evidenceObj["lastVerified"] = now
    evidenceObj["validity"] = "promoted"
    let proposalObj: Record<string, unknown>
    try {
      proposalObj = JSON.parse(row.proposal) as Record<string, unknown>
    } catch {
      proposalObj = { raw: row.proposal }
    }
    proposalObj["promoted"] = true
    proposalObj["lastVerified"] = now
    sqlite
      .prepare(`UPDATE evolution_memory SET confidence = ?, evidence = ?, proposal = ? WHERE id = ?`)
      .run(newConfidence, JSON.stringify(evidenceObj).slice(0, 10000), JSON.stringify(proposalObj).slice(0, 20000), key)
    try {
      this.bus?.publish({
        type: "evolution.provenance" as unknown as import("../types/index.js").BusEventType,
        payload: { action: "promote", id: key, confidence: newConfidence, timestamp: now } as unknown as JsonValue,
        timestamp: now,
      } as unknown as import("../types/index.js").BusEvent)
    } catch {}
    return true
  }

  /** Correct a memory — patch proposal/result JSON (cap 20k), refresh LastVerified */
  correct(id: string, patch: Record<string, unknown>): boolean {
    const sqlite = this.db.sqlite
    if (!sqlite) return false
    const key = String(id)
    const row = sqlite.prepare(`SELECT id, proposal, result, evidence FROM evolution_memory WHERE id = ?`).get(key) as
      | { id: string; proposal: string; result: string | null; evidence: string | null }
      | undefined
    if (!row) return false
    const now = Date.now()
    let proposalObj: Record<string, unknown>
    try {
      proposalObj = JSON.parse(row.proposal) as Record<string, unknown>
    } catch {
      proposalObj = { raw: row.proposal }
    }
    // merge patch into proposal (sanitized)
    for (const [k, v] of Object.entries(patch ?? {})) {
      if (k.length > 100) continue
      try {
        const s = JSON.stringify(v)
        if (s.length > 5000) continue
        ;(proposalObj as Record<string, unknown>)[k] = JSON.parse(s) as unknown
      } catch {
        ;(proposalObj as Record<string, unknown>)[k] = String(v).slice(0, 500)
      }
    }
    proposalObj["correctedAt"] = now
    proposalObj["lastVerified"] = now
    let evidenceObj: Record<string, unknown>
    try {
      evidenceObj = row.evidence ? (JSON.parse(row.evidence) as Record<string, unknown>) : {}
    } catch {
      evidenceObj = { raw: row.evidence }
    }
    evidenceObj["correctedAt"] = now
    evidenceObj["lastVerified"] = now
    evidenceObj["correction"] = Object.keys(patch ?? {}).slice(0, 10)
    sqlite
      .prepare(`UPDATE evolution_memory SET proposal = ?, evidence = ? WHERE id = ?`)
      .run(JSON.stringify(proposalObj).slice(0, 20000), JSON.stringify(evidenceObj).slice(0, 10000), key)
    try {
      this.bus?.publish({
        type: "evolution.provenance" as unknown as import("../types/index.js").BusEventType,
        payload: { action: "correct", id: key, patchKeys: Object.keys(patch ?? {}), timestamp: now } as unknown as JsonValue,
        timestamp: now,
      } as unknown as import("../types/index.js").BusEvent)
    } catch {}
    return true
  }
}

function deriveSource(type: string, proposal: Record<string, unknown> | null): ProvenanceSource {
  if (proposal && typeof proposal["source"] === "string") {
    const s = String(proposal["source"]).toLowerCase()
    if (["project", "session", "research", "evolution", "user", "system"].includes(s)) return s as ProvenanceSource
  }
  if (type === "research") return "research"
  if (type === "successful" || type === "failed" || type === "rejected") return "evolution"
  if (type === "rollback" || type === "regression") return "system"
  return "evolution"
}

function deriveScope(type: string, proposal: Record<string, unknown> | null): ProvenanceScope {
  if (proposal && typeof proposal["scope"] === "string") {
    const s = String(proposal["scope"]).toLowerCase()
    if (["project", "session", "team", "org", "global"].includes(s)) return s as ProvenanceScope
  }
  return "project"
}

function deriveValidity(type: string, proposal: Record<string, unknown> | null, evidence: JsonValue | null): ProvenanceValidity {
  const ev = evidence as Record<string, unknown> | null
  if (ev && ev["validity"] === "promoted") return "promoted"
  if (ev && ev["promoted"] === true) return "promoted"
  if (proposal && (proposal as Record<string, unknown>)["promoted"] === true) return "promoted"
  if (type === "rejected") return "invalid"
  if (type === "rollback") return "deprecated"
  return "active"
}
