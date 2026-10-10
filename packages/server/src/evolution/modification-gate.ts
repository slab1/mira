/**
 * Unified Self-Modification Gate — fail-closed policy for autonomous changes.
 *
 * Per MIRA_EVOLUTION_SPEC + master findings P1.1: never self-modify unless
 *   1. confidence ≥ threshold   (diagnosis/proposal is trustworthy)
 *   2. validation all-passed    (tests/security/performance verified)
 *   3. rollback point available (we can revert if wrong)
 *
 * These three checks previously lived as separate, inconsistently-keyed
 * mechanisms (confidence typed proposals but did not hard-block; autonomy
 * gated on risk not confidence; rollback was created but never required).
 * This module is the single policy they collapse into.
 *
 * Fail-closed: any missing or failed check denies the modification.
 */

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7

export interface ModificationGateInput {
  /** Diagnosis/proposal confidence, 0..1 */
  confidence: number
  /** Validation loop result — true only when tests + security + performance all pass */
  validationPassed: boolean
  /** A rollback point exists and is recoverable */
  rollbackAvailable: boolean
  /** Optional risk level for audit context (does not relax the gate) */
  riskLevel?: string
}

export interface ModificationGateResult {
  allowed: boolean
  reasons: string[]
  checks: {
    confidence: boolean
    validation: boolean
    rollback: boolean
  }
  confidence: number
  threshold: number
}

/**
 * Evaluate the unified gate. All three checks must pass.
 * Confidence below threshold, failed validation, or missing rollback → deny.
 */
export function checkSelfModificationGate(
  input: ModificationGateInput,
  threshold: number = DEFAULT_CONFIDENCE_THRESHOLD,
): ModificationGateResult {
  const reasons: string[] = []

  const confidenceOk =
    typeof input.confidence === 'number' &&
    Number.isFinite(input.confidence) &&
    input.confidence >= threshold
  if (!confidenceOk) {
    reasons.push(
      `confidence ${Number.isFinite(input.confidence) ? input.confidence.toFixed(2) : 'invalid'} < threshold ${threshold.toFixed(2)}`,
    )
  }

  const validationOk = input.validationPassed === true
  if (!validationOk) {
    reasons.push('validation did not pass (tests/security/performance not all green)')
  }

  const rollbackOk = input.rollbackAvailable === true
  if (!rollbackOk) {
    reasons.push('no rollback point available — cannot safely revert')
  }

  return {
    allowed: confidenceOk && validationOk && rollbackOk,
    reasons,
    checks: { confidence: confidenceOk, validation: validationOk, rollback: rollbackOk },
    confidence: input.confidence,
    threshold,
  }
}

/**
 * Early confidence-only gate — run before expensive verification to avoid
 * burning compute on low-confidence diagnoses. Part of the same policy:
 * if confidence alone fails, the full gate would fail anyway.
 */
export function gateByConfidence(
  confidence: number,
  threshold: number = DEFAULT_CONFIDENCE_THRESHOLD,
): { passed: boolean; reason?: string } {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < threshold) {
    return {
      passed: false,
      reason: `confidence ${Number.isFinite(confidence) ? confidence.toFixed(2) : 'invalid'} < threshold ${threshold.toFixed(2)}`,
    }
  }
  return { passed: true }
}
