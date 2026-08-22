/**
 * Mira Patching — Patcher
 *
 * Generates patches for engine, tools, and agent prompts from detected pain points.
 * Each pain point maps to a target file + change template.
 *
 * Safety:
 *  - Generic patches append an improvement note (like ImprovementEngine) rather than rewriting logic
 *  - Target-specific patches use minimal diffs that pass shadow tests
 */

import type { PainPoint, PainPointId } from "./detector.js"

// ── Types ──────────────────────────────────────────────────────────

export type PatchKind = "agent-prompt" | "tool" | "engine" | "config" | "security" | "latency"
export type PatchTarget = string // relative path from server root, e.g. "src/tools/bash.ts"

export interface Patch {
  id: string
  painPointId: PainPointId
  kind: PatchKind
  targetFile: PatchTarget | null
  reason: string
  change: string        // applied by applier (append note or structured diff)
  verification: string  // expected verification command
  severity: PainPoint["severity"]
  score: number
  createdAt: number
}

export interface PatcherConfig {
  rootDir?: string
  maxPatchesPerCycle?: number
}

// ── Pain point → patch routing ─────────────────────────────────────

interface PatchRecipe {
  kind: PatchKind
  targetFile: PatchTarget
  verification: string
  changeFor: (p: PainPoint) => string
}

const RECIPES: Record<PainPointId, PatchRecipe> = {
  "over-eager": {
    kind: "agent-prompt",
    targetFile: "AGENTS.md",
    verification: "markdown non-empty",
    changeFor: p => `Guard over-eager: cap tool calls per turn to 4; require plan before edit/write. Evidence: ${p.evidence.join("; ").slice(0, 180)}`,
  },
  "token-cost": {
    kind: "engine",
    targetFile: "src/session/prompt.ts",
    verification: "tsc --noEmit",
    changeFor: p => `Reduce token cost: summarize tool results >500 chars, compact at 60% window, batch reads. Evidence: ${p.evidence.join("; ").slice(0, 180)}`,
  },
  "unpredictable": {
    kind: "agent-prompt",
    targetFile: "AGENTS.md",
    verification: "markdown non-empty",
    changeFor: p => `Make behavior predictable: enforce plan-first workflow; add decision log per step. Evidence: ${p.evidence.join("; ").slice(0, 180)}`,
  },
  "context-overload": {
    kind: "engine",
    targetFile: "src/session/prompt.ts",
    verification: "tsc --noEmit",
    changeFor: p => `Fix context overload: retrieve relevant memory instead of loading all context; token-budget reads. Evidence: ${p.evidence.join("; ").slice(0, 180)}`,
  },
  "false-positives": {
    kind: "config",
    targetFile: "src/patching/detector.ts",
    verification: "tsc --noEmit",
    changeFor: p => `Tune false positives: raise detector thresholds by 0.1; require 2 corroborating signals before flagging. Evidence: ${p.evidence.join("; ").slice(0, 180)}`,
  },
  "debugging-harder": {
    kind: "engine",
    targetFile: "src/eval/tracing.ts",
    verification: "tsc --noEmit",
    changeFor: p => `Improve debuggability: add trace IDs to every tool-call; log patch decisions with reason. Evidence: ${p.evidence.join("; ").slice(0, 180)}`,
  },
  "eval-risk": {
    kind: "config",
    targetFile: "src/eval/tiers.ts",
    verification: "tsc --noEmit",
    changeFor: p => `Reduce eval risk: require PR tier to pass before applying patches; gate on evalReport.passed. Evidence: ${p.evidence.join("; ").slice(0, 180)}`,
  },
  "latency": {
    kind: "latency",
    targetFile: "src/patching/latency.ts",
    verification: "tsc --noEmit",
    changeFor: p => `Optimize latency: ${p.evidence.join("; ").slice(0, 180)} — suggestions: parallelize tool calls, stream early, add per-tool timeout 15s`,
  },
  "security": {
    kind: "security",
    targetFile: "src/patching/security.ts",
    verification: "tsc --noEmit",
    changeFor: p => `Harden security: ${p.evidence.join("; ").slice(0, 180)} — add injection guard + secrets scan + path sandbox`,
  },
}

// ── Patcher ────────────────────────────────────────────────────────

export class Patcher {
  private config: Required<PatcherConfig>

  constructor(config: PatcherConfig = {}) {
    this.config = {
      rootDir: config.rootDir ?? process.cwd(),
      maxPatchesPerCycle: config.maxPatchesPerCycle ?? 6,
    }
  }

  generate(painPoints: PainPoint[]): Patch[] {
    const active = painPoints.filter(p => p.score >= p.threshold)
    // Sort by severity then score (critical/high first)
    const order: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 }
    active.sort((a, b) => (order[b.severity] - order[a.severity]) || (b.score - a.score))

    const out: Patch[] = []
    const seenTarget = new Set<string>()

    for (const pp of active) {
      const recipe = RECIPES[pp.id]
      if (!recipe) continue
      // Dedupe by targetFile — one patch per file per cycle
      if (seenTarget.has(recipe.targetFile)) continue
      seenTarget.add(recipe.targetFile)

      out.push({
        id: `patch_${pp.id}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 4)}`,
        painPointId: pp.id,
        kind: recipe.kind,
        targetFile: recipe.targetFile,
        reason: `${pp.label} [${pp.severity}/${pp.score}] — ${pp.evidence.join("; ").slice(0, 200)}`,
        change: recipe.changeFor(pp),
        verification: recipe.verification,
        severity: pp.severity,
        score: pp.score,
        createdAt: Date.now(),
      })
      if (out.length >= this.config.maxPatchesPerCycle) break
    }
    return out
  }

  /** Single patch for a specific pain point */
  generateOne(painPoint: PainPoint): Patch | null {
    const patches = this.generate([painPoint])
    return patches[0] ?? null
  }

  /** Patch with explicit override (for manual / tool-generated patches) */
  createManual(input: {
    painPointId: PainPointId
    kind: PatchKind
    targetFile: PatchTarget | null
    reason: string
    change: string
    verification?: string
  }): Patch {
    return {
      id: `patch_manual_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 4)}`,
      painPointId: input.painPointId,
      kind: input.kind,
      targetFile: input.targetFile,
      reason: input.reason,
      change: input.change,
      verification: input.verification ?? "tsc --noEmit",
      severity: "medium",
      score: 0.6,
      createdAt: Date.now(),
    }
  }
}
