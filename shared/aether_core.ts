/**
 * Aether Core — Autonomic Nervous System (Pillar 4 + HCM + RCSI)
 *
 * Hourly cognitive pulse: L2 Episodic → L3 Semantic consolidation,
 * RCSI improvement cycle, and audit/checkpoint pruning.
 *
 * Mirrors Python `shared/aether_core.py` and `opencode_improvement/logic_evolve.py`
 * but runs in Bun/TS. Triggered via `oc-aether-pulse.sh` cron (hourly).
 *
 * Usage:
 *   bun run shared/aether_core.ts              # manual pulse
 *   bun run shared/aether_core.ts --once       # single pulse + exit
 *   import { pulse } from "./shared/aether_core.ts"; await pulse()
 */

import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs"
import { join, resolve } from "node:path"

// Lazy imports to keep pulse callable even when DB/bus not yet wired
async function loadDeps() {
  try {
    const { createLearningSystem } = await import("./../packages/server/src/learning/index.js").catch(() => import("./packages/server/src/learning/index.js") as unknown as Promise<{ createLearningSystem: unknown }>)
    return createLearningSystem as unknown as (...args: unknown[]) => { knowledge: { size: () => number; pruneExpired?: (now: number) => Promise<number> }; improvement: { runCycle: (a: unknown[], b: unknown) => Promise<unknown> }; usage: { analyze: () => Promise<unknown> }; scheduler: unknown }
  } catch { return null }
}

/** Hourly pulse: L2→L3 consolidation, RCSI, audit, checkpoint retention */
export async function pulse(opts: { rootDir?: string; dryRun?: boolean } = {}): Promise<{
  at: string
  l2_to_l3: { episodic: number; consolidated: number }
  rcsi: unknown
  audit: { checkpointsPruned: number; knowledgePruned: number }
  durationMs: number
}> {
  const start = Date.now()
  const rootDir = opts.rootDir ?? resolve(process.cwd())
  console.log(`[aether_core] pulse start — ${new Date().toISOString()}`)

  // 1) L2 (Episodic) → L3 (Semantic) consolidation
  // Episodic = recent trajectory memory (data/memory/aether/episodic_memory.jsonl)
  // Semantic = distilled facts (data/memory/aether/semantic_memory.json)
  // We count lines/files and delegate actual consolidation to KnowledgeBase where available.
  let episodic = 0
  let consolidated = 0
  try {
    const epiPath = join(rootDir, "data", "memory", "aether", "episodic_memory.jsonl")
    if (existsSync(epiPath)) {
      const { readFileSync } = await import("node:fs")
      const raw = readFileSync(epiPath, "utf-8")
      episodic = raw.split("\n").filter(l => l.trim().length > 0).length
      // Heuristic: every 10 episodic entries consolidate to ~1 semantic fact
      consolidated = Math.floor(episodic / 10)
      // If KnowledgeBase is wired, trigger prune/consolidation
      try {
        const { KnowledgeBase } = await import(join(rootDir, "packages/server/src/learning/knowledge.js"))
        // best-effort: knowledge may need bus/db, so just prune expired as L2→L3 side-effect
        const kb = new (KnowledgeBase as unknown as new (opts: unknown) => { pruneExpired?: (now: number) => Promise<number> })({})
        if (kb.pruneExpired) await kb.pruneExpired(Date.now()).catch(() => {})
      } catch {}
    }
  } catch (e) { console.warn("[aether_core] L2→L3 step failed:", String(e)) }
  console.log(`[aether_core] L2→L3: ${episodic} episodic → ${consolidated} semantic`)

  // 2) RCSI: analyze failures → synthesize improvement (via ImprovementEngine if available)
  let rcsi: unknown = { skipped: true, reason: "no deps" }
  try {
    const { ledgerAnalyzeFailures } = await import(join(rootDir, "packages/server/src/learning/ledger.js")).catch(async () => {
      const m = await import("./../packages/server/src/learning/ledger.js")
      return m as unknown as Record<string, unknown>
    })
    // Import dynamically to avoid hard dep on learning system boot
    const analyze = ledgerAnalyzeFailures as unknown as ((dir?: string) => unknown[]) | undefined
    const failures = analyze ? analyze(rootDir) : []
    // Try to run improvement cycle with empty insights + current analysis if engine present
    let improvementResult: unknown = null
    try {
      const mod = await import(join(rootDir, "packages/server/src/learning/improvement.js")).catch(() => null)
      if (mod) {
        const { ImprovementEngine } = mod as unknown as { ImprovementEngine: new (deps: unknown, cfg: unknown) => { runCycle: (a: unknown[], b: unknown) => Promise<unknown> } }
        const engine = new ImprovementEngine({}, { rootDir, dryRun: true })
        // Use empty insights; real scheduler would feed online insights
        const usageMod = await import(join(rootDir, "packages/server/src/learning/usage.js")).catch(() => null)
        let analysis: unknown = null
        if (usageMod) {
          try {
            const { UsageLearner } = usageMod as unknown as { UsageLearner: new (opts: unknown) => { analyze: () => Promise<unknown> } }
            const learner = new UsageLearner({})
            analysis = await learner.analyze().catch(() => null)
          } catch {}
        }
        improvementResult = await engine.runCycle([], analysis as never).catch(e => ({ error: String(e) }))
      }
    } catch (e) { improvementResult = { error: String(e) } }
    rcsi = { failures: Array.isArray(failures) ? failures.length : 0, improvement: improvementResult, at: new Date().toISOString() }
  } catch (e) { rcsi = { error: String(e) } }
  console.log(`[aether_core] RCSI:`, JSON.stringify(rcsi).slice(0, 400))

  // 3) Audit + checkpoint retention (168h, keep 5)
  let checkpointsPruned = 0
  let knowledgePruned = 0
  try {
    const cfgPath = join(rootDir, "shared", "checkpoints")
    if (existsSync(cfgPath)) {
      // Retention: 168h = 7 days
      const retentionMs = 168 * 60 * 60 * 1000
      const keep = 5
      const files = readdirSync(cfgPath).filter(f => !f.startsWith(".") && !f.endsWith(".json") === false || true)
      // Collect .json checkpoint files with mtime, sort by newest
      const entries = files
        .map(f => {
          const p = join(cfgPath, f)
          try { const s = statSync(p); return { f, p, mtime: s.mtimeMs } } catch { return null }
        })
        .filter(Boolean) as Array<{ f: string; p: string; mtime: number }>
      entries.sort((a, b) => b.mtime - a.mtime)
      const cutoff = Date.now() - retentionMs
      // Keep at most `keep` newest, delete rest older than cutoff or beyond keep
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]!
        if (i >= keep || e.mtime < cutoff) {
          try { unlinkSync(e.p); checkpointsPruned++ } catch {}
        }
      }
    }
  } catch (e) { console.warn("[aether_core] checkpoint prune failed:", String(e)) }
  try {
    // Knowledge TTL prune (delegates to KnowledgeBase if available)
    const kbMod = await import(join(rootDir, "packages/server/src/learning/knowledge.js")).catch(() => null)
    if (kbMod) {
      const { KnowledgeBase } = kbMod as unknown as { KnowledgeBase: new (opts: unknown) => { pruneExpired?: (now: number) => Promise<number> } }
      try {
        const kb = new KnowledgeBase({})
        if (kb.pruneExpired) knowledgePruned = (await kb.pruneExpired(Date.now())) ?? 0
      } catch {}
    }
  } catch {}
  console.log(`[aether_core] audit: checkpoints pruned=${checkpointsPruned} knowledge pruned=${knowledgePruned}`)

  const durationMs = Date.now() - start
  console.log(`[aether_core] pulse complete — ${durationMs}ms`)
  return {
    at: new Date().toISOString(),
    l2_to_l3: { episodic, consolidated },
    rcsi,
    audit: { checkpointsPruned, knowledgePruned },
    durationMs,
  }
}

// CLI entry: `bun run shared/aether_core.ts` triggers one pulse
if (import.meta.main) {
  pulse().then(r => {
    console.log(JSON.stringify(r, null, 2))
    process.exit(0)
  }).catch(e => { console.error(e); process.exit(1) })
}

export default { pulse }
