/**
 * Mira Patching — Detector
 *
 * Detects 9 pain points from usage metrics, eval results, and user feedback.
 * Each pain point has a threshold; exceeded thresholds → candidate for patching.
 *
 * Sources:
 *  - UsageAnalysis (UsageLearner) — tool error rates, token/latency, success patterns
 *  - EvalReport (EvalRunner) — tier pass/fail, drift, judge scores
 *  - User feedback (thumbs up/down, session traces)
 *  - LatencyStats (LatencyTracker)
 *  - SecurityScanResult (SecurityScanner)
 */

import type { UsageAnalysis } from "../learning/usage.js"
import type { EvalReport } from "../eval/index.js"
import type { LatencyStats } from "./latency.js"
import type { SecurityScanResult } from "./security.js"

// ── Pain point taxonomy ────────────────────────────────────────────

export type PainPointId =
  | "over-eager"
  | "token-cost"
  | "unpredictable"
  | "context-overload"
  | "false-positives"
  | "debugging-harder"
  | "eval-risk"
  | "latency"
  | "security"

export type PainPointSeverity = "low" | "medium" | "high" | "critical"

export interface PainPoint {
  id: PainPointId
  label: string
  severity: PainPointSeverity
  score: number          // 0..1 — how strongly detected
  threshold: number      // threshold that was exceeded
  evidence: string[]     // human-readable evidence snippets
  source: "usage" | "eval" | "feedback" | "latency" | "security" | "hybrid"
  autoPatch: boolean     // whether this instance qualifies for auto-patch
  detectedAt: number
}

export interface DetectorConfig {
  thresholds: Record<PainPointId, number>
  autoPatchMinSeverity: PainPointSeverity
}

export const DEFAULT_THRESHOLDS: Record<PainPointId, number> = {
  "over-eager": 0.5,
  "token-cost": 0.5,
  "unpredictable": 0.5,
  "context-overload": 0.5,
  "false-positives": 0.5,
  "debugging-harder": 0.5,
  "eval-risk": 0.4,
  "latency": 0.5,
  "security": 0.3,
}

const SEVERITY_ORDER: Record<PainPointSeverity, number> = {
  low: 0, medium: 1, high: 2, critical: 3,
}

function severityFor(score: number): PainPointSeverity {
  if (score >= 0.85) return "critical"
  if (score >= 0.65) return "high"
  if (score >= 0.4) return "medium"
  return "low"
}

// ── Input types ────────────────────────────────────────────────────

export interface FeedbackEntry {
  sessionID: string
  feedback: "up" | "down"
  reason?: string
  createdAt: number
}

export interface DetectorInput {
  analysis: UsageAnalysis | null
  evalReport: EvalReport | null
  feedback: FeedbackEntry[]
  latency: LatencyStats | null
  security: SecurityScanResult | null
}

// ── Detector ───────────────────────────────────────────────────────

export class Detector {
  private config: DetectorConfig

  constructor(config: Partial<DetectorConfig> = {}) {
    this.config = {
      thresholds: { ...DEFAULT_THRESHOLDS, ...(config.thresholds ?? {}) },
      autoPatchMinSeverity: config.autoPatchMinSeverity ?? "high",
    }
  }

  detectAll(input: DetectorInput): PainPoint[] {
    const points: (PainPoint | null)[] = [
      this.detectOverEager(input),
      this.detectTokenCost(input),
      this.detectUnpredictable(input),
      this.detectContextOverload(input),
      this.detectFalsePositives(input),
      this.detectDebuggingHarder(input),
      this.detectEvalRisk(input),
      this.detectLatency(input),
      this.detectSecurity(input),
    ]
    return points.filter((p): p is PainPoint => p !== null)
  }

  /** Filter to those exceeding threshold */
  active(points: PainPoint[]): PainPoint[] {
    return points.filter(p => p.score >= p.threshold)
  }

  /** Those that should auto-patch now */
  autoPatchable(points: PainPoint[]): PainPoint[] {
    const min = SEVERITY_ORDER[this.config.autoPatchMinSeverity]
    return points.filter(p => p.autoPatch && SEVERITY_ORDER[p.severity] >= min && p.score >= p.threshold)
  }

  // ── Individual detectors ─────────────────────────────────────────

  private mk(
    id: PainPointId, label: string, score: number,
    evidence: string[], source: PainPoint["source"],
  ): PainPoint | null {
    if (score <= 0.05) return null
    const threshold = this.config.thresholds[id]
    const severity = severityFor(score)
    return {
      id, label, severity, score: round(score, 2), threshold,
      evidence: evidence.slice(0, 4),
      source,
      autoPatch: score >= threshold && SEVERITY_ORDER[severity] >= SEVERITY_ORDER.medium,
      detectedAt: Date.now(),
    }
  }

  /** 1. Over-eager — too many tool calls / steps per session, doom loops */
  detectOverEager(input: DetectorInput): PainPoint | null {
    const a = input.analysis
    let score = 0
    const ev: string[] = []
    if (a) {
      const avgCalls = a.window.sessions ? avg(Object.values(a.toolStats).map(s => s.count)) / Math.max(1, a.window.sessions) : 0
      if (avgCalls > 12) { score = Math.min(1, 0.4 + (avgCalls - 12) * 0.05); ev.push(`avg ${avgCalls.toFixed(1)} tool calls/session (budget 8)`) }
      const doom = a.failurePatterns.find(f => f.key.includes("doom-loop"))
      if (doom) { score = Math.max(score, 0.7); ev.push(`doom-loop ${doom.count} sessions (${Math.round(doom.errorRate * 100)}%)`) }
      const highSteps = a.failurePatterns.filter(f => f.key.includes("workflow")).length
      if (highSteps) { score = Math.max(score, 0.5); ev.push(`workflow failures: ${highSteps} patterns`) }
    }
    // feedback hint: "did too much" in reason
    const eagerFeedback = input.feedback.filter(f => f.feedback === "down" && /too much|over.?eager|too many/i.test(f.reason ?? "")).length
    if (eagerFeedback >= 2) { score = Math.max(score, 0.65); ev.push(`${eagerFeedback} users flagged over-eager`) }
    if (!ev.length) return null
    return this.mk("over-eager", "Over-eager (does too much)", score, ev, "usage")
  }

  /** 2. Token cost — high avg tokens per session, wasteful success patterns */
  detectTokenCost(input: DetectorInput): PainPoint | null {
    const a = input.analysis
    let score = 0
    const ev: string[] = []
    if (a) {
      for (const [model, stat] of Object.entries(a.modelStats)) {
        if (stat.avgTokens > 25_000) { score = Math.max(score, Math.min(1, 0.5 + (stat.avgTokens - 25_000) / 30_000)); ev.push(`${model} avg ${stat.avgTokens} tokens (budget 20k)`) }
      }
      // compaction pressure also signals cost
      const avgTokensAll = avg(Object.values(a.modelStats).map(s => s.avgTokens))
      if (avgTokensAll > 15_000) { score = Math.max(score, 0.4); ev.push(`overall avg ${Math.round(avgTokensAll)} tokens/session`) }
    }
    if (!ev.length) return null
    return this.mk("token-cost", "Token cost (too many API calls)", score, ev, "usage")
  }

  /** 3. Unpredictable — low success pattern stability, eval flakiness */
  detectUnpredictable(input: DetectorInput): PainPoint | null {
    let score = 0
    const ev: string[] = []
    const a = input.analysis
    if (a) {
      const successRate = avgSuccess(a)
      if (successRate < 0.7) { score = Math.max(score, 0.6 + (0.7 - successRate)); ev.push(`success rate ${(successRate * 100).toFixed(0)}% < 70%`) }
      if (a.successPatterns.length === 0 && a.window.sessions >= 5) { score = Math.max(score, 0.55); ev.push("no stable success patterns") }
    }
    if (input.evalReport && !input.evalReport.passed) {
      const flaky = input.evalReport.tiers.filter(t => !t.passed).length
      if (flaky) { score = Math.max(score, 0.6); ev.push(`eval failed ${flaky} tier(s)`) }
    }
    if (!ev.length) return null
    return this.mk("unpredictable", "Unpredictable (hard to know what it will do)", score, ev, a ? "hybrid" : "eval")
  }

  /** 4. Context overload — reading all context every time, large prompts */
  detectContextOverload(input: DetectorInput): PainPoint | null {
    const a = input.analysis
    let score = 0
    const ev: string[] = []
    if (a) {
      // heuristic: high avg tokens + low success suggests context dilution
      const avgT = avg(Object.values(a.modelStats).map(s => s.avgTokens))
      if (avgT > 20_000) { score = Math.max(score, 0.5); ev.push(`avg context ~${Math.round(avgT)} tokens`) }
      // toolStats: many read calls per session
      const readStats = a.toolStats["read"]
      if (readStats && readStats.count / Math.max(1, a.window.sessions) > 6) {
        score = Math.max(score, 0.6); ev.push(`read called ${readStats.count}x across ${a.window.sessions} sessions`)
      }
    }
    if (!ev.length) return null
    return this.mk("context-overload", "Context overload (reading all context)", score, ev, "usage")
  }

  /** 5. False positives — gap detection precision low */
  detectFalsePositives(input: DetectorInput): PainPoint | null {
    let score = 0
    const ev: string[] = []
    // False positives often show as high errorRate but low user feedback correlation
    // or as "improvement rejected" churning — we approximate via negative feedback rate
    const downs = input.feedback.filter(f => f.feedback === "down").length
    const totalF = input.feedback.length
    if (totalF >= 4 && downs / totalF > 0.4) {
      // check if failurePatterns are numerous but not confirmed by eval
      const fpCount = input.analysis?.failurePatterns.length ?? 0
      if (fpCount >= 4) { score = 0.6; ev.push(`${fpCount} failure patterns but ${Math.round(downs / totalF * 100)}% negative feedback`) }
    }
    const fpFeedback = input.feedback.filter(f => /false positive|false alarm|not.*real/i.test(f.reason ?? "")).length
    if (fpFeedback >= 1) { score = Math.max(score, 0.7); ev.push(`${fpFeedback} users flagged false positives`) }
    if (!ev.length) return null
    return this.mk("false-positives", "False positives (detects gaps that aren't real)", score, ev, "feedback")
  }

  /** 6. Debugging harder — hard to trace why it did something */
  detectDebuggingHarder(input: DetectorInput): PainPoint | null {
    let score = 0
    const ev: string[] = []
    const a = input.analysis
    if (a) {
      // Many tool types with errors but no clear attribution
      const errorKinds = new Set(a.failurePatterns.map(f => f.key))
      if (errorKinds.size >= 5) { score = 0.55; ev.push(`${errorKinds.size} distinct error kinds — tracing is noisy`) }
      const unknownKind = a.failurePatterns.filter(f => !f.suggestion || f.suggestion.length < 20).length
      if (unknownKind >= 2) { score = Math.max(score, 0.5); ev.push(`${unknownKind} patterns have no actionable suggestion`) }
    }
    const traceComplaints = input.feedback.filter(f => /trace|debug|why did|explain/i.test(f.reason ?? "")).length
    if (traceComplaints >= 1) { score = Math.max(score, 0.6); ev.push(`${traceComplaints} feedback flagged traceability`) }
    if (!ev.length) return null
    return this.mk("debugging-harder", "Debugging harder (hard to trace)", score, ev, "hybrid")
  }

  /** 7. Eval risk — autonomous actions may not match tests */
  detectEvalRisk(input: DetectorInput): PainPoint | null {
    let score = 0
    const ev: string[] = []
    const r = input.evalReport
    if (r) {
      if (!r.passed) { score = 0.75; ev.push(`eval ${r.requested} FAILED (${r.tiers.filter(t => !t.passed).map(t => t.tier).join(", ")})`) }
      // drift checks failing also signal eval risk
      const driftFail = r.tiers.flatMap(t => t.checks).filter(c => c.checkId.includes("drift") && !c.passed)
      if (driftFail.length) { score = Math.max(score, 0.65); ev.push(`${driftFail.length} drift checks failing`) }
    } else {
      // no recent eval is itself a risk if we have usage
      if (input.analysis && input.analysis.window.sessions >= 5) {
        score = 0.45; ev.push("no recent eval report — cannot verify autonomous patches")
      }
    }
    if (!ev.length) return null
    return this.mk("eval-risk", "Eval risk (autonomous actions may not match tests)", score, ev, "eval")
  }

  /** 8. Latency — p50/p95 exceeds SLO */
  detectLatency(input: DetectorInput): PainPoint | null {
    const s = input.latency
    if (!s) return null
    let score = 0
    const ev: string[] = []
    // Budgets: p50 < 2000ms, p95 < 8000ms (PR tier), tune via thresholds
    if (s.p50 > 2000) { score = Math.max(score, Math.min(1, 0.5 + (s.p50 - 2000) / 4000)); ev.push(`p50 ${s.p50}ms > 2000ms SLO`) }
    if (s.p95 > 8000) { score = Math.max(score, Math.min(1, 0.5 + (s.p95 - 8000) / 8000)); ev.push(`p95 ${s.p95}ms > 8000ms SLO`) }
    if (s.p95 > s.p50 * 4 && s.count >= 10) { score = Math.max(score, 0.55); ev.push(`tail heavy: p95/p50 = ${(s.p95 / Math.max(1, s.p50)).toFixed(1)}x`) }
    if (!ev.length) return null
    return this.mk("latency", "Latency (slow responses)", score, ev, "latency")
  }

  /** 9. Security — vulnerabilities, prompt injection, etc. */
  detectSecurity(input: DetectorInput): PainPoint | null {
    const res = input.security
    if (!res) return null
    if (res.issues.length === 0) return null
    const critical = res.issues.filter(i => i.severity === "critical").length
    const high = res.issues.filter(i => i.severity === "high").length
    let score = 0
    const ev: string[] = []
    if (critical) { score = 0.9; ev.push(`${critical} critical security issues`) }
    else if (high) { score = 0.75; ev.push(`${high} high security issues`) }
    else { score = Math.min(1, 0.4 + res.issues.length * 0.15); ev.push(`${res.issues.length} security issues`) }
    for (const iss of res.issues.slice(0, 2)) ev.push(`${iss.kind}: ${iss.detail.slice(0, 80)}`)
    return this.mk("security", "Security (vulnerabilities, prompt injection)", score, ev, "security")
  }
}

// ── helpers ─────────────────────────────────────────────────────────

function avg(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0
}
function avgSuccess(a: UsageAnalysis): number {
  const vals = Object.values(a.modelStats).map(s => s.successRate)
  return vals.length ? avg(vals) : 1
}
function round(n: number, d: number): number {
  return Math.round(n * Math.pow(10, d)) / Math.pow(10, d)
}
