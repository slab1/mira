/**
 * Mira Self-Patching System — Main Engine
 *
 * Mira patches its own pain points automatically: latency, security,
 * over-eager, token cost, unpredictability, context overload, false
 * positives, debuggability, and eval risk.
 *
 * Extends the ImprovementEngine (learning/improvement.ts) — more comprehensive
 * for all 9 pain points, with dedicated latency + security pillars.
 *
 * Flow (RCSI-style, never unconditional):
 *   detect → patch → shadow-verify → apply
 *
 * Auto-patch:
 *  When thresholds exceeded, patch → verify → apply runs automatically.
 *  Latency and security are monitored continuously; blocking eval failures
 *  gate the apply step when evalReport is available.
 *
 * Usage:
 *   import { PatchingEngine, createPatchingSystem } from "./patching/index.js"
 *
 *   const patching = createPatchingSystem({ db, bus, knowledge, rootDir: process.cwd() })
 *   const report = await patching.runCycle({ feedback, evalReport })
 *
 *   // Manual: track latency + security outside the cycle
 *   patching.latency.record(1234)
 *   patching.security.scan({ text: userInput })
 *
 *   // Auto-patch on a timer:
 *   setInterval(() => patching.runCycle({}), 60*60*1000)
 */

import { Bus } from "../bus/index.js"
import type { UsageAnalysis } from "../learning/usage.js"
import type { KnowledgeBase } from "../learning/knowledge.js"
import type { EvalReport } from "../eval/index.js"
import { Detector, type PainPoint, type DetectorConfig, type FeedbackEntry, type DetectorInput } from "./detector.js"
import { Patcher, type Patch, type PatcherConfig } from "./patcher.js"
import { Verifier, type VerifyResult, type VerifierConfig } from "./verifier.js"
import { Applier, type ApplyResult, type ApplierConfig, type ApplierDeps } from "./applier.js"
import { LatencyTracker, type LatencyStats, type LatencyBudget } from "./latency.js"
import { SecurityScanner, type SecurityScanResult, type SecurityScannerConfig } from "./security.js"
import type { MiraDB } from "../storage/db.js"
import type { Gateway } from "../gateway/index.js"

// Re-exports for ergonomic imports
export * from "./detector.js"
export * from "./patcher.js"
export * from "./verifier.js"
export * from "./applier.js"
export * from "./latency.js"
export * from "./security.js"

// ── Types ──────────────────────────────────────────────────────────

export interface PatchingEngineConfig {
  rootDir?: string
  dryRun?: boolean
  autoPatch?: boolean
  minSeverity?: DetectorConfig["autoPatchMinSeverity"]
  detector?: Partial<DetectorConfig>
  patcher?: PatcherConfig
  verifier?: VerifierConfig
  applier?: ApplierConfig
  latencyBudget?: Partial<LatencyBudget>
  security?: SecurityScannerConfig
}

export interface PatchingEngineDeps {
  bus?: Bus
  db?: MiraDB
  knowledge?: KnowledgeBase
  gateway?: Gateway
}

export interface CycleInput {
  analysis?: UsageAnalysis | null
  evalReport?: EvalReport | null
  feedback?: FeedbackEntry[]
  latencySamples?: Array<{ durationMs: number; route?: string }>
  securityText?: string
}

export interface CycleResult {
  status: "stable" | "cycle_complete"
  detected: number
  active: number
  patches: number
  verified: number
  applied: number
  rejected: number
  painPoints: Array<{ id: string; severity: string; score: number }>
  patchesDetail: Array<{ id: string; targetFile: string | null; verified: boolean; applied: boolean }>
  latency: LatencyStats | null
  security: SecurityScanResult | null
}

// ── PatchingEngine ─────────────────────────────────────────────────

export class PatchingEngine {
  public readonly detector: Detector
  public readonly patcher: Patcher
  public readonly verifier: Verifier
  public readonly applier: Applier
  public readonly latency: LatencyTracker
  public readonly security: SecurityScanner

  private config: Required<Omit<PatchingEngineConfig, "detector" | "patcher" | "verifier" | "applier" | "latencyBudget" | "security">>

  constructor(
    private deps: PatchingEngineDeps = {},
    config: PatchingEngineConfig = {},
  ) {
    const rootDir = config.rootDir ?? process.cwd()
    this.config = {
      rootDir,
      dryRun: config.dryRun ?? false,
      autoPatch: config.autoPatch ?? true,
      minSeverity: config.minSeverity ?? "high",
    }

    this.detector = new Detector({
      ...(config.detector ?? {}),
      autoPatchMinSeverity: config.minSeverity ?? "high",
    })
    this.patcher = new Patcher({ rootDir, ...(config.patcher ?? {}) })
    this.verifier = new Verifier({ rootDir, ...(config.verifier ?? {}) })
    this.applier = new Applier(
      { bus: deps.bus, knowledge: deps.knowledge, db: deps.db },
      { rootDir, dryRun: config.dryRun ?? false, ...(config.applier ?? {}) },
    )
    this.latency = new LatencyTracker(config.latencyBudget)
    this.security = new SecurityScanner(config.security)
  }

  // ── Detect ───────────────────────────────────────────────────────

  /**
   * Detect pain points from current signals.
   * Latency + security are auto-collected from trackers if not supplied.
   */
  detect(input: CycleInput = {}): { painPoints: PainPoint[]; latency: LatencyStats | null; securityResult: SecurityScanResult | null } {
    // Ingest ad-hoc latency samples
    if (input.latencySamples) {
      for (const s of input.latencySamples) this.latency.record(s.durationMs, s.route)
    }

    const latencyStats = this.latency.size() > 0 ? this.latency.stats() : null

    let securityResult: SecurityScanResult | null = null
    if (input.securityText) {
      securityResult = this.security.scan({ text: input.securityText })
    }

    const detectorInput: DetectorInput = {
      analysis: input.analysis ?? null,
      evalReport: input.evalReport ?? null,
      feedback: input.feedback ?? [],
      latency: latencyStats,
      security: securityResult,
    }

    const painPoints = this.detector.detectAll(detectorInput)
    return { painPoints, latency: latencyStats, securityResult }
  }

  // ── Full cycle (RCSI loop for all 9 pain points) ─────────────────

  async runCycle(input: CycleInput = {}): Promise<CycleResult> {
    console.log(`[patching] cycle start — root ${this.config.rootDir}`)

    const { painPoints, latency, securityResult } = this.detect(input)
    const active = this.detector.active(painPoints)

    console.log(`[patching] detected ${painPoints.length} pain points, ${active.length} active (≥ threshold)`)
    for (const p of painPoints) {
      console.log(`  ${active.includes(p) ? "●" : "○"} ${p.id} [${p.severity} ${p.score}] — ${p.evidence[0] ?? ""}`)
    }

    if (active.length === 0) {
      return {
        status: "stable",
        detected: painPoints.length,
        active: 0,
        patches: 0, verified: 0, applied: 0, rejected: 0,
        painPoints: painPoints.map(p => ({ id: p.id, severity: p.severity, score: p.score })),
        patchesDetail: [],
        latency, security: securityResult,
      }
    }

    // Gate: if eval risk is critical and eval failed, don't auto-apply — report only
    const evalRisk = painPoints.find(p => p.id === "eval-risk" && p.severity === "critical" && p.score >= 0.7)
    if (evalRisk && input.evalReport && !input.evalReport.passed && this.config.autoPatch) {
      console.log(`[patching] eval-risk critical + eval FAILED — patches will be verified but NOT applied (gate)`)
    }

    // Generate patches
    const patches = this.patcher.generate(active)
    console.log(`[patching] generated ${patches.length} patches`)
    if (patches.length === 0) {
      return {
        status: "stable",
        detected: painPoints.length, active: active.length,
        patches: 0, verified: 0, applied: 0, rejected: 0,
        painPoints: painPoints.map(p => ({ id: p.id, severity: p.severity, score: p.score })),
        patchesDetail: [],
        latency, security: securityResult,
      }
    }

    // Shadow verify each
    let verified = 0, rejected = 0, applied = 0
    const details: CycleResult["patchesDetail"] = []

    for (const patch of patches) {
      console.log(`  → verifying ${patch.id} (${patch.kind} → ${patch.targetFile})`)
      const vr = await this.verifier.verify(patch)
      console.log(`    ${vr.verified ? "VERIFIED" : "REJECTED"}: ${vr.reason}`)

      if (!vr.verified) {
        rejected++
        details.push({ id: patch.id, targetFile: patch.targetFile, verified: false, applied: false })
        continue
      }
      verified++

      // Eval gate: block apply if eval-risk critical and eval failed
      if (evalRisk && input.evalReport && !input.evalReport.passed) {
        console.log(`    GATED: not applying due to eval-risk`)
        details.push({ id: patch.id, targetFile: patch.targetFile, verified: true, applied: false })
        continue
      }

      // Auto-patch decision: only apply if severity qualifies
      const pp = painPoints.find(p => p.id === patch.painPointId)
      const shouldApply = this.config.autoPatch && pp ? pp.autoPatch : false
      if (!shouldApply) {
        console.log(`    verified but below auto-patch severity — not applying`)
        details.push({ id: patch.id, targetFile: patch.targetFile, verified: true, applied: false })
        continue
      }

      const ar = await this.applier.apply(patch, vr)
      if (ar.applied) applied++
      details.push({ id: patch.id, targetFile: patch.targetFile, verified: true, applied: ar.applied })
    }

    const result: CycleResult = {
      status: "cycle_complete",
      detected: painPoints.length,
      active: active.length,
      patches: patches.length,
      verified, applied, rejected,
      painPoints: painPoints.map(p => ({ id: p.id, severity: p.severity, score: p.score })),
      patchesDetail: details,
      latency, security: securityResult,
    }

    this.deps.bus?.publish({
      type: "learning.updated",
      payload: { kind: "patching.cycle", result },
      timestamp: Date.now(),
      })

    console.log(`[patching] cycle complete — ${applied} applied, ${rejected} rejected, ${verified - applied} gated`)
    return result
  }

  /** Convenience: run with analysis loaded from UsageLearner */
  async runWithLearners(opts: {
    analysis?: UsageAnalysis | null
    evalReport?: EvalReport | null
    feedback?: FeedbackEntry[]
  } = {}): Promise<CycleResult> {
    return this.runCycle({
      analysis: opts.analysis ?? null,
      evalReport: opts.evalReport ?? null,
      feedback: opts.feedback ?? [],
    })
  }

  /** Direct latency tracking passthrough */
  recordLatency(ms: number, route?: string): void { this.latency.record(ms, route) }
  getLatencyStats(windowMs?: number): LatencyStats { return this.latency.stats(windowMs) }

  /** Direct security scan passthrough */
  scanSecurity(input: Parameters<SecurityScanner["scan"]>[0]): SecurityScanResult {
    return this.security.scan(input)
  }

  /** Quick health snapshot */
  status(): Record<string, unknown> {
    return {
      rootDir: this.config.rootDir,
      dryRun: this.config.dryRun,
      autoPatch: this.config.autoPatch,
      latency: this.latency.size() ? this.latency.stats() : null,
      budget: this.latency.getBudget(),
    }
  }
}

// ── Factory ────────────────────────────────────────────────────────

export function createPatchingSystem(
  deps: PatchingEngineDeps = {},
  config: PatchingEngineConfig = {},
): PatchingEngine {
  return new PatchingEngine(deps, config)
}

// Default singleton (lazy) — for server startup wiring
let _default: PatchingEngine | null = null
export function getPatchingEngine(
  deps: PatchingEngineDeps = {},
  config: PatchingEngineConfig = {},
): PatchingEngine {
  if (!_default) _default = new PatchingEngine(deps, config)
  return _default
}
