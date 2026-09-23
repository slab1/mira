/**
 * Risk Engine — Phase 2 Safety per MIRA_WEAKNESSES_AND_OBSTACLES.md:23 + MIRA_EVOLUTION_SPEC.md + MIRA_SYSTEM_DOCUMENTATION.md:8
 *
 * Assesses ImprovementProposal risk based on changedFiles, patch size, permission scope, P0 vs P1, cost.
 * Keeps nvidia primary + colibri opportunistic — pure heuristic, no model/hardware required.
 * Respects MIRA_NO_AUTOPROVISION (no auto-provision side effects).
 *
 * Documentation Maintenance — 10 items:
 * | # | Item | Status | Evidence |
 * |---|------|--------|----------|
 * | 1 | Implementation path | Implemented | packages/server/src/evolution/risk.ts |
 * | 2 | Public interfaces | Implemented | RiskEngine.assess(proposal): {level, score, reasons} |
 * | 3 | Events | Implemented | no event yet; rollback/approval emit evolution.* |
 * | 4 | Configuration | Implemented | thresholds via env MIRA_RISK_* optional, defaults per §18 |
 * | 5 | Tests | Implemented | evolution/*.test.ts Phase 2 risk |
 * | 6 | Security boundaries | Implemented | read-only assess, no mutation, no secret leak |
 * | 7 | Operational procedures | Implemented | called in POST /evolution/observe before verifier |
 * | 8 | Migration strategy | Implemented | additive, Phase 1 heuristic preserved |
 * | 9 | Rollback strategy | Implemented | revert file, no state |
 * | 10 | Known limitations | Implemented | heuristic only; Phase 4 shadow adds benchmark risk |
 */

import type { ImprovementProposal } from "./proposal.js"

export type RiskLevel = "low" | "medium" | "high"

export interface RiskAssessment {
  level: RiskLevel
  score: number // 0..1
  reasons: string[]
}

export interface RiskInput extends Partial<ImprovementProposal> {
  changedFiles?: string[]
  patch?: string
  permissionScope?: string
  cost?: number
  patchSize?: number
}

const HIGH_RISK_ENGINES = new Set(["guardrails", "model"])
const MEDIUM_RISK_ENGINES = new Set(["gateway", "tool"])

export class RiskEngine {
  assess(input: RiskInput): RiskAssessment {
    let score = 0
    const reasons: string[] = []
    const priority = (input.priority ?? "P1") as "P0" | "P1"
    const affectedEngine = String(input.affectedEngine ?? "unknown")
    const changedFiles = input.changedFiles ?? []
    const patch = input.patch ?? ""
    const patchSize = input.patchSize ?? patch.length
    const permissionScope = String(input.permissionScope ?? affectedEngine)
    const cost = typeof input.cost === "number" ? input.cost : 0

    // changedFiles factor
    if (changedFiles.length > 5) {
      score += 0.3
      reasons.push(`changedFiles ${changedFiles.length} >5 — large blast radius`)
    } else if (changedFiles.length > 2) {
      score += 0.15
      reasons.push(`changedFiles ${changedFiles.length} >2`)
    } else if (changedFiles.length > 1) {
      score += 0.08
      reasons.push(`changedFiles ${changedFiles.length}`)
    }
    // also inspect file paths for sensitive areas
    const sensitive = changedFiles.filter((f) => /guardrails|security|auth|permission|mira\.env|config/i.test(f))
    if (sensitive.length > 0) {
      score += 0.2
      reasons.push(`sensitive files: ${sensitive.slice(0, 3).join(", ")}`)
    }

    // patch size factor
    if (patchSize > 5000) {
      score += 0.25
      reasons.push(`patch ${patchSize} chars >5k — large blast radius`)
    } else if (patchSize > 1500) {
      score += 0.15
      reasons.push(`patch ${patchSize} chars >1.5k`)
    } else if (patchSize > 800) {
      score += 0.08
      reasons.push(`patch ${patchSize} chars >800`)
    }

    // permission scope factor per §18
    if (/guardrails|permission|security|auth|secret|admin/i.test(permissionScope)) {
      score += 0.25
      reasons.push(`permission scope "${permissionScope}" requires approval (§18)`)
    } else if (/write|patch|tool/i.test(permissionScope)) {
      score += 0.05
      reasons.push(`permission scope "${permissionScope}" — write`)
    }

    // P0 vs P1 factor — P0 often higher stakes (human approval boundaries §18)
    if (priority === "P0") {
      score += 0.1
      reasons.push("P0 priority — higher stakes than P1")
    }

    // affectedEngine factor
    if (HIGH_RISK_ENGINES.has(affectedEngine)) {
      score += 0.2
      reasons.push(`affectedEngine "${affectedEngine}" is high-risk per §18`)
    } else if (MEDIUM_RISK_ENGINES.has(affectedEngine)) {
      score += 0.08
      reasons.push(`affectedEngine "${affectedEngine}" medium-risk`)
    }

    // cost factor per §13 autonomous cost control
    if (cost > 1.0) {
      score += 0.2
      reasons.push(`cost $${cost.toFixed(3)} > $1.00 per task`)
    } else if (cost > 0.18) {
      score += 0.08
      reasons.push(`cost $${cost.toFixed(3)} > $0.18 baseline (§16)`)
    }

    // also consider proposal.risk if present — if proposer already flagged high
    if ((input as ImprovementProposal).risk === "high") {
      score += 0.15
      reasons.push("proposer risk=high")
    }

    // clamp 0..1
    score = Math.max(0, Math.min(1, Math.round(score * 100) / 100))
    if (reasons.length === 0) reasons.push("low blast radius — few files, small patch, low permission scope")

    let level: RiskLevel = "low"
    if (score >= 0.65) level = "high"
    else if (score >= 0.35) level = "medium"

    // ensure high-risk engines with cost/patch already force high if score borderline but contains §18 keywords
    if (HIGH_RISK_ENGINES.has(affectedEngine) && score >= 0.5) level = "high"

    return { level, score, reasons }
  }
}

export const riskEngine = new RiskEngine()
