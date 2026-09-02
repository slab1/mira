/**
 * Mira Self-Learning System — Public Entry
 *
 * 5 modules that let Mira search, learn, and improve itself:
 *
 *   OnlineLearner      — web search + doc fetch + insight extraction
 *   UsageLearner       — session/tool metrics + failure/success patterns
 *   KnowledgeBase      — hierarchical memory (episodic/semantic/procedural) + hybrid retrieval
 *   ImprovementEngine  — synthesize → shadow-test → apply (RCSI-style, never unconditional)
 *   LearningScheduler  — periodic orchestration (hourly online, daily improvement, per-session usage)
 *
 * Wiring (in server/src/index.ts):
 *
 *   import { createLearningSystem } from "./learning/index.js"
 *   const learning = createLearningSystem({ db, bus, gateway })
 *   await learning.knowledge.load()
 *   learning.scheduler.start()
 *   // learning is now autonomous; also expose via REST:
 *   //   GET  /learning/status    → scheduler.status() + knowledge.size()
 *   //   POST /learning/trigger   → scheduler.trigger(kind)
 *   //   GET  /learning/insights  → knowledge.list({ source: "online" })
 *
 * Manual / test usage:
 *
 *   const { online, usage, knowledge, improvement, scheduler } = createLearningSystem({ db, bus })
 *   const insights = await online.learnOnce()
 *   const analysis = await usage.analyze()
 *   const result = await improvement.runCycle(insights, analysis)
 */

export * from "./online.js"
export * from "./usage.js"
export * from "./knowledge.js"
export * from "./improvement.js"
export * from "./scheduler.js"

import { OnlineLearner } from "./online.js"
import { UsageLearner } from "./usage.js"
import { KnowledgeBase, type MemoryTier, type MemorySource } from "./knowledge.js"
import { ImprovementEngine } from "./improvement.js"
import { LearningScheduler } from "./scheduler.js"
import { createPatchingSystem, type PatchingEngine } from "../patching/index.js"
import type { Bus } from "../bus/index.js"
import type { MiraDB } from "../storage/db.js"
import type { Gateway } from "../gateway/index.js"
import { Hono } from "hono"

export interface LearningSystemDeps {
  db?: MiraDB
  bus?: Bus
  gateway?: Gateway
  /** override repo root for ImprovementEngine (default process.cwd()) */
  rootDir?: string
}

export interface LearningSystem {
  online: OnlineLearner
  usage: UsageLearner
  knowledge: KnowledgeBase
  improvement: ImprovementEngine
  patching: PatchingEngine
  scheduler: LearningScheduler
  db?: MiraDB
}

/**
 * Create the full Mira learning system with shared deps.
 * Each module receives the same db/bus/gateway so they stay coordinated.
 */
export function createLearningSystem(deps: LearningSystemDeps = {}): LearningSystem {
  const knowledge = new KnowledgeBase({ bus: deps.bus, db: deps.db })

  const online = new OnlineLearner({ bus: deps.bus, db: deps.db })

  const usage = new UsageLearner({ bus: deps.bus, db: deps.db })

  const improvement = new ImprovementEngine(
    { bus: deps.bus, db: deps.db, knowledge, gateway: deps.gateway },
    { rootDir: deps.rootDir ?? process.cwd() },
  )

  const patching = createPatchingSystem(
    { bus: deps.bus, db: deps.db, knowledge, gateway: deps.gateway },
    { rootDir: deps.rootDir ?? process.cwd(), autoPatch: true },
  )

  const scheduler = new LearningScheduler(
    { online, usage, improvement, knowledge, bus: deps.bus, db: deps.db, patching, gateway: deps.gateway },
  )

  return { online, usage, knowledge, improvement, patching, scheduler, db: deps.db }
}

/** Convenience: wire learning REST routes onto a Hono app */
export function mountLearningRoutes(
  app: Hono<{ Variables: { requestId: string } }>,
  system: LearningSystem,
): void {
  app.get("/learning/status", (c) =>
    c.json({
      scheduler: system.scheduler.status(),
      knowledge: { size: system.knowledge.size(), tiers: ["episodic", "semantic", "procedural"] },
      usage: system.usage.getStats(),
    }),
  )

  app.post("/learning/trigger", async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const kind = body.kind ?? "all"
    const result = await system.scheduler.trigger(kind)
    return c.json({ kind, result })
  })

  app.get("/learning/insights", async (c) => {
    const url = new URL(c.req.url)
    const tier = url.searchParams.get("tier") as MemoryTier | null
    const source = url.searchParams.get("source") as MemorySource | null
    const q = url.searchParams.get("q")
    if (q) {
      const results = await system.knowledge.retrieve({ query: q, tier: tier ?? undefined, limit: 20 })
      return c.json(results)
    }
    return c.json(system.knowledge.list({ tier: tier ?? undefined, source: source ?? undefined, limit: 50 }))
  })

  app.get("/learning/score", async (c) => {
    const url = new URL(c.req.url)
    const sessionID =
      url.searchParams.get("sessionID") ??
      url.searchParams.get("sessionId") ??
      url.searchParams.get("session_id") ??
      url.searchParams.get("id") ??
      ""
    if (!sessionID) return c.json({ error: "sessionID required" }, 400)
    const sqlite = system.db?.sqlite
    if (!sqlite) return c.json({ error: "no db" }, 500)
    try {
      // Session row — cost, tokens, createdAt
      let row: {
        id: string
        model: string | null
        cost_usd: number | null
        tokens_in: number | null
        tokens_out: number | null
        created_at: number | null
      } | undefined
      try {
        row = sqlite
          .prepare("SELECT id, model, cost_usd, tokens_in, tokens_out, created_at FROM sessions WHERE id = ?")
          .get(sessionID) as typeof row
      } catch {
        return c.json({ error: "session not found" }, 404)
      }
      if (!row) return c.json({ error: "session not found" }, 404)

      // Cost — prefer sessions.cost_usd, else estimate from tokens via priceFor
      let cost = row.cost_usd ?? 0
      if ((cost === null || cost === 0) && (row.tokens_in || row.tokens_out)) {
        try {
          const { priceFor } = await import("../gateway/pricing.js")
          const [pin, pout] = priceFor(row.model ?? "claude-sonnet-4")
          cost = ((row.tokens_in ?? 0) * pin + (row.tokens_out ?? 0) * pout) / 1_000_000
        } catch {}
      }
      cost = Number(cost ?? 0)

      // Usage metrics — toolErrors, doomLoops
      let toolErrors = 0
      let doomLoops = 0
      try {
        const u = sqlite
          .prepare("SELECT tool_errors, doom_loops FROM usage_sessions WHERE session_id = ?")
          .get(sessionID) as { tool_errors?: number; doom_loops?: number } | undefined
        if (u) {
          toolErrors = u.tool_errors ?? 0
          doomLoops = u.doom_loops ?? 0
        } else {
          // Fallback: count tool-result errors from parts
          try {
            const cnt = sqlite
              .prepare("SELECT COUNT(*) as c FROM parts WHERE session_id = ? AND type = 'tool-result' AND is_error = 1")
              .get(sessionID) as { c?: number } | undefined
            toolErrors = cnt?.c ?? 0
          } catch {}
        }
      } catch {}

      // Memory hits — count knowledge_entries for this session (if column exists)
      let memoryHits = 0
      try {
        const kh = sqlite
          .prepare("SELECT COUNT(*) as c FROM knowledge_entries WHERE session_id = ?")
          .get(sessionID) as { c?: number } | undefined
        memoryHits = kh?.c ?? 0
      } catch {
        // Table may have different schema (knowledge.ts tier/source) — try total count as fallback, but keep per-session 0
        memoryHits = 0
      }
      // Also consider in-memory knowledge size as global hits if per-session is 0 and knowledge has entries
      // Keep per-session semantics: don't inflate with global count

      // Message count
      let messageCount = 0
      try {
        const mc = sqlite
          .prepare("SELECT COUNT(*) as c FROM messages WHERE session_id = ?")
          .get(sessionID) as { c?: number } | undefined
        messageCount = mc?.c ?? 0
      } catch {}

      const createdAt = row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString()

      // Score heuristic: 10 - (toolErrors*0.5 + doomLoops*1.5 + cost*0.1) + memoryHits*0.05, clamped 0-10
      let score = 10 - (toolErrors * 0.5 + doomLoops * 1.5 + cost * 0.1) + memoryHits * 0.05
      score = Math.max(0, Math.min(10, score))
      score = Math.round(score * 10) / 10

      return c.json({
        sessionID,
        score,
        cost: Number(cost.toFixed(4)),
        doomLoops,
        toolErrors,
        memoryHits,
        messageCount,
        createdAt,
      })
    } catch (e) {
      return c.json({ error: String(e) }, 500)
    }
  })
}
