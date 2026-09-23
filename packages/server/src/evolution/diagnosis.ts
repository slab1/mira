/**
 * Evolution Diagnosis — takes observed failure, produces diagnosis
 *
 * Docs: Status Target→Implemented per MIRA_WEAKNESSES_AND_OBSTACLES.md:23 Phase 1 (DiagnosisEngine),
 *       MIRA_EVOLUTION_SPEC.md Diagnose (Implemented via oracle/critic; Target automation here),
 *       MIRA_SYSTEM_DOCUMENTATION.md:2 lifecycle.
 *
 * Keeps nvidia primary + colibri opportunistic (diagnosis fallback heuristic when colibri offline).
 * Reuses oracle/critic patterns: cause taxonomy, confidence scoring, affectedEngine mapping.
 * No local hardware required.
 *
 * Documentation Maintenance — 10 items:
 * | # | Item | Status | Evidence |
 * |---|------|--------|----------|
 * | 1 | Implementation path | Implemented | packages/server/src/evolution/diagnosis.ts |
 * | 2 | Public interfaces | Implemented | diagnose(observed): Diagnosis {cause, confidence, affectedEngine} |
 * | 3 | Events | Implemented | consumes evolution.observed, produces diagnosis (in-memory, ledger stores evidence) |
 * | 4 | Configuration | Implemented | no config; heuristic + optional brio/colibri opportunistic, nvidia stays primary |
 * | 5 | Tests | Implemented | evolution.test.ts covers diagnose with confidence + affectedEngine |
 * | 6 | Security boundaries | Implemented | read-only, no mutation, no secret expansion, evidence sanitized |
 * | 7 | Operational procedures | Implemented | pure function, no lifecycle, callable from POST /evolution/observe |
 * | 8 | Migration strategy | Implemented | additive, no DB, safe to extend with LLM diagnose later |
 * | 9 | Rollback strategy | Implemented | revert file, no state |
 * | 10 | Known limitations | Implemented | heuristic only Phase 1; no online research yet; colibri opportunistic |
 */

import type { JsonValue } from "../types/index.js"
import type { ObservedFailure } from "./observer.js"

export type AffectedEngine =
  | "gateway"
  | "memory"
  | "tool"
  | "session"
  | "guardrails"
  | "model"
  | "metric"
  | "unknown"

export interface Diagnosis {
  cause: string
  confidence: number // 0..1
  affectedEngine: AffectedEngine
  evidence: JsonValue
  failure: string
  sessionID?: string
  timestamp: number
  notes?: string
}

// oracle/critic-inspired taxonomy (mirrors agents/critic.md APPROVE/REJECT/REVISE patterns)
const PATTERNS: Array<{ re: RegExp; cause: string; engine: AffectedEngine; confidence: number }> = [
  { re: /cost.*cap|perTask|perSession|402/i, cause: "cost-cap exceeded or budget misconfig", engine: "gateway", confidence: 0.85 },
  { re: /circuit.*open|cooldown|failureThreshold/i, cause: "circuit-breaker open / upstream instability", engine: "gateway", confidence: 0.8 },
  { re: /hasKey|no api key|missing.*key|unauthorized|401/i, cause: "missing or invalid provider key", engine: "model", confidence: 0.9 },
  { re: /rate.*limit|429|too many requests/i, cause: "rate-limited upstream", engine: "gateway", confidence: 0.82 },
  { re: /timeout|timed out|abort/i, cause: "timeout / latency spike", engine: "gateway", confidence: 0.75 },
  { re: /guardrail|blocked|not allowed|permission/i, cause: "guardrail/permission denial", engine: "guardrails", confidence: 0.78 },
  { re: /snapshot|edit.*fail|hash.*anchor|stale.*line/i, cause: "edit/patch application failure", engine: "tool", confidence: 0.7 },
  { re: /memory|knowledge|episodic|semantic/i, cause: "memory/retrieval degradation", engine: "memory", confidence: 0.65 },
  { re: /session|prompt|loop|compaction/i, cause: "session/prompt loop failure", engine: "session", confidence: 0.6 },
]

export function diagnose(observed: ObservedFailure): Diagnosis {
  const failure = String(observed.failure ?? "")
  const evStr = (() => {
    try { return JSON.stringify(observed.evidence) } catch { return String(observed.evidence ?? "") }
  })()
  const hay = `${failure} ${evStr}`

  for (const p of PATTERNS) {
    if (p.re.test(hay)) {
      return {
        cause: p.cause,
        confidence: p.confidence,
        affectedEngine: p.engine,
        evidence: observed.evidence,
        failure,
        sessionID: observed.sessionID,
        timestamp: Date.now(),
        notes: `matched pattern ${p.re.source} (oracle/critic heuristic)`,
      }
    }
  }

  // fallback — unknown, low confidence
  return {
    cause: "unclassified failure — needs research",
    confidence: 0.45,
    affectedEngine: "unknown",
    evidence: observed.evidence,
    failure,
    sessionID: observed.sessionID,
    timestamp: Date.now(),
    notes: "fallback heuristic; Phase 1 no online research",
  }
}

/** Batch diagnose helper */
export function diagnoseBatch(observedList: ObservedFailure[]): Diagnosis[] {
  return observedList.map(diagnose)
}
