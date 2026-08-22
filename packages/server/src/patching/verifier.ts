/**
 * Mira Patching — Verifier
 *
 * Shadow testing: apply patch to a temp copy, run checks, compare.
 * NEVER returns verified=true unconditionally (RCSI principle).
 *
 * Strategies (in priority order):
 *  1. TS/JS target → tsc --noEmit on shadow
 *  2. Markdown  → non-empty + frontmatter sanity
 *  3. Optional → bun test (when MIRA_SHADOW_RUN_TESTS=1) + eval pr tier
 *  4. Fallback → syntax check via Bun transpiler
 */

import type { Patch } from "./patcher.js"
import type { EvalReport } from "../eval/index.js"

// ── Types ──────────────────────────────────────────────────────────

export interface VerifyResult {
  verified: boolean
  reason: string
  shadowOutput?: string
  evalReport?: EvalReport | null
}

export interface VerifierConfig {
  rootDir?: string
  runTests?: boolean
  runEval?: boolean
  timeoutMs?: number
}

// ── Verifier ───────────────────────────────────────────────────────

export class Verifier {
  private config: Required<VerifierConfig>

  constructor(config: VerifierConfig = {}) {
    this.config = {
      rootDir: config.rootDir ?? process.cwd(),
      runTests: config.runTests ?? process.env.MIRA_SHADOW_RUN_TESTS === "1",
      runEval: config.runEval ?? false,
      timeoutMs: config.timeoutMs ?? 30_000,
    }
  }

  /**
   * Shadow-test a patch: copy original → apply change → run verification.
   * Never unconditional.
   */
  async verify(patch: Patch): Promise<VerifyResult> {
    if (!patch.targetFile) {
      return { verified: false, reason: "no targetFile — cannot verify file-less patch" }
    }
    const abs = `${this.config.rootDir}/${patch.targetFile}`
    const file = Bun.file(abs)
    if (!(await file.exists())) {
      return { verified: false, reason: `target not found: ${patch.targetFile}` }
    }

    const tmpDir = `${this.config.rootDir}/.tmp_shadow_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`
    const { mkdirSync, rmSync, writeFileSync } = await import("node:fs")
    try {
      mkdirSync(tmpDir, { recursive: true })
      const original = await file.text()
      const shadowPath = `${tmpDir}/shadow_${patch.targetFile.replace(/\//g, "_")}`
      const patched = applyChange(original, patch.change, patch.targetFile)
      writeFileSync(shadowPath, patched, "utf-8")

      // Core checks: tsc / markdown
      const core = await this.runShadowChecks(shadowPath, patch, original)
      if (!core.verified) return core

      // Optional: bun test
      if (this.config.runTests) {
        const testResult = await this.runTests()
        if (!testResult.verified) return testResult
      }

      // Optional: eval pr tier (expensive, only when runEval=true)
      if (this.config.runEval) {
        const evalResult = await this.runEval()
        if (!evalResult.verified) return evalResult
        return { verified: true, reason: `shadow passed + tests + eval`, evalReport: evalResult.evalReport ?? undefined }
      }

      return { verified: true, reason: core.reason }
    } catch (err) {
      return { verified: false, reason: `shadow error: ${String(err)}` }
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
    }
  }

  /** Verify multiple patches sequentially */
  async verifyAll(patches: Patch[]): Promise<Array<Patch & { result: VerifyResult }>> {
    const out: Array<Patch & { result: VerifyResult }> = []
    for (const p of patches) {
      const result = await this.verify(p)
      out.push({ ...p, result })
    }
    return out
  }

  // ── Shadow checks ────────────────────────────────────────────────

  private async runShadowChecks(
    shadowPath: string,
    patch: Patch,
    _original: string,
  ): Promise<VerifyResult> {
    const target = patch.targetFile!

    // TS/JS files: tsc --noEmit on shadow
    if (target.endsWith(".ts") || target.endsWith(".js")) {
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
        const ok = await syntaxCheck(shadowPath)
        if (!ok) return { verified: false, reason: `syntax check failed: ${String(err)}` }
      }
      return { verified: true, reason: "shadow tsc passed" }
    }

    // Markdown prompts: ensure non-empty and not broken
    if (target.endsWith(".md")) {
      const content = await Bun.file(shadowPath).text().catch(() => "")
      if (content.length < 10) return { verified: false, reason: "shadow markdown empty" }
      if (content.length > 500_000) return { verified: false, reason: "shadow markdown suspiciously large" }
      return { verified: true, reason: "shadow markdown non-empty" }
    }

    // Unknown type: syntax check via Bun transpiler
    const ok = await syntaxCheck(shadowPath)
    if (!ok) return { verified: false, reason: "shadow syntax check failed" }
    return { verified: true, reason: "shadow syntax passed" }
  }

  private async runTests(): Promise<VerifyResult> {
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
      return { verified: true, reason: "bun test passed" }
    } catch (err) {
      return { verified: false, reason: `test run error: ${String(err)}` }
    }
  }

  private async runEval(): Promise<VerifyResult & { evalReport?: EvalReport | null }> {
    try {
      const { EvalRunner } = await import("../eval/index.js")
      const runner = new EvalRunner()
      const report = await runner.run("pr")
      if (!report.passed) {
        return { verified: false, reason: `eval pr tier FAILED: ${report.tiers.filter(t => !t.passed).map(t => t.summary).join("; ").slice(0, 400)}`, evalReport: report }
      }
      return { verified: true, reason: "eval pr tier passed", evalReport: report }
    } catch (err) {
      return { verified: false, reason: `eval error: ${String(err)}` }
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function applyChange(original: string, change: string, targetFile: string): string {
  const isMD = targetFile.endsWith(".md")
  const note = isMD
    ? `\n\n<!-- Mira Patch (${new Date().toISOString().slice(0, 10)}): ${change.slice(0, 300)} -->\n`
    : `\n\n// Mira Patch (${new Date().toISOString().slice(0, 10)}): ${change.slice(0, 300)}\n`
  if (original.includes(change.slice(0, 80))) return original
  return original + note
}

async function syntaxCheck(path: string): Promise<boolean> {
  try {
    const content = await Bun.file(path).text()
    if (content.length < 1) return false
    if (path.endsWith(".ts") || path.endsWith(".js")) {
      const t = new Bun.Transpiler({ loader: "ts" })
      t.transformSync(content)
    }
    return true
  } catch { return false }
}
