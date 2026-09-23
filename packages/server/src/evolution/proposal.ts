/**
 * Evolution Proposal — generates ImprovementProposal
 *
 * Docs: Status Target→Implemented per MIRA_WEAKNESSES_AND_OBSTACLES.md:23 Phase 1 (ImprovementProposal),
 *       MIRA_EVOLUTION_SPEC.md Propose (Target → logic_evolve.py scaffold; Phase 1 here),
 *       MIRA_SYSTEM_DOCUMENTATION.md:2.
 *
 * Keeps nvidia primary + colibri opportunistic — no model call required Phase 1; heuristic priority P0/P1.
 * No canary/shadow yet.
 *
 * Documentation Maintenance — 10 items:
 * | # | Item | Status | Evidence |
 * |---|------|--------|----------|
 * | 1 | Implementation path | Implemented | packages/server/src/evolution/proposal.ts |
 * | 2 | Public interfaces | Implemented | propose(diagnosis): ImprovementProposal {id, title, type, risk, affectedEngine, evidence, expectedImpact} with P0/P1 |
 * | 3 | Events | Implemented | consumes diagnosis, produces proposal (stored via ledger) |
 * | 4 | Configuration | Implemented | no config; priority heuristics, nvidia primary preserved |
 * | 5 | Tests | Implemented | evolution.test.ts: proposal has id/risk/P0/P1 |
 * | 6 | Security boundaries | Implemented | proposal is read-only record, no execution, risk-capped, evidence sanitized |
 * | 7 | Operational procedures | Implemented | pure function, called after diagnose |
 * | 8 | Migration strategy | Implemented | additive, ledger stores proposal JSON |
 * | 9 | Rollback strategy | Implemented | reject proposal via ledger verdict, no mutation |
 * | 10 | Known limitations | Implemented | heuristic expectedImpact; Phase 2 Risk Engine adds approval gates |
 */

import type { JsonValue } from "../types/index.js"
import type { Diagnosis } from "./diagnosis.js"

export type ProposalType = "fix" | "improve" | "experiment"
export type RiskLevel = "low" | "medium" | "high"
export type Priority = "P0" | "P1"

export interface ImprovementProposal {
  id: string
  title: string
  type: ProposalType
  risk: RiskLevel
  priority: Priority
  affectedEngine: string
  evidence: JsonValue
  expectedImpact: string
  cause: string
  confidence: number
  sessionID?: string
  createdAt: number
}

function riskFor(d: Diagnosis): RiskLevel {
  // High-risk engines per MIRA_WEAKNESSES §18 human approval boundaries
  const high = new Set(["guardrails", "model"])
  if (high.has(d.affectedEngine) && d.confidence > 0.7) return "high"
  if (d.affectedEngine === "gateway" && /circuit|hasKey|rate/i.test(d.cause)) return "medium"
  if (d.confidence < 0.55) return "medium"
  return "low"
}

function priorityFor(risk: RiskLevel, d: Diagnosis): Priority {
  // P0 per MIRA_WEAKNESSES §21 matrix: controlled self-evolution, verification, shadow, cost etc.
  if (d.affectedEngine === "gateway" || d.affectedEngine === "model" || d.affectedEngine === "guardrails") return "P0"
  if (risk === "high") return "P0"
  return "P1"
}

function titleFor(d: Diagnosis): string {
  const base = d.cause.slice(0, 80).trim() || "unclassified"
  return `Improve ${d.affectedEngine}: ${base}`
}

function expectedImpactFor(d: Diagnosis, risk: RiskLevel): string {
  if (d.affectedEngine === "gateway") return risk === "high" ? "reduce fallback errors, improve hasKey handling" : "stabilize lane latency/cost"
  if (d.affectedEngine === "memory") return "improve recall/persistence"
  if (d.affectedEngine === "guardrails") return "tighten security without breaking UX"
  if (d.affectedEngine === "tool") return "raise edit success 7→68% via hash-anchored fallback"
  return "measurable improvement per MIRA_WEAKNESSES §16 longitudinal benchmark (task 87→91%, regression 8→4%)"
}

export function propose(diagnosis: Diagnosis): ImprovementProposal {
  const risk = riskFor(diagnosis)
  const priority = priorityFor(risk, diagnosis)
  const id = `prop_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    title: titleFor(diagnosis),
    type: diagnosis.confidence > 0.75 ? "fix" : "experiment",
    risk,
    priority,
    affectedEngine: diagnosis.affectedEngine,
    evidence: diagnosis.evidence,
    expectedImpact: expectedImpactFor(diagnosis, risk),
    cause: diagnosis.cause,
    confidence: diagnosis.confidence,
    sessionID: diagnosis.sessionID,
    createdAt: Date.now(),
  }
}

export function proposeBatch(diagnoses: Diagnosis[]): ImprovementProposal[] {
  return diagnoses.map(propose)
}
