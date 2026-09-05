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

import type { MemoryEntry } from './knowledge.js'
import type { Insight, InsightCategory } from './online.js'
import { DEFAULT_TOPICS } from './online.js'
import { buildDynamicTopicsFromAnalysis } from './online.js'
import type { Bus } from '../bus/index.js'
import type { OnlineLearner } from './online.js'
import type { UsageLearner } from './usage.js'
import type { ImprovementEngine } from './improvement.js'
import type { KnowledgeBase } from './knowledge.js'
import type { MiraDB } from '../storage/db.js'
import type { JsonValue } from '../types/index.js'
import type { PatchingEngine } from '../patching/index.js'

// ── Types ────────────────────────────────────────────────────────────

export interface SchedulerConfig {
  /** online search interval (default 60min) */
  onlineIntervalMs?: number
  /** improvement cycle interval (default 24h) */
  improvementIntervalMs?: number
  /** patching cycle interval (default 12h, 0 = disabled) */
  patchingIntervalMs?: number
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
  db?: MiraDB
  /** optional 9-pain-point patching engine — wired when available, runs every patchingIntervalMs */
  patching?: PatchingEngine
  /** optional gateway for token-cost/latency signals (feeds patching latency detector) */
  gateway?: { stats: () => { avgLatencyMs: number; requests: number } }
}

export type JobKind = 'online' | 'usage' | 'improvement' | 'patching' | 'all'

// ── Scheduler ────────────────────────────────────────────────────────

export class LearningScheduler {
  private config: Required<SchedulerConfig>
  private timers: Array<Timer> = []
  private running = new Set<JobKind>()
  private started = false
  private unsubs: Array<() => void> = []

  // Last-run timestamps (for /health + TUI)
  public lastRun: Record<JobKind, number | null> = {
    online: null,
    usage: null,
    improvement: null,
    patching: null,
    all: null,
  }
  public lastResult: Record<string, JsonValue> = {}

  constructor(
    private deps: SchedulerDeps,
    config: SchedulerConfig = {},
  ) {
    this.config = {
      onlineIntervalMs: config.onlineIntervalMs ?? 60 * 60 * 1000, // 1h
      improvementIntervalMs: config.improvementIntervalMs ?? 24 * 60 * 60 * 1000, // 24h
      patchingIntervalMs: config.patchingIntervalMs ?? 12 * 60 * 60 * 1000, // 12h, 0 = disabled
      runOnStart: config.runOnStart ?? false,
      jitter: config.jitter ?? 0.15,
      busDrivenUsage: config.busDrivenUsage ?? true,
    } as Required<SchedulerConfig>
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  start(): void {
    if (this.started) return
    this.started = true
    console.log(
      '[learning:scheduler] starting — online every ' +
        `${Math.round(this.config.onlineIntervalMs / 60000)}m, improvement every ${Math.round(this.config.improvementIntervalMs / 3600000)}h`,
    )

    // Periodic online search
    this.schedule('online', this.config.onlineIntervalMs, () => this.runOnline())

    // Periodic improvement cycle (daily) — consumes online + usage
    this.schedule('improvement', this.config.improvementIntervalMs, () => this.runImprovement())

    // Periodic patching cycle (9 pain points) — only if engine wired
    if (this.deps.patching && this.config.patchingIntervalMs > 0) {
      this.schedule('patching', this.config.patchingIntervalMs, () => this.runPatching())
    }

    // Bus-driven usage analysis (after each session)
    if (this.config.busDrivenUsage && this.deps.bus) {
      const bus = this.deps.bus
      // Session finish signals: message.updated with done:true, or session.deleted
      const unsub1 = bus.subscribe('message.updated', async (event) => {
        const payload = event.payload as { done?: boolean } | undefined
        if (payload?.done) {
          await this.runUsage().catch((err) =>
            console.warn('[learning:scheduler] usage (bus) failed:', String(err)),
          )
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
    for (const u of this.unsubs)
      try {
        u()
      } catch {}
    this.unsubs = []
    this.started = false
    console.log('[learning:scheduler] stopped')
  }

  // ── Manual trigger (for TUI / API / tests) ─────────────────────────

  async trigger(kind: JobKind): Promise<JsonValue> {
    switch (kind) {
      case 'online':
        return this.runOnline()
      case 'usage':
        return this.runUsage()
      case 'improvement':
        return this.runImprovement()
      case 'patching':
        return this.runPatching()
      case 'all':
        return this.runAll()
    }
  }

  // ── Jobs ───────────────────────────────────────────────────────────

  private async runOnline(): Promise<JsonValue> {
    if (this.running.has('online')) {
      console.log('[learning:scheduler] online already running — skip')
      return null as JsonValue
    }
    this.running.add('online')
    try {
      console.log('[learning:scheduler] → online search')
      // Dynamic topics: default rotation + failure-driven queries the learner needs now
      const topics = await this.buildDynamicTopics()
      const insights = await this.deps.online.learnOnce(topics)
      // Store each insight into knowledge base
      for (const ins of insights) {
        await this.deps.knowledge.storeInsight(ins).catch(() => {})
      }
      this.lastRun.online = Date.now()
      this.lastResult['online'] = toJsonValue({ count: insights.length, at: this.lastRun.online })
      this.publish('online', toJsonValue({ count: insights.length }))

      // Phase-4 follow-through: fresh insights should feed Mira's self-improvement
      // (gap/patch synthesis) — but throttled so hourly online doesn't spam the LLM.
      if (insights.length > 0 && this.shouldRunImprovementAfterOnline()) {
        try {
          await this.runImprovement()
          await this.promoteSkillsToFile()
          await this.writeKnowledgeChangelog()
        } catch (e) {
          console.warn('[learning:scheduler] post-online improvement failed:', String(e))
        }
      }
      return toJsonValue(insights)
    } finally {
      this.running.delete('online')
    }
  }

  /** Merge DEFAULT_TOPICS with queries derived from recent failure patterns —
   *  the learner now asks for help on its own observed errors (Psand q— backwards directions). */
  private async buildDynamicTopics() {
    const base = [...DEFAULT_TOPICS]
    try {
      const analysis = await this.deps.usage.analyze()
      const driven = buildDynamicTopicsFromAnalysis(analysis)
      return [...driven, ...base]
    } catch {
      return base
    }
  }

  /** Improvement throttle — don't burn the LLM on every hour of online learning. */
  private lastImprovementAt = 0
  private shouldRunImprovementAfterOnline(): boolean {
    const now = Date.now()
    const minGapMs = 4 * 60 * 60 * 1000 // at most every 4h from online triggers
    if (now - this.lastImprovementAt < minGapMs) return false
    this.lastImprovementAt = now
    return true
  }

  /** Promote high-utility knowledge entries to .mira/skills/<slug>.md (loaded by the skills loader). */
  private async promoteSkillsToFile(): Promise<void> {
    const threshold = Number(process.env.MIRA_SKILL_PROMOTE_UTILITY ?? '8')
    const all = this.deps.knowledge.list({ source: 'online', limit: 100 })
    if (!all.length) return
    const promoted: string[] = []
    const skillsDir = `${process.cwd()}/.mira/skills`
    try {
      const { mkdir, writeFile } = await import('node:fs/promises')
      await mkdir(skillsDir, { recursive: true })
      for (const e of all) {
        const utility = (e.metadata.utility as number) ?? 0
        if (utility < threshold) continue
        const slug = e.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .slice(0, 40)
          .replace(/-+$/, '')
        const file = `${skillsDir}/learned-${slug}.md`
        const body = [
          `---`,
          `name: learned-${slug}`,
          `description: ${e.title.slice(0, 120)}`,
          `triggers:`,
          `  - ${slug}`,
          `---`,
          ``,
          `<!-- Auto-promoted by Mira learning (utility ${utility}). Delete or edit to override. -->`,
          ``,
          `# ${e.title}`,
          ``,
          e.content,
          ``,
          `Source: ${e.metadata.url ?? 'internal'}`,
        ].join('\n')
        await writeFile(file, body, 'utf-8')
        promoted.push(slug)
      }
    } catch (e) {
      console.warn('[learning:scheduler] skill promotion failed:', String(e))
    }
    if (promoted.length > 0) {
      this.deps.bus?.publish({
        type: 'learning.updated',
        payload: {
          kind: 'learning.skills.promoted',
          count: promoted.length,
          slugs: promoted.slice(0, 5),
        } as JsonValue,
        timestamp: Date.now(),
      })
    }
  }

  /** Persist a human-reviewable changelog for the current top-of-the-rank learnings. */
  private async writeKnowledgeChangelog(): Promise<void> {
    try {
      const { mkdir, writeFile } = await import('node:fs/promises')
      const top = this.deps.knowledge
        .list({ source: 'online', limit: 40 })
        .sort(
          (a, b) => ((b.metadata.utility as number) ?? 0) - ((a.metadata.utility as number) ?? 0),
        )
      const dir = `${process.cwd()}/.mira`
      await mkdir(dir, { recursive: true })
      const lines = [
        `# Mira Knowledge Changelog`,
        ``,
        `_Generated ${new Date().toISOString()} — top ${top.length} learnings ranked by utility._`,
        ``,
        ...top.map((e) => {
          const u = (e.metadata.utility as number) ?? 0
          const cat = (e.metadata.category as string) ?? 'other'
          return `- **(${u >= 0 ? '+' : ''}${u})** [${cat}] ${e.title}`
        }),
      ]
      await writeFile(`${dir}/KNOWLEDGE.md`, lines.join('\n'), 'utf-8')
    } catch {}
  }

  private async runUsage(): Promise<JsonValue> {
    if (this.running.has('usage')) return null as JsonValue
    this.running.add('usage')
    try {
      console.log('[learning:scheduler] → usage analysis')
      const analysis = await this.deps.usage.analyze()
      if (analysis.window.sessions >= 2) {
        await this.deps.knowledge.storeUsageAnalysis(analysis).catch(() => {})
      }
      this.lastRun.usage = Date.now()
      this.lastResult['usage'] = {
        sessions: analysis.window.sessions,
        failures: analysis.failurePatterns.length,
        at: this.lastRun.usage,
      } as JsonValue
      this.publish('usage', this.lastResult['usage'])
      return toJsonValue(analysis)
    } finally {
      this.running.delete('usage')
    }
  }

  private async runImprovement(): Promise<JsonValue> {
    if (this.running.has('improvement')) {
      console.log('[learning:scheduler] improvement already running — skip')
      return null as JsonValue
    }
    this.running.add('improvement')
    try {
      console.log('[learning:scheduler] → improvement cycle')
      // Gather inputs: recent online insights from knowledge + current usage analysis
      const recentInsights = await this.collectRecentInsights()
      const analysis = await this.deps.usage.analyze().catch(() => null)
      const result = await this.deps.improvement.runCycle(recentInsights, analysis)
      this.lastRun.improvement = Date.now()
      this.lastResult['improvement'] = toJsonValue({ ...result, at: this.lastRun.improvement })
      this.publish('improvement', toJsonValue(result))
      // Also trigger patching when improvement succeeds and engine is wired (9 pain points)
      if (this.deps.patching) {
        try {
          await this.runPatching()
        } catch (e) {
          console.warn('[learning:scheduler] patching after improvement failed:', String(e))
        }
      }
      return toJsonValue(result)
    } finally {
      this.running.delete('improvement')
    }
  }

  private async runPatching(): Promise<JsonValue> {
    if (!this.deps.patching) return null as JsonValue
    if (this.running.has('patching')) {
      console.log('[learning:scheduler] patching already running — skip')
      return null as JsonValue
    }
    this.running.add('patching')
    try {
      console.log('[learning:scheduler] → patching cycle (9 pain points)')
      // Feed current signals: usage + latency + eval (if gate enabled)
      const analysis = await this.deps.usage.analyze().catch(() => null)
      const latencySamples = this.deps.gateway
        ? [{ durationMs: this.deps.gateway.stats().avgLatencyMs }]
        : undefined
      // Eval gate: only run pr tier if MIRA_EVAL_GATE=1 (expensive)
      let evalReport: null | Awaited<ReturnType<typeof import('../eval/index.js').runEval>> = null
      if (process.env.MIRA_EVAL_GATE === '1') {
        try {
          const { runEval } = await import('../eval/index.js')
          evalReport = await runEval('pr')
        } catch {}
      }
      const result = await this.deps.patching.runCycle({
        analysis,
        evalReport,
        latencySamples,
      })
      this.lastRun.patching = Date.now()
      this.lastResult['patching'] = toJsonValue({ ...result, at: this.lastRun.patching })
      this.publish('patching', toJsonValue(result))
      return toJsonValue(result)
    } finally {
      this.running.delete('patching')
    }
  }

  private async runAll(): Promise<JsonValue> {
    const online = await this.runOnline().catch((err) => ({ error: String(err) }))
    const usage = await this.runUsage().catch((err) => ({ error: String(err) }))
    const improvement = await this.runImprovement().catch((err) => ({ error: String(err) }))
    const patching = this.deps.patching
      ? await this.runPatching().catch((err) => ({ error: String(err) }))
      : null
    this.lastRun.all = Date.now()
    return toJsonValue({ online, usage, improvement, patching, at: this.lastRun.all })
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private schedule(kind: JobKind, intervalMs: number, fn: () => Promise<JsonValue>): void {
    const jittered = applyJitter(intervalMs, this.config.jitter)
    const timer = setInterval(() => {
      fn().catch((err) => console.warn(`[learning:scheduler] ${kind} failed:`, String(err)))
    }, jittered)
    // Don't prevent process exit in tests
    timer.unref?.()
    this.timers.push(timer)
  }

  private publish(kind: JobKind, payload: JsonValue): void {
    this.deps.bus?.publish({
      type: 'learning.updated',
      payload: { kind: `learning.scheduler.${kind}`, result: payload },
      timestamp: Date.now(),
    })
  }

  private async collectRecentInsights(): Promise<Insight[]> {
    // Pull recent semantic memories that came from online learning — preserve full pattern
    try {
      const entries = this.deps.knowledge.list({ source: 'online', limit: 12 })
      // Map back to Insight-like shape for the improvement engine
      return entries.map((e: MemoryEntry) => {
        const meta = e.metadata as Record<string, JsonValue>
        return {
          id: e.id,
          source: (meta.url as string | undefined) ?? e.title,
          sourceTitle: e.title,
          category: ((meta.category as string | undefined) ?? 'other') as InsightCategory,
          summary: e.title,
          pattern: e.content ?? '',
          relevance: typeof meta.relevance === 'number' ? (meta.relevance as number) : 0.6,
          tags: e.tags ?? [],
          rawExcerpt: e.content?.slice(0, 800) ?? '',
          createdAt: e.createdAt,
        }
      })
    } catch {
      return []
    }
  }

  /** For health checks / TUI status */
  status(): Record<string, JsonValue> {
    return {
      started: this.started as JsonValue,
      running: [...this.running] as JsonValue,
      lastRun: toJsonValue(this.lastRun),
      lastResult: toJsonValue(this.lastResult),
      intervals: {
        onlineMs: this.config.onlineIntervalMs,
        improvementMs: this.config.improvementIntervalMs,
        patchingMs: this.config.patchingIntervalMs,
      } as JsonValue,
    } as Record<string, JsonValue>
  }
}

function toJsonValue(value: object): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function applyJitter(intervalMs: number, jitter: number): number {
  const delta = intervalMs * jitter * (Math.random() * 2 - 1)
  return Math.max(5_000, Math.round(intervalMs + delta))
}
