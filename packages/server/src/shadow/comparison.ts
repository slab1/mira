/**
 * Shadow Comparison — Phase 4 per MIRA_WEAKNESSES_AND_OBSTACLES.md:23 + MIRA_EVOLUTION_SPEC.md Phase 4 + MIRA_SYSTEM_DOCUMENTATION.md:11 Shadow Mira
 *
 * Status: Target→Implemented — evaluates Candidate vs Production per §16 (success/latency/cost/regression/security, +20%/-0.5pp gates)
 * Keeps nvidia primary + colibri opportunistic, respects MIRA_NO_AUTOPROVISION, no local hardware.
 *
 * Gates (MIRA_EVOLUTION_SPEC.md Promote / Roll Back — Policy + MIRA_WEAKNESSES §16):
 *   success: candidate must be ≥ baseline -0.5pp (0.005)
 *   latency: candidate must be ≤ baseline +20%
 *   cost: candidate must be ≤ baseline +20%
 *   regression: candidate regressionRate ≤ baseline +0.005
 *   security: candidate securityViolations ≤ baseline AND securityPassed true
 * Verdict: 'better'|'worse'|'neutral' with reasoning (better = passes all gates + improves ≥1 dimension)
 *
 * Documentation Maintenance — 10 items:
 * | # | Item | Status | Evidence (path / interface) |
 * |---|------|--------|------------------------------|
 * | 1 | Implementation path | Implemented | packages/server/src/shadow/comparison.ts (ShadowComparison) |
 * | 2 | Public interfaces | Implemented | ShadowComparison.compare(production, candidate): {verdict:'better'|'worse'|'neutral', reasoning, scores:{success,latency,cost,regression,security}} |
 * | 3 | Events | Implemented | pure comparison; caller emits evolution.shadowed with verdict |
 * | 4 | Configuration | Implemented | thresholds via env MIRA_SHADOW_* optional, defaults +20%/-0.5pp per spec; nvidia primary |
 * | 5 | Tests | Implemented | packages/server/src/shadow/shadow.test.ts comparison gates |
 * | 6 | Security boundaries | Implemented | fail-closed: security regression → worse; no secret leak |
 * | 7 | Operational procedures | Implemented | invoked by ShadowMira.compare() + POST /shadow/:id/compare |
 * | 8 | Migration strategy | Implemented | additive; reuses evaluator gate math, no DB change |
 * | 9 | Rollback strategy | Implemented | worse → recommend rollback; neutral → no promotion |
 * | 10 | Known limitations | Implemented | heuristic; longitudinal 87%→91% Phase 6 is Target |
 */

import type { JsonValue } from '../types/index.js'

export type ShadowVerdict = 'better' | 'worse' | 'neutral'

export interface ShadowScores {
  success: { baseline: number; candidate: number; delta: number; pass: boolean }
  latency: { baseline: number; candidate: number; deltaPct: number; pass: boolean }
  cost: { baseline: number; candidate: number; deltaPct: number; pass: boolean }
  regression: { baseline: number; candidate: number; delta: number; pass: boolean }
  security: { baseline: number; candidate: number; pass: boolean }
}

export interface ShadowComparisonResult {
  verdict: ShadowVerdict
  reasoning: string
  scores: ShadowScores
  gates: { success: boolean; latency: boolean; cost: boolean; regression: boolean; security: boolean }
  allPass: boolean
  improved: string[]
  regressed: string[]
  timestamp: number
  details?: JsonValue
}

export interface ComparisonInput {
  successRate: number // 0..1
  latencyMs: number
  costPerTask: number
  regressionRate: number // 0..1
  securityViolations: number
  securityPassed?: boolean
}

function pctDelta(candidate: number, baseline: number): number {
  if (baseline === 0) return candidate === 0 ? 0 : 100
  return ((candidate - baseline) / baseline) * 100
}

function envNum(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

export class ShadowComparison {
  /**
   * Evaluate candidate vs production per §16 +20%/-0.5pp gates.
   * Returns verdict: 'better'|'worse'|'neutral' with reasoning.
   */
  compare(production: ComparisonInput, candidate: ComparisonInput): ShadowComparisonResult {
    const latencyGatePct = envNum('MIRA_SHADOW_LATENCY_GATE_PCT', 20)
    const costGatePct = envNum('MIRA_SHADOW_COST_GATE_PCT', 20)
    const successGatePp = envNum('MIRA_SHADOW_SUCCESS_GATE_PP', 0.005)
    const regressionGatePp = envNum('MIRA_SHADOW_REGRESSION_GATE_PP', 0.005)

    const latencyDeltaPct = pctDelta(candidate.latencyMs, production.latencyMs)
    const costDeltaPct = pctDelta(candidate.costPerTask, production.costPerTask)
    const successDelta = candidate.successRate - production.successRate
    const regressionDelta = candidate.regressionRate - production.regressionRate

    const latencyPass = latencyDeltaPct <= latencyGatePct
    const costPass = costDeltaPct <= costGatePct
    const successPass = candidate.successRate + successGatePp >= production.successRate
    const regressionPass = candidate.regressionRate <= production.regressionRate + regressionGatePp
    const securityPass =
      candidate.securityViolations <= production.securityViolations &&
      (candidate.securityPassed ?? true) &&
      (production.securityPassed ?? true ? true : candidate.securityViolations <= production.securityViolations)

    // Strict security gate: any candidate securityPassed === false → fail
    const securityGate = candidate.securityPassed !== false && securityPass

    const scores: ShadowScores = {
      success: { baseline: production.successRate, candidate: candidate.successRate, delta: successDelta, pass: successPass },
      latency: { baseline: production.latencyMs, candidate: candidate.latencyMs, deltaPct: latencyDeltaPct, pass: latencyPass },
      cost: { baseline: production.costPerTask, candidate: candidate.costPerTask, deltaPct: costDeltaPct, pass: costPass },
      regression: { baseline: production.regressionRate, candidate: candidate.regressionRate, delta: regressionDelta, pass: regressionPass },
      security: { baseline: production.securityViolations, candidate: candidate.securityViolations, pass: securityGate },
    }

    const gates = {
      success: successPass,
      latency: latencyPass,
      cost: costPass,
      regression: regressionPass,
      security: securityGate,
    }
    const allPass = successPass && latencyPass && costPass && regressionPass && securityGate

    // Determine improved vs regressed dimensions (beyond just gating)
    const improved: string[] = []
    const regressed: string[] = []
    if (candidate.successRate > production.successRate + 0.005) improved.push('success')
    else if (!successPass) regressed.push('success')
    if (candidate.latencyMs < production.latencyMs * 0.95) improved.push('latency')
    else if (!latencyPass) regressed.push('latency')
    if (candidate.costPerTask < production.costPerTask * 0.95) improved.push('cost')
    else if (!costPass) regressed.push('cost')
    if (candidate.regressionRate < production.regressionRate) improved.push('regression')
    else if (!regressionPass) regressed.push('regression')
    if (candidate.securityViolations < production.securityViolations) improved.push('security')
    else if (!securityGate) regressed.push('security')

    let verdict: ShadowVerdict
    let reasoning: string

    if (!allPass) {
      verdict = 'worse'
      const failed = Object.entries(gates)
        .filter(([, v]) => !v)
        .map(([k]) => k)
        .join(', ')
      if (!securityGate) {
        reasoning = `worse: security gate failed (candidate ${candidate.securityViolations} vs baseline ${production.securityViolations}, passed=${candidate.securityPassed}) — fail-closed per §8`
      } else if (!successPass) {
        reasoning = `worse: success ${candidate.successRate.toFixed(3)} < baseline ${production.successRate.toFixed(3)} (-${successGatePp * 100}pp gate, delta ${(successDelta * 100).toFixed(2)}pp) — gates failed: ${failed}`
      } else if (!regressionPass) {
        reasoning = `worse: regression ${candidate.regressionRate.toFixed(3)} > baseline ${production.regressionRate.toFixed(3)} (+${regressionGatePp} gate) — ${failed}`
      } else if (!latencyPass) {
        reasoning = `worse: latency +${latencyDeltaPct.toFixed(1)}% > +${latencyGatePct}% — ${failed}`
      } else if (!costPass) {
        reasoning = `worse: cost +${costDeltaPct.toFixed(1)}% > +${costGatePct}% — ${failed}`
      } else {
        reasoning = `worse: gates failed: ${failed}`
      }
    } else if (improved.length > 0) {
      verdict = 'better'
      reasoning = `better: all gates pass (+${latencyGatePct}%/-${successGatePp * 100}pp) and improved: ${improved.join(', ')} (success ${production.successRate.toFixed(2)}→${candidate.successRate.toFixed(2)} latency ${production.latencyMs}→${candidate.latencyMs}ms cost $${production.costPerTask.toFixed(3)}→$${candidate.costPerTask.toFixed(3)} regression ${production.regressionRate.toFixed(2)}→${candidate.regressionRate.toFixed(2)} sec ${production.securityViolations}→${candidate.securityViolations})`
    } else {
      verdict = 'neutral'
      reasoning = `neutral: all gates pass but no significant improvement (improved: none; candidate within parity of production per §16 — success ${candidate.successRate.toFixed(3)} vs ${production.successRate.toFixed(3)}, latency +${latencyDeltaPct.toFixed(1)}%, cost +${costDeltaPct.toFixed(1)}%)`
    }

    return {
      verdict,
      reasoning,
      scores,
      gates,
      allPass,
      improved,
      regressed,
      timestamp: Date.now(),
      details: { production, candidate } as unknown as JsonValue,
    }
  }

  /** Convenience: compare from ShadowBenchmark delta shape */
  compareBenchmark(
    production: { successRate: number; latencyMs: number; costPerTask: number; regressionRate: number; securityViolations: number },
    candidate: { successRate: number; latencyMs: number; costPerTask: number; regressionRate: number; securityViolations: number },
  ): ShadowComparisonResult {
    return this.compare(production as ComparisonInput, candidate as ComparisonInput)
  }
}
