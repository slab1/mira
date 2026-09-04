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

  return { online, usage, knowledge, improvement, patching, scheduler }
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

  // H2-1 Memory v2: graph + temporal — read-only, for web MemoryGraph canvas
  app.get("/knowledge/graph", async (c) => {
    const url = new URL(c.req.url)
    const limit = Math.min(Number(url.searchParams.get("limit") ?? "100") || 100, 500)
    const graph = await system.knowledge.getGraph(limit)
    return c.json(graph)
  })

  // Alias for web convenience (same payload)
  app.get("/learning/graph", async (c) => {
    const url = new URL(c.req.url)
    const limit = Math.min(Number(url.searchParams.get("limit") ?? "100") || 100, 500)
    const graph = await system.knowledge.getGraph(limit)
    return c.json(graph)
  })
}
