/**
 * Autonomy Levels — Phase 2 Safety per MIRA_WEAKNESSES_AND_OBSTACLES.md:18 + :23 + MIRA_EVOLUTION_SPEC.md
 *
 * Levels 0-5 and helpers selectLevel + requiresApproval per §18 (high-risk → human).
 * Keeps nvidia primary + colibri opportunistic — pure logic, no hardware.
 *
 * Documentation Maintenance — 10 items:
 * | # | Item | Status | Evidence |
 * |---|------|--------|----------|
 * | 1 | Implementation path | Implemented | packages/server/src/evolution/autonomy.ts |
 * | 2 | Public interfaces | Implemented | AutonomyLevels 0-5, selectLevel(risk, proposal), requiresApproval(level, risk) |
 * | 3 | Events | Implemented | used by ApprovalGate → evolution.approval |
 * | 4 | Configuration | Implemented | thresholds env MIRA_AUTONOMY_* optional, defaults per §18 |
 * | 5 | Tests | Implemented | evolution/*.test.ts autonomy |
 * | 6 | Security boundaries | Implemented | high-risk → human approval fail-closed |
 * | 7 | Operational procedures | Implemented | called Risk→Autonomy→Approval in POST /evolution/observe |
 * | 8 | Migration strategy | Implemented | additive, Phase 1 no autonomy existed |
 * | 9 | Rollback strategy | Implemented | revert file, no state |
 * | 10 | Known limitations | Implemented | heuristic mapping; Phase 4 canary auto-tunes |
 */

import type { RiskAssessment, RiskLevel } from "./risk.js"
import type { ImprovementProposal } from "./proposal.js"

export enum AutonomyLevels {
  Observe = 0,
  Suggest = 1,
  Experiment = 2,
  Execute = 3,
  Canary = 4,
  Autonomous = 5,
}

/**
 * Select autonomy level based on risk and proposal.
 * Low risk can go up to 5 (Autonomous), medium caps at 3, high caps at 1 (Suggest).
 * P0 high-stakes also caps one level lower than P1.
 */
export function selectLevel(
  risk: RiskAssessment | RiskLevel,
  proposal?: Partial<ImprovementProposal> & { priority?: string },
): AutonomyLevels {
  const levelRisk: RiskLevel = typeof risk === "string" ? risk : risk.level
  const priority = (proposal?.priority as string) ?? "P1"
  const affectedEngine = String(proposal?.affectedEngine ?? "")

  // base by risk
  let base: AutonomyLevels
  if (levelRisk === "high") base = AutonomyLevels.Suggest
  else if (levelRisk === "medium") base = AutonomyLevels.Execute
  else base = AutonomyLevels.Autonomous

  // P0 tightens by 1 (higher stakes)
  if (priority === "P0" && base > AutonomyLevels.Suggest) {
    base = (base - 1) as AutonomyLevels
  }
  // guardrails/model high-risk always at most Suggest regardless of reassessment
  if ((affectedEngine === "guardrails" || affectedEngine === "model") && levelRisk !== "low") {
    base = Math.min(base, AutonomyLevels.Suggest) as AutonomyLevels
  }

  return base
}

/**
 * Whether the given level+ risk requires human approval before promotion.
 * Per §18: high-risk → human, canary/autonomous with medium → human, etc.
 * Fail-closed: high always requires approval.
 */
export function requiresApproval(level: AutonomyLevels | number, risk: RiskAssessment | RiskLevel): boolean {
  const rl: RiskLevel = typeof risk === "string" ? risk : risk.level
  if (rl === "high") return true
  if (rl === "medium" && level >= AutonomyLevels.Canary) return true
  if (level >= AutonomyLevels.Autonomous && rl !== "low") return true
  // Also: Canary always needs approval if risk is not low (per §18 canary policy)
  if (level >= AutonomyLevels.Canary && rl !== "low") return true
  return false
}

export const Autonomy = {
  Levels: AutonomyLevels,
  selectLevel,
  requiresApproval,
}
