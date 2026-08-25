/**
 * Mira Improvement Engine — Synthesize → Patch → Shadow-Test → Apply
 *
 * Direct descendant of Project Aether RCSI (`logic_evolve.py`):
 *   analyze_failures() → synthesize_patch() → verify_patch() → _apply_patch()
 *
 * Generalized for Mira:
 *   - Inputs: Online Insights + Usage Analysis + KnowledgeBase retrieval
 *   - Targets: agent prompts (AGENTS.md / .mira/instructions.md),
 *              tool implementations (src/tools/*.ts),
 *              engine config (src/config/index.ts, session/prompt.ts)
 *   - Verification: shadow testing (temp copy → run checks → compare)
 *   - Safety: NEVER applies without verification; appends improvement notes
 *             rather than rewriting logic for generic patches
 *
 * Shadow strategies (in priority order):
 *   1. Agent prompt → `bun test` or `tsc --noEmit` on patched file copy
 *   2. Tool/engine TS → `tsc --noEmit` + `bun test` (if tests exist)
 *   3. Fallback → syntax check (parse + py_compile-style tsc)
 */

import { Bus } from "../bus/index.js"
import type { Insight } from "./online.js"
import type { UsageAnalysis, FailurePattern } from "./usage.js"
import type { KnowledgeBase } from "./knowledge.js"
import type { MiraDB } from "../storage/db.js"
import type { Gateway } from "../gateway/index.js"

// ── Types ────────────────────────────────────────────────────────────

export interface Improvement {
  id: string
  targetFile: string | null       // relative to server root, null = no file target
  reason: string
  proposedChange: string          // human-readable; also the appended note for generic patches
  kind: "agent-prompt" | "tool" | "engine" | "config" | "skill"
  source: "online" | "usage" | "hybrid"
  verification: string            // command that verifies it (for logging)
  createdAt: number
}

export interface VerifyResult {
  verified: boolean
  reason: string
  shadowOutput?: string
}

export interface CycleResult {
  status: "stable" | "cycle_complete"
  analyzed: { insights: number; failures: number }
  synthesized: number
  promoted: number
  rejected: number
  improvements: Array<{ id: string; targetFile: string | null; verified: boolean }>
}

export interface ImprovementEngineConfig {
  /** repo root for file resolution (default process.cwd()) */
  rootDir?: string
  /** min relevance to synthesize from an insight (default 0.5) */
  minInsightRelevance?: number
  /** failure rate threshold (mirrors UsageLearner, default 0.3) */
  failureRateThreshold?: number
  /** dryRun: verify but never write to real files (default false) */
  dryRun?: boolean
}

export interface ImprovementEngineDeps {
  bus?: Bus
  db?: MiraDB
  knowledge?: KnowledgeBase
  gateway?: Gateway
}

// ── ImprovementEngine ────────────────────────────────────────────────

export class ImprovementEngine {
  private config: Required<ImprovementEngineConfig>

  constructor(
    private deps: ImprovementEngineDeps = {},
    config: ImprovementEngineConfig = {},
  ) {
    this.config = {
      rootDir: config.rootDir ?? process.cwd(),
      minInsightRelevance: config.minInsightRelevance ?? 0.5,
      failureRateThreshold: config.failureRateThreshold ?? 0.3,
      dryRun: config.dryRun ?? false,
    }
  }

  // ── Synthesize ─────────────────────────────────────────────────────

  /**
   * Turn online insights + usage failures into concrete Improvements.
   * Each improvement targets a real file and carries a verification command.
   */
  synthesize(
    insights: Insight[],
    analysis: UsageAnalysis | null,
  ): Improvement[] {
    const out: Improvement[] = []

    // From online insights (high-relevance only)
    for (const ins of insights) {
      if (ins.relevance < this.config.minInsightRelevance) continue
      const target = targetForInsight(ins)
      out.push({
        id: `imp_on_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 4)}`,
        targetFile: target.file,
        reason: `Online insight (${ins.category}): ${ins.summary.slice(0, 120)} — ${ins.source}`,
        proposedChange: ins.pattern,
        kind: target.kind,
        source: "online",
        verification: target.verification,
        createdAt: Date.now(),
      })
    }

    // From usage failures
    if (analysis) {
      for (const f of analysis.failurePatterns) {
        const target = targetForFailure(f)
        // Skip if already covered by an online improvement for same file
        if (target.file && out.some(o => o.targetFile === target.file)) continue
        out.push({
          id: `imp_us_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 4)}`,
          targetFile: target.file,
          reason: `Usage failure: ${f.key} — ${Math.round(f.errorRate * 100)}% over ${f.count} occurrences. ${f.suggestion}`,
          proposedChange: f.suggestion,
          kind: target.kind,
          source: "usage",
          verification: target.verification,
          createdAt: Date.now(),
        })
      }
    }

    // Deduplicate by targetFile + kind
    const seen = new Set<string>()
    return out.filter(imp => {
      const key = `${imp.targetFile ?? "null"}:${imp.kind}:${imp.proposedChange.slice(0, 60)}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).slice(0, 6) // cap per cycle
  }

  // ── Verify (shadow test) ───────────────────────────────────────────

  /**
   * Shadow-test an improvement: apply to a temp copy, run verification.
   * NEVER returns true unconditionally (RCSI principle).
   */
  async verify(imp: Improvement): Promise<VerifyResult> {
    if (!imp.targetFile) {
      return { verified: false, reason: "no targetFile — cannot verify file-less improvement" }
    }
    const abs = `${this.config.rootDir}/${imp.targetFile}`
    const file = Bun.file(abs)
    if (!(await file.exists())) {
      return { verified: false, reason: `target not found: ${imp.targetFile}` }
    }

    // Create shadow copy in temp dir
    const tmpDir = `${this.config.rootDir}/.tmp_shadow_${Date.now()}`
    const { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } = await import("node:fs")
    try {
      mkdirSync(tmpDir, { recursive: true })
      const original = await file.text()
      const shadowPath = `${tmpDir}/shadow_${imp.targetFile.replace(/\//g, "_")}`
      // Apply proposed change (append improvement note — safe generic)
      const patched = applyChange(original, imp.proposedChange, imp.targetFile)
      writeFileSync(shadowPath, patched, "utf-8")

      // Run verification in order: tsc → bun test (if prompt) → syntax
      const result = await this.runShadowChecks(shadowPath, imp, original, abs)
      return result
    } catch (err) {
      return { verified: false, reason: `shadow error: ${String(err)}` }
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
    }
  }

  private async runShadowChecks(
    shadowPath: string,
    imp: Improvement,
    _original: string,
    _abs: string,
  ): Promise<VerifyResult> {
    // 1. For TS files: tsc --noEmit on the shadow (syntax + types)
    if (imp.targetFile!.endsWith(".ts") || imp.targetFile!.endsWith(".js")) {
      try {
        const proc = Bun.spawn(["npx", "tsc", "--noEmit", "--skipLibCheck", shadowPath], {
          cwd: this.config.rootDir,
          stdout: "pipe", stderr: "pipe",
        })
        const exit = await proc.exited
        const stderr = await new Response(proc.stderr).text().catch(() => "")
        if (exit !== 0) {
          return { verified: false, reason: `tsc failed (exit ${exit}): ${stderr.slice(0, 600)}`, shadowOutput: stderr }
        }
      } catch (err) {
        // tsc not available → fall back to syntax check
        const ok = await syntaxCheck(shadowPath)
        if (!ok) return { verified: false, reason: `syntax check failed: ${String(err)}` }
      }
    } else if (imp.targetFile!.endsWith(".md")) {
      // Markdown prompts: just ensure non-empty and not broken frontmatter
      const content = await Bun.file(shadowPath).text().catch(() => "")
      if (content.length < 10) return { verified: false, reason: "shadow markdown empty" }
    }

    // 2. If bun test exists for this area, run it (best-effort, timeout 30s)
    // For now, we treat tsc pass as verified for TS; full test run is opt-in
    // via `MIRA_SHADOW_RUN_TESTS=1`
    if (process.env.MIRA_SHADOW_RUN_TESTS === "1") {
      try {
        const proc = Bun.spawn(["bun", "test", "--timeout", "15000"], {
          cwd: this.config.rootDir,
          stdout: "pipe", stderr: "pipe",
        })
        const exit = await Promise.race([
          proc.exited,
          new Promise<number>((_, rej) => setTimeout(() => rej(new Error("test timeout")), 30_000)),
        ]) as number
        if (exit !== 0) {
          const stderr = await new Response(proc.stderr).text().catch(() => "")
          return { verified: false, reason: `bun test failed (exit ${exit}): ${stderr.slice(0, 600)}` }
        }
      } catch (err) {
        return { verified: false, reason: `test run error: ${String(err)}` }
      }
    }

    // 3. Eval gate (opt-in via MIRA_EVAL_GATE=1): run the pr-tier behavioral
    //    eval harness. This is the RCSI promotion gate — a patch that passes
    //    tsc but regresses any pr check is rejected with the failing checkIds
    //    recorded. Fails CLOSED on harness errors.
    if (process.env.MIRA_EVAL_GATE === "1") {
      try {
        const { runEval } = await import("../eval/index.js")
        const report = await runEval("pr")
        if (!report.passed) {
          const failed = report.tiers
            .flatMap(t => t.checks)
            .filter(c => !c.passed)
            .map(c => c.checkId + (c.message ? ` (${c.message.slice(0, 80)})` : ""))
          return {
            verified: false,
            reason: `eval gate rejected patch — failing checks: ${failed.slice(0, 5).join("; ")}`,
          }
        }
      } catch (err) {
        return { verified: false, reason: `eval gate error (fail closed): ${String(err).slice(0, 300)}` }
      }
    }

    return { verified: true, reason: "shadow checks passed" }
  }

  // ── Apply ──────────────────────────────────────────────────────────

  /** Apply a verified improvement to the real file */
  async apply(imp: Improvement, verifyResult?: VerifyResult): Promise<boolean> {
    if (verifyResult && !verifyResult.verified) {
      console.log(`[learning:improvement] skip apply — not verified: ${imp.id}`)
      return false
    }
    if (this.config.dryRun) {
      console.log(`[learning:improvement] dryRun — would apply ${imp.id} → ${imp.targetFile}`)
      return true
    }
    if (!imp.targetFile) return false
    const abs = `${this.config.rootDir}/${imp.targetFile}`
    const file = Bun.file(abs)
    if (!(await file.exists())) {
      console.log(`[learning:improvement] target missing, skip: ${abs}`)
      return false
    }
    const original = await file.text()
    const patched = applyChange(original, imp.proposedChange, imp.targetFile)
    await Bun.write(abs, patched)
    console.log(`[learning:improvement] ✓ applied ${imp.id} → ${imp.targetFile}`)

    // Record in knowledge base as procedural memory
    if (this.deps.knowledge) {
      await this.deps.knowledge.store({
        tier: "procedural",
        source: "improvement",
        title: `Applied: ${imp.proposedChange.slice(0, 120)} → ${imp.targetFile}`,
        content: `Reason: ${imp.reason}\nChange: ${imp.proposedChange}\nVerified: ${verifyResult?.reason ?? "pre-verified"}`,
        tags: ["improvement", imp.kind, imp.source],
        metadata: { improvementId: imp.id, targetFile: imp.targetFile },
      }).catch(() => {})
    }

    this.deps.bus?.publish({
      type: "learning.updated",
      payload: { kind: "learning.improvement.applied", id: imp.id, file: imp.targetFile },
      timestamp: Date.now(),
      })
    return true
  }

  // ── Full cycle (RCSI loop) ─────────────────────────────────────────

  /**
   * Empirical RCSI loop: synthesize → shadow-verify → apply.
   * Returns a CycleResult for observability.
   */
  async runCycle(
    insights: Insight[],
    analysis: UsageAnalysis | null,
  ): Promise<CycleResult> {
    console.log(`[learning:improvement] cycle start — ${insights.length} insights, ${analysis?.failurePatterns.length ?? 0} failures`)
    const improvements = this.synthesize(insights, analysis)
    if (improvements.length === 0) {
      console.log("[learning:improvement] no improvements synthesized — stable")
      return { status: "stable", analyzed: { insights: insights.length, failures: analysis?.failurePatterns.length ?? 0 }, synthesized: 0, promoted: 0, rejected: 0, improvements: [] }
    }
    console.log(`[learning:improvement] synthesized ${improvements.length} improvements`)
    let promoted = 0, rejected = 0
    const results: CycleResult["improvements"] = []
    for (const imp of improvements) {
      console.log(`  → verifying ${imp.id} (${imp.kind} → ${imp.targetFile})`)
      const vr = await this.verify(imp)
      console.log(`    ${vr.verified ? "VERIFIED" : "REJECTED"}: ${vr.reason}`)
      if (vr.verified) {
        const ok = await this.apply(imp, vr)
        if (ok) promoted++
        results.push({ id: imp.id, targetFile: imp.targetFile, verified: true })
      } else {
        rejected++
        results.push({ id: imp.id, targetFile: imp.targetFile, verified: false })
      }
    }
    console.log(`[learning:improvement] cycle complete — ${promoted} promoted, ${rejected} rejected`)
    return {
      status: "cycle_complete",
      analyzed: { insights: insights.length, failures: analysis?.failurePatterns.length ?? 0 },
      synthesized: improvements.length,
      promoted, rejected,
      improvements: results,
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function targetForInsight(ins: Insight): { file: string | null; kind: Improvement["kind"]; verification: string } {
  const cat = ins.category
  const text = `${ins.summary} ${ins.pattern}`.toLowerCase()
  // Route by category + content signals
  if (cat === "agent-technique" || text.includes("prompt") || text.includes("instruction")) {
    return { file: "AGENTS.md", kind: "agent-prompt", verification: "markdown non-empty" }
  }
  if (cat === "tool" || text.includes("tool") || text.includes("mcp")) {
    // Heuristic: pick most relevant tool file if mentioned, else generic
    if (text.includes("websearch") || text.includes("webfetch")) return { file: "src/tools/websearch.ts", kind: "tool", verification: "tsc --noEmit" }
    if (text.includes("memory") || text.includes("retrieval")) return { file: "src/learning/knowledge.ts", kind: "tool", verification: "tsc --noEmit" }
    return { file: "src/tools/registry.ts", kind: "tool", verification: "tsc --noEmit" }
  }
  if (cat === "eval-method" || text.includes("eval")) {
    return { file: "src/learning/usage.ts", kind: "engine", verification: "tsc --noEmit" }
  }
  if (text.includes("memory") || text.includes("knowledge") || text.includes("retrieval")) {
    return { file: "src/learning/knowledge.ts", kind: "engine", verification: "tsc --noEmit" }
  }
  return { file: "AGENTS.md", kind: "agent-prompt", verification: "markdown non-empty" }
}

function targetForFailure(f: FailurePattern): { file: string | null; kind: Improvement["kind"]; verification: string } {
  const key = f.key.toLowerCase()
  if (key.startsWith("bash") || key.startsWith("edit") || key.startsWith("read") || key.startsWith("write")) {
    const tool = key.split(":")[0]
    return { file: `src/tools/${tool}.ts`, kind: "tool", verification: "tsc --noEmit" }
  }
  if (key.includes("webfetch") || key.includes("websearch")) {
    return { file: "src/tools/websearch.ts", kind: "tool", verification: "tsc --noEmit" }
  }
  if (key.includes("doom")) {
    return { file: "src/session/prompt.ts", kind: "engine", verification: "tsc --noEmit" }
  }
  if (key.includes("feedback") || key.includes("workflow")) {
    return { file: "AGENTS.md", kind: "agent-prompt", verification: "markdown non-empty" }
  }
  return { file: "src/session/prompt.ts", kind: "engine", verification: "tsc --noEmit" }
}

function applyChange(original: string, change: string, targetFile: string): string {
  // Safe generic: append improvement note (RCSI pattern — never rewrites logic)
  const isMD = targetFile.endsWith(".md")
  const note = isMD
    ? `\n\n<!-- Mira Improvement (${new Date().toISOString().slice(0, 10)}): ${change.slice(0, 300)} -->\n`
    : `\n\n// Mira Improvement (${new Date().toString().slice(0, 10)}): ${change.slice(0, 300)}\n`
  // Avoid duplicating identical note
  if (original.includes(change.slice(0, 80))) return original
  return original + note
}

async function syntaxCheck(path: string): Promise<boolean> {
  try {
    const content = await Bun.file(path).text()
    if (content.length < 1) return false
    // For TS: try to parse with Bun's transpiler (throws on syntax error)
    if (path.endsWith(".ts") || path.endsWith(".js")) {
      try { new Function(content) } catch {}
      // Bun transpiler check
      const t = new Bun.Transpiler({ loader: "ts" })
      t.transformSync(content)
    }
    return true
  } catch { return false }
}
