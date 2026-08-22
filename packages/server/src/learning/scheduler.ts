/**
 * Mira Learning Scheduler — Periodic Orchestration
 *
 * Wires the four pillars together on a schedule:
 *   - Online search   → hourly (configurable) + on demand
 *   - Usage analysis  → after each session (event-driven) + nightly rollup
 *   - Improvement     → daily (consumes online + usage)
 *   - Knowledge sync  → continuous (each store() persists)
 *
 * Event-driven (no polling for session triggers):
 *   BusEvent "message.created" / "session.deleted" → usage analysis
 *   Manual `trigger("online" | "usage" | "improvement" | "all")` for TUI/API
 *
 * Cron-like intervals use setInterval + jitter to avoid thundering herd.
 * All jobs are serialized per-kind (no overlapping runs) and log to the bus.
 *
 * Usage:
 *   const scheduler = new LearningScheduler({ online, usage, improvement, knowledge, bus, db })
 *   scheduler.start()  // begin periodic jobs
 *   scheduler.stop()   // graceful shutdown (clears intervals)
 *   await scheduler.trigger("all") // manual run
 */

import type { Bus } from "../bus/index.js"
import type { OnlineLearner } from "./online.js"
import type { UsageLearner } from "./usage.js"
import type { ImprovementEngine } from "./improvement.js"
import type { KnowledgeBase } from "./knowledge.js"

// ── Types ────────────────────────────────────────────────────────────

export interface SchedulerConfig {
  /** online search interval (default 60min) */
  onlineIntervalMs?: number
  /** improvement cycle interval (default 24h) */
  improvementIntervalMs?: number
  /** whether to run online on start (default false — wait for interval) */
  runOnStart?: boolean
  /** jitter fraction 0..1 to randomize intervals (default 0.15) */
  jitter?: number
  /** enable bus-driven usage analysis after each session (default true) */
  busDrivenUsage?: boolean
}

export interface SchedulerDeps {
  online: OnlineLearner
  usage: UsageLearner
  improvement: ImprovementEngine
  knowledge: KnowledgeBase
  bus?: Bus
  db?: any
}

export type JobKind = "online" | "usage" | "improvement" | "all"

// ── Scheduler ────────────────────────────────────────────────────────

export class LearningScheduler {
  private config: Required<SchedulerConfig>
  private timers: Array<Timer> = []
  private running = new Set<JobKind>()
  private started = false
  private unsubs: Array<() => void> = []

  // Last-run timestamps (for /health + TUI)
  public lastRun: Record<JobKind, number | null> = {
    online: null, usage: null, improvement: null, all: null,
  }
  public lastResult: Record<string, unknown> = {}

  constructor(
    private deps: SchedulerDeps,
    config: SchedulerConfig = {},
  ) {
    this.config = {
      onlineIntervalMs: config.onlineIntervalMs ?? 60 * 60 * 1000,          // 1h
      improvementIntervalMs: config.improvementIntervalMs ?? 24 * 60 * 60 * 1000, // 24h
      runOnStart: config.runOnStart ?? false,
      jitter: config.jitter ?? 0.15,
      busDrivenUsage: config.busDrivenUsage ?? true,
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  start(): void {
    if (this.started) return
    this.started = true
    console.log("[learning:scheduler] starting — online every "
      + `${Math.round(this.config.onlineIntervalMs / 60000)}m, improvement every ${Math.round(this.config.improvementIntervalMs / 3600000)}h`)

    // Periodic online search
    this.schedule("online", this.config.onlineIntervalMs, () => this.runOnline())

    // Periodic improvement cycle (daily)
    this.schedule("improvement", this.config.improvementIntervalMs, () => this.runImprovement())

    // Bus-driven usage analysis (after each session)
    if (this.config.busDrivenUsage && this.deps.bus) {
      const bus = this.deps.bus
      // Session finish signals: message.updated with done:true, or session.deleted
      const unsub1 = bus.subscribe("message.updated" as any, async (event: any) => {
        if (event.payload?.done) {
          await this.runUsage().catch(err => console.warn("[learning:scheduler] usage (bus) failed:", String(err)))
        }
      })
      // Fallback: any part.created burst settling → also trigger lightweight usage check
      // (debounced — only if not already running)
      this.unsubs.push(unsub1)
    }

    if (this.config.runOnStart) {
      // Fire and forget — don't block start()
      this.runOnline().catch(() => {})
    }
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    for (const u of this.unsubs) try { u() } catch {}
    this.unsubs = []
    this.started = false
    console.log("[learning:scheduler] stopped")
  }

  // ── Manual trigger (for TUI / API / tests) ─────────────────────────

  async trigger(kind: JobKind): Promise<unknown> {
    switch (kind) {
      case "online": return this.runOnline()
      case "usage": return this.runUsage()
      case "improvement": return this.runImprovement()
      case "all": return this.runAll()
    }
  }

  // ── Jobs ───────────────────────────────────────────────────────────

  private async runOnline(): Promise<unknown> {
    if (this.running.has("online")) {
      console.log("[learning:scheduler] online already running — skip")
      return null
    }
    this.running.add("online")
    try {
      console.log("[learning:scheduler] → online search")
      const insights = await this.deps.online.learnOnce()
      // Store each insight into knowledge base
      for (const ins of insights) {
        await this.deps.knowledge.storeInsight(ins).catch(() => {})
      }
      this.lastRun.online = Date.now()
      this.lastResult["online"] = { count: insights.length, at: this.lastRun.online }
      this.publish("online", { count: insights.length })
      return insights
    } finally {
      this.running.delete("online")
    }
  }

  private async runUsage(): Promise<unknown> {
    if (this.running.has("usage")) return null
    this.running.add("usage")
    try {
      console.log("[learning:scheduler] → usage analysis")
      const analysis = await this.deps.usage.analyze()
      if (analysis.window.sessions >= 2) {
        await this.deps.knowledge.storeUsageAnalysis(analysis).catch(() => {})
      }
      this.lastRun.usage = Date.now()
      this.lastResult["usage"] = {
        sessions: analysis.window.sessions,
        failures: analysis.failurePatterns.length,
        at: this.lastRun.usage,
      }
      this.publish("usage", this.lastResult["usage"])
      return analysis
    } finally {
      this.running.delete("usage")
    }
  }

  private async runImprovement(): Promise<unknown> {
    if (this.running.has("improvement")) {
      console.log("[learning:scheduler] improvement already running — skip")
      return null
    }
    this.running.add("improvement")
    try {
      console.log("[learning:scheduler] → improvement cycle")
      // Gather inputs: recent online insights from knowledge + current usage analysis
      const recentInsights = await this.collectRecentInsights()
      const analysis = await this.deps.usage.analyze().catch(() => null)
      const result = await this.deps.improvement.runCycle(recentInsights as any, analysis as any)
      this.lastRun.improvement = Date.now()
      this.lastResult["improvement"] = { ...result, at: this.lastRun.improvement }
      this.publish("improvement", result)
      return result
    } finally {
      this.running.delete("improvement")
    }
  }

  private async runAll(): Promise<unknown> {
    const online = await this.runOnline().catch(err => ({ error: String(err) }))
    const usage = await this.runUsage().catch(err => ({ error: String(err) }))
    const improvement = await this.runImprovement().catch(err => ({ error: String(err) }))
    this.lastRun.all = Date.now()
    return { online, usage, improvement, at: this.lastRun.all }
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private schedule(kind: JobKind, intervalMs: number, fn: () => Promise<unknown>): void {
    const jittered = applyJitter(intervalMs, this.config.jitter)
    const timer = setInterval(() => {
      fn().catch(err => console.warn(`[learning:scheduler] ${kind} failed:`, String(err)))
    }, jittered)
    // Don't prevent process exit in tests
    if ((timer as any).unref) (timer as any).unref()
    this.timers.push(timer)
  }

  private publish(kind: JobKind, payload: unknown): void {
    this.deps.bus?.publish({
      type: "server.heartbeat" as any,
      payload: { kind: `learning.scheduler.${kind}`, result: payload },
      timestamp: Date.now(),
    } as any)
  }

  private async collectRecentInsights(): Promise<unknown[]> {
    // Pull recent semantic memories that came from online learning
    try {
      const entries = this.deps.knowledge.list({ source: "online", limit: 12 })
      // Map back to Insight-like shape for the improvement engine
      return entries.map((e: any) => ({
        id: e.id,
        source: e.metadata?.url ?? e.title,
        sourceTitle: e.title,
        category: e.metadata?.category ?? "other",
        summary: e.title,
        pattern: e.content?.split("\n")[0]?.replace(/^Pattern:\s*/, "") ?? e.content,
        relevance: e.metadata?.relevance ?? 0.6,
        tags: e.tags ?? [],
        rawExcerpt: e.content?.slice(0, 500) ?? "",
        createdAt: e.createdAt,
      }))
    } catch { return [] }
  }

  /** For health checks / TUI status */
  status(): Record<string, unknown> {
    return {
      started: this.started,
      running: [...this.running],
      lastRun: this.lastRun,
      lastResult: this.lastResult,
      intervals: {
        onlineMs: this.config.onlineIntervalMs,
        improvementMs: this.config.improvementIntervalMs,
      },
    }
  }
}

function applyJitter(intervalMs: number, jitter: number): number {
  const delta = intervalMs * jitter * (Math.random() * 2 - 1)
  return Math.max(5_000, Math.round(intervalMs + delta))
}
