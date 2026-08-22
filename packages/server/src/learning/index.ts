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
import { KnowledgeBase } from "./knowledge.js"
import { ImprovementEngine } from "./improvement.js"
import { LearningScheduler } from "./scheduler.js"
import type { Bus } from "../bus/index.js"

export interface LearningSystemDeps {
  db?: any
  bus?: Bus
  gateway?: any
  /** override repo root for ImprovementEngine (default process.cwd()) */
  rootDir?: string
}

export interface LearningSystem {
  online: OnlineLearner
  usage: UsageLearner
  knowledge: KnowledgeBase
  improvement: ImprovementEngine
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

  const scheduler = new LearningScheduler(
    { online, usage, improvement, knowledge, bus: deps.bus, db: deps.db },
  )

  return { online, usage, knowledge, improvement, scheduler }
}

/** Convenience: wire learning REST routes onto a Hono app */
export function mountLearningRoutes(
  app: { get: any; post: any },
  system: LearningSystem,
): void {
  app.get("/learning/status", (c: any) =>
    c.json({
      scheduler: system.scheduler.status(),
      knowledge: { size: system.knowledge.size(), tiers: ["episodic", "semantic", "procedural"] },
      usage: system.usage.getStats(),
    }),
  )

  app.post("/learning/trigger", async (c: any) => {
    const body = await c.req.json().catch(() => ({}))
    const kind = body.kind ?? "all"
    const result = await system.scheduler.trigger(kind)
    return c.json({ kind, result })
  })

  app.get("/learning/insights", async (c: any) => {
    const url = new URL(c.req.url)
    const tier = url.searchParams.get("tier") as any
    const source = url.searchParams.get("source") as any
    const q = url.searchParams.get("q")
    if (q) {
      const results = await system.knowledge.retrieve({ query: q, tier: tier ?? undefined, limit: 20 })
      return c.json(results)
    }
    return c.json(system.knowledge.list({ tier: tier ?? undefined, source: source ?? undefined, limit: 50 }))
  })
}
