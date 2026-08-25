/**
 * Mira Patching — Applier
 *
 * Applies verified patches to real files. Never applies unverified patches.
 * Records outcome to KnowledgeBase / DB and bus for observability.
 */

import type { Patch } from "./patcher.js"
import type { VerifyResult } from "./verifier.js"
import type { Bus } from "../bus/index.js"
import type { KnowledgeBase } from "../learning/knowledge.js"
import type { MiraDB } from "../storage/db.js"

// ── Types ──────────────────────────────────────────────────────────

export interface ApplyResult {
  applied: boolean
  reason: string
  patchId: string
  targetFile: string | null
}

export interface ApplierConfig {
  rootDir?: string
  dryRun?: boolean
}

export interface ApplierDeps {
  bus?: Bus
  knowledge?: KnowledgeBase
  db?: MiraDB
}

// ── Applier ────────────────────────────────────────────────────────

export class Applier {
  private config: Required<ApplierConfig>

  constructor(
    private deps: ApplierDeps = {},
    config: ApplierConfig = {},
  ) {
    this.config = {
      rootDir: config.rootDir ?? process.cwd(),
      dryRun: config.dryRun ?? false,
    }
  }

  /**
   * Apply a single verified patch.
   * Returns { applied:false } if not verified or dryRun.
   */
  async apply(patch: Patch, verifyResult?: VerifyResult): Promise<ApplyResult> {
    if (verifyResult && !verifyResult.verified) {
      return { applied: false, reason: `skip unverified: ${verifyResult.reason}`, patchId: patch.id, targetFile: patch.targetFile }
    }
    if (!patch.targetFile) {
      return { applied: false, reason: "no targetFile", patchId: patch.id, targetFile: null }
    }
    if (this.config.dryRun) {
      console.log(`[patching:applier] dryRun — would apply ${patch.id} → ${patch.targetFile}`)
      return { applied: true, reason: "dryRun — not written", patchId: patch.id, targetFile: patch.targetFile }
    }

    const abs = `${this.config.rootDir}/${patch.targetFile}`
    const file = Bun.file(abs)
    if (!(await file.exists())) {
      return { applied: false, reason: `target missing: ${patch.targetFile}`, patchId: patch.id, targetFile: patch.targetFile }
    }

    const original = await file.text()
    const patched = applyChange(original, patch.change, patch.targetFile)
    await Bun.write(abs, patched)
    console.log(`[patching:applier] ✓ applied ${patch.id} → ${patch.targetFile} (${patch.painPointId})`)

    // Autopilot (opt-in): open a PR for the verified patch
    if (process.env.MIRA_AUTOPILOT === "1") {
      try {
        const { createPullRequestForPatch } = await import("./autopilot.js")
        const pr = await createPullRequestForPatch({
          repoRoot: this.config.rootDir,
          files: [patch.targetFile],
          painPointId: patch.painPointId,
          reason: patch.reason,
          change: patch.change,
          patchId: patch.id,
        })
        console.log(`[patching:applier] autopilot PR: ${pr.created ? pr.prUrl : pr.reason}`)
      } catch {}
    }

    // Persist to knowledge base as procedural memory
    if (this.deps.knowledge) {
      await this.deps.knowledge.store({
        tier: "procedural",
        source: "improvement",
        title: `Patch applied: ${patch.painPointId} → ${patch.targetFile}`,
        content: `Reason: ${patch.reason}\nChange: ${patch.change}\nVerified: ${verifyResult?.reason ?? "pre-verified"}`,
        tags: ["patching", patch.kind, patch.painPointId],
        metadata: { patchId: patch.id, targetFile: patch.targetFile, painPointId: patch.painPointId },
      }).catch(() => {})
    }

    // DB audit log (best-effort)
    if (this.deps.db?.sqlite) {
      try {
        const sqlite = this.deps.db.sqlite
        sqlite.exec(`
          CREATE TABLE IF NOT EXISTS patching_log (
            id TEXT PRIMARY KEY,
            patch_id TEXT NOT NULL,
            pain_point TEXT NOT NULL,
            target_file TEXT,
            reason TEXT,
            verified INTEGER NOT NULL,
            created_at INTEGER NOT NULL
          );
        `)
        sqlite.prepare(
          `INSERT INTO patching_log (id, patch_id, pain_point, target_file, reason, verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(crypto.randomUUID(), patch.id, patch.painPointId, patch.targetFile, patch.reason.slice(0, 500), 1, Date.now())
      } catch {}
    }

    this.deps.bus?.publish({
      type: "learning.updated",
      payload: { kind: "patching.applied", id: patch.id, file: patch.targetFile, painPoint: patch.painPointId },
      timestamp: Date.now(),
      })

    return { applied: true, reason: verifyResult?.reason ?? "applied", patchId: patch.id, targetFile: patch.targetFile }
  }

  /** Apply many — only verified ones */
  async applyAll(
    patches: Array<Patch & { result?: VerifyResult }>,
  ): Promise<ApplyResult[]> {
    const out: ApplyResult[] = []
    for (const p of patches) {
      const vr = p.result
      if (vr && !vr.verified) {
        out.push({ applied: false, reason: `rejected: ${vr.reason}`, patchId: p.id, targetFile: p.targetFile })
        continue
      }
      out.push(await this.apply(p, vr))
    }
    return out
  }

  /** History from DB (for dashboard) */
  listHistory(limit = 20): Array<{ patch_id: string; pain_point: string; target_file: string; created_at: number }> {
    try {
      const sqlite = this.deps.db?.sqlite
      if (!sqlite) return []
      interface HistoryRow { patch_id: string; pain_point: string; target_file: string; created_at: number }
      return sqlite.prepare(`SELECT patch_id, pain_point, target_file, created_at FROM patching_log ORDER BY created_at DESC LIMIT ?`).all(limit) as HistoryRow[]
    } catch { return [] }
  }
}

// ── helpers ────────────────────────────────────────────────────────

function applyChange(original: string, change: string, targetFile: string): string {
  const isMD = targetFile.endsWith(".md")
  const note = isMD
    ? `\n\n<!-- Mira Patch (${new Date().toISOString().slice(0, 10)}): ${change.slice(0, 300)} -->\n`
    : `\n\n// Mira Patch (${new Date().toISOString().slice(0, 10)}): ${change.slice(0, 300)}\n`
  if (original.includes(change.slice(0, 80))) return original
  return original + note
}
