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

export * from './online.js'
export * from './usage.js'
export * from './knowledge.js'
export * from './improvement.js'
export * from './scheduler.js'

import { OnlineLearner } from './online.js'
import { UsageLearner } from './usage.js'
import { KnowledgeBase, type MemoryTier, type MemorySource } from './knowledge.js'
import { ImprovementEngine } from './improvement.js'
import { LearningScheduler } from './scheduler.js'
import { createPatchingSystem, type PatchingEngine } from '../patching/index.js'
import type { Bus } from '../bus/index.js'
import type { MiraDB } from '../storage/db.js'
import type { Gateway } from '../gateway/index.js'
import { Hono } from 'hono'

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
  gateway?: Gateway
  db?: MiraDB
  bus?: Bus
}

/**
 * Create the full Mira learning system with shared deps.
 * Each module receives the same db/bus/gateway so they stay coordinated.
 */
export function createLearningSystem(deps: LearningSystemDeps = {}): LearningSystem {
  const knowledge = new KnowledgeBase({ bus: deps.bus, db: deps.db })

  const online = new OnlineLearner({ bus: deps.bus, db: deps.db, gateway: deps.gateway })

  const usage = new UsageLearner({ bus: deps.bus, db: deps.db })

  const improvement = new ImprovementEngine(
    { bus: deps.bus, db: deps.db, knowledge, gateway: deps.gateway },
    { rootDir: deps.rootDir ?? process.cwd() },
  )

  const patching = createPatchingSystem(
    { bus: deps.bus, db: deps.db, knowledge, gateway: deps.gateway },
    { rootDir: deps.rootDir ?? process.cwd(), autoPatch: true },
  )

  const scheduler = new LearningScheduler({
    online,
    usage,
    improvement,
    knowledge,
    bus: deps.bus,
    db: deps.db,
    patching,
    gateway: deps.gateway,
  })

  return {
    online,
    usage,
    knowledge,
    improvement,
    patching,
    scheduler,
    gateway: deps.gateway,
    db: deps.db,
    bus: deps.bus,
  }
}

/** Convenience: wire learning REST routes onto a Hono app */
export function mountLearningRoutes(
  app: Hono<{ Variables: { requestId: string } }>,
  system: LearningSystem,
): void {
  app.get('/learning/status', (c) =>
    c.json({
      scheduler: system.scheduler.status(),
      knowledge: { size: system.knowledge.size(), tiers: ['episodic', 'semantic', 'procedural'] },
      usage: system.usage.getStats(),
    }),
  )

  app.post('/learning/trigger', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const kind = body.kind ?? 'all'
    const result = await system.scheduler.trigger(kind)
    return c.json({ kind, result })
  })

  app.get('/learning/insights', async (c) => {
    const url = new URL(c.req.url)
    const tier = url.searchParams.get('tier') as MemoryTier | null
    const source = url.searchParams.get('source') as MemorySource | null
    const q = url.searchParams.get('q')
    if (q) {
      const results = await system.knowledge.retrieve({
        query: q,
        tier: tier ?? undefined,
        limit: 20,
      })
      return c.json(results)
    }
    return c.json(
      system.knowledge.list({ tier: tier ?? undefined, source: source ?? undefined, limit: 50 }),
    )
  })

  // H2-1 Memory v2: graph + temporal — read-only, for web MemoryGraph canvas
  app.get('/knowledge/graph', async (c) => {
    const url = new URL(c.req.url)
    const limit = Math.min(Number(url.searchParams.get('limit') ?? '100') || 100, 500)
    const graph = await system.knowledge.getGraph(limit)
    return c.json(graph)
  })

  // Alias for web convenience (same payload)
  app.get('/learning/graph', async (c) => {
    const url = new URL(c.req.url)
    const limit = Math.min(Number(url.searchParams.get('limit') ?? '100') || 100, 500)
    const graph = await system.knowledge.getGraph(limit)
    return c.json(graph)
  })

  // H3-E: POST /knowledge/:id/touch — bump lastAccessedAt + accessCount
  app.post('/knowledge/:id/touch', async (c) => {
    const id = c.req.param('id')
    const entry = system.knowledge.get(id)
    if (!entry) return c.json({ error: 'not found' }, 404)
    system.bus?.publish({
      type: 'job.updated',
      payload: { action: 'touched', id },
      timestamp: Date.now(),
    })
    return c.json({
      id: entry.id,
      accessCount: entry.accessCount,
      lastAccessedAt: entry.lastAccessedAt,
    })
  })

  // H3-E: POST /knowledge — seed a user entry
  app.post('/knowledge', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    const content = typeof body.content === 'string' ? body.content.trim() : ''
    const tier = body.tier ?? 'semantic'
    const tags = Array.isArray(body.tags) ? body.tags : []
    const sessionID = body.sessionID ?? null
    if (!title || title.length > 200) return c.json({ error: 'title required (1-200 chars)' }, 400)
    if (!content || content.length > 4000)
      return c.json({ error: 'content required (1-4000 chars)' }, 400)
    if (!['episodic', 'semantic', 'procedural'].includes(tier))
      return c.json({ error: 'invalid tier' }, 400)
    const entry = await system.knowledge.store({
      tier,
      source: 'user',
      title,
      content,
      tags,
      metadata: { seededFrom: 'graph', sessionID },
    })
    system.bus?.publish({
      type: 'job.updated',
      payload: { action: 'seeded', id: entry.id },
      timestamp: Date.now(),
    })
    return c.json(entry, 201)
  })

  // H3-E: DELETE /knowledge/:id — remove a knowledge entry
  app.delete('/knowledge/:id', async (c) => {
    const id = c.req.param('id')
    const entry = system.knowledge.get(id)
    if (!entry) return c.json({ error: 'not found' }, 404)
    // Remove from in-memory index (DB persistence will fade on restart)
    system.knowledge['entries'].delete(id)
    system.bus?.publish({
      type: 'job.updated',
      payload: { action: 'deleted', id },
      timestamp: Date.now(),
    })
    return c.json({ ok: true, id })
  })

  // H3-E: POST /finding/:id/promote — promote unresolved finding → knowledge
  app.post('/finding/:id/promote', async (c) => {
    const id = c.req.param('id')
    const sqlite = system.db?.sqlite
    if (!sqlite) return c.json({ error: 'db required' }, 500)
    try {
      const row = sqlite
        .prepare('SELECT id, title, severity, status, source, evidence FROM findings WHERE id = ?')
        .get(id) as Record<string, unknown> | undefined
      if (!row) return c.json({ error: 'not found' }, 404)
      if (row.status === 'resolved') return c.json({ error: 'already resolved' }, 409)
      sqlite
        .prepare('UPDATE findings SET status = ?, updated_at = ? WHERE id = ?')
        .run('resolved', Date.now(), id)
      const entry = await system.knowledge.store({
        tier: 'procedural',
        source: 'improvement',
        title: `Resolved: ${String(row.title)}`,
        content: `Finding ${String(row.severity)}: ${String(row.evidence ?? 'no evidence')}. Source: ${String(row.source)}. Resolved to knowledge.`,
        tags: [String(row.severity), String(row.source), 'resolved'],
        metadata: { findingId: id, severity: String(row.severity), source: String(row.source) },
      })
      system.bus?.publish({
        type: 'job.updated',
        payload: { action: 'promoted', findingId: id, entryId: entry.id },
        timestamp: Date.now(),
      })
      return c.json({ finding: { id, status: 'resolved' }, entry }, 201)
    } catch (err) {
      console.error('[learning] promote error:', err)
      return c.json({ error: String(err) }, 500)
    }
  })

  // H2-2 Mira Score GA — per-session {score,cost,doomLoops,toolErrors,memoryHits} + trace
  // GET /learning/score?sessionID=xxx[&format=badge|markdown|svg]
  // - JSON (default): enhanced score payload with traceId, spanId, durationMs, model, toolCalls, etc.
  // - format=badge|svg: SVG badge for PR comments / README
  // - format=markdown: markdown snippet for PR comments
  app.get('/learning/score', async (c) => {
    const url = new URL(c.req.url)
    const sessionID = url.searchParams.get('sessionID') ?? url.searchParams.get('sessionId') ?? ''
    const format = url.searchParams.get('format') ?? ''
    const requestId = c.get('requestId') ?? ''

    // Resolve cost from gateway (per-process cumulative)
    let costUSD = 0
    try {
      const stats = system.gateway?.stats?.()
      if (stats) costUSD = stats.costUSD
    } catch {}

    // Memory hits: count knowledge entries (or per-session if we had tracking)
    let memoryHits = 0
    try {
      memoryHits = system.knowledge.size()
    } catch {}
    // If sessionID provided, try to count session-specific knowledge (best-effort)
    if (sessionID) {
      try {
        const list = system.knowledge.list({ limit: 100 })
        // Heuristic: entries whose metadata.sessionID matches
        const perSession = list.filter(
          (e) => (e.metadata as Record<string, unknown>)?.sessionID === sessionID,
        )
        if (perSession.length) memoryHits = perSession.length
      } catch {}
    }

    // If no sessionID: return aggregate / latest session score
    if (!sessionID) {
      const all = system.usage.getAllSessionMetrics()
      if (!all.length) {
        const payload = {
          score: 100,
          cost: costUSD,
          costUSD,
          doomLoops: 0,
          toolErrors: 0,
          memoryHits,
          traceId: `trace_none_${Date.now().toString(36)}`,
          spanId: `span_none`,
          requestId,
          durationMs: 0,
          model: 'unknown',
          toolCalls: 0,
          steps: 0,
          totalTokensIn: 0,
          totalTokensOut: 0,
          success: true,
          message: 'no sessions yet — default score',
        }
        if (format === 'badge' || format === 'svg') {
          const svg = badgeSvg(payload.score, 'Mira Score')
          return new Response(svg, {
            headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' },
          })
        }
        if (format === 'markdown' || format === 'md') {
          return c.text(badgeMarkdown(payload), 200, {
            'Content-Type': 'text/markdown; charset=utf-8',
          })
        }
        return c.json(payload)
      }
      const latest = all[all.length - 1]!
      const payload = system.usage.getScorePayload(latest.sessionID, {
        memoryHits,
        costUSD,
        requestId,
      }) ?? {
        sessionID: latest.sessionID,
        score: system.usage.computeScore(latest, memoryHits),
        cost: costUSD,
        costUSD,
        doomLoops: latest.doomLoops,
        toolErrors: latest.toolErrors,
        memoryHits,
        traceId: `trace_${latest.sessionID.slice(0, 8)}_${latest.createdAt.toString(36)}`,
        spanId: `span_${latest.sessionID.slice(0, 8)}`,
        requestId,
        durationMs: latest.latencyMs,
        latencyMs: latest.latencyMs,
        model: latest.model,
        toolCalls: latest.toolCalls,
        steps: latest.steps,
        totalTokensIn: latest.totalTokensIn,
        totalTokensOut: latest.totalTokensOut,
        success: latest.success,
        compactionCount: latest.compactionCount,
        userFeedback: latest.userFeedback ?? null,
        createdAt: latest.createdAt,
        toolMetrics: [],
      }
      // Also try to enrich cost from gateway per-model if available
      if (format === 'badge' || format === 'svg') {
        const svg = badgeSvg(payload.score, 'Mira Score')
        return new Response(svg, {
          headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' },
        })
      }
      if (format === 'markdown' || format === 'md') {
        return c.text(badgeMarkdown(payload), 200, {
          'Content-Type': 'text/markdown; charset=utf-8',
        })
      }
      return c.json({ ...payload, requestId })
    }

    // Per-session
    const payload = system.usage.getScorePayload(sessionID, { memoryHits, costUSD, requestId })
    if (!payload) {
      // No usage yet for this session — return skeleton with DB fallback
      const sessionMetric = system.usage.getSessionMetric(sessionID)
      const fallback = {
        sessionID,
        score: 100,
        cost: costUSD,
        costUSD,
        doomLoops: sessionMetric?.doomLoops ?? 0,
        toolErrors: sessionMetric?.toolErrors ?? 0,
        memoryHits,
        traceId: `trace_${sessionID.slice(0, 8)}_${Date.now().toString(36)}`,
        spanId: `span_${sessionID.slice(0, 8)}`,
        requestId,
        durationMs: sessionMetric?.latencyMs ?? 0,
        latencyMs: sessionMetric?.latencyMs ?? 0,
        model: sessionMetric?.model ?? 'unknown',
        toolCalls: sessionMetric?.toolCalls ?? 0,
        steps: sessionMetric?.steps ?? 0,
        totalTokensIn: sessionMetric?.totalTokensIn ?? 0,
        totalTokensOut: sessionMetric?.totalTokensOut ?? 0,
        success: sessionMetric?.success ?? true,
        compactionCount: sessionMetric?.compactionCount ?? 0,
        userFeedback: sessionMetric?.userFeedback ?? null,
        createdAt: sessionMetric?.createdAt ?? Date.now(),
        toolMetrics: [],
      }
      if (format === 'badge' || format === 'svg') {
        const svg = badgeSvg(fallback.score, 'Mira Score')
        return new Response(svg, {
          headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' },
        })
      }
      if (format === 'markdown' || format === 'md') {
        return c.text(badgeMarkdown(fallback), 200, {
          'Content-Type': 'text/markdown; charset=utf-8',
        })
      }
      return c.json(fallback)
    }

    if (format === 'badge' || format === 'svg') {
      const svg = badgeSvg(payload.score, 'Mira Score')
      return new Response(svg, {
        headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' },
      })
    }
    if (format === 'markdown' || format === 'md') {
      return c.text(badgeMarkdown(payload), 200, { 'Content-Type': 'text/markdown; charset=utf-8' })
    }
    return c.json(payload)
  })

  // GET /learning/trace?sessionID=xxx — OTel spans + tool metrics + X-Request-Id
  app.get('/learning/trace', async (c) => {
    const url = new URL(c.req.url)
    const sessionID = url.searchParams.get('sessionID') ?? url.searchParams.get('sessionId') ?? ''
    const requestId = c.get('requestId') ?? ''
    if (!sessionID) return c.json({ error: 'sessionID required' }, 400)

    const metric = system.usage.getSessionMetric(sessionID)
    const tools = system.usage.getToolMetrics(sessionID)

    // Try to pull OTel traces that mention this session (best-effort)
    let otelSpans: Array<{
      name: string
      traceId: string
      spanId: string
      startMs: number
      endMs?: number
      durationMs?: number
      status: string
      attributes: Record<string, unknown>
    }> = []
    try {
      const { listTraces } = await import('../eval/tracing.js')
      const traces = listTraces()
      for (const t of traces) {
        for (const s of t.spans) {
          const attrs = s.attributes as Record<string, unknown>
          if (
            String(attrs.session_id ?? attrs.sessionID ?? '') === sessionID ||
            t.name.includes(sessionID.slice(0, 8))
          ) {
            otelSpans.push({
              name: s.name,
              traceId: s.traceId,
              spanId: s.spanId,
              startMs: s.startMs,
              endMs: s.endMs,
              durationMs: s.endMs ? s.endMs - s.startMs : undefined,
              status: s.status,
              attributes: s.attributes as Record<string, unknown>,
            })
          }
        }
      }
    } catch {}

    // Fallback: synthesize spans from tool metrics if no OTel spans found
    if (!otelSpans.length && tools.length) {
      otelSpans = tools.map((t, i) => ({
        name: `tool:${t.tool}`,
        traceId: `trace_${sessionID.slice(0, 8)}_${metric?.createdAt?.toString(36) ?? Date.now().toString(36)}`,
        spanId: `span_${sessionID.slice(0, 8)}_${i}`,
        startMs: t.timestamp,
        endMs: t.timestamp + t.durationMs,
        durationMs: t.durationMs,
        status: t.isError ? 'error' : 'ok',
        attributes: { tool: t.tool, isError: t.isError, errorKind: t.errorKind ?? null },
      }))
    }

    return c.json({
      sessionID,
      requestId,
      traceId: metric
        ? `trace_${sessionID.slice(0, 8)}_${metric.createdAt.toString(36)}`
        : `trace_${sessionID.slice(0, 8)}`,
      spanId: `span_${sessionID.slice(0, 8)}`,
      durationMs: metric?.latencyMs ?? 0,
      model: metric?.model ?? 'unknown',
      toolCalls: metric?.toolCalls ?? tools.length,
      toolErrors: metric?.toolErrors ?? tools.filter((t) => t.isError).length,
      doomLoops: metric?.doomLoops ?? 0,
      spans: otelSpans,
      toolMetrics: tools.slice(-50),
      metric: metric ?? null,
    })
  })
}

function badgeColor(score: number): string {
  if (score >= 80) return '#2ea043' // green
  if (score >= 60) return '#d29922' // yellow
  if (score >= 40) return '#f85149' // orange-red
  return '#da3633' // red
}

function badgeSvg(score: number, label = 'Mira Score'): string {
  const color = badgeColor(score)
  const text = `${score}/100`
  // Simple flat badge SVG (shields.io style, no external deps)
  const labelW = 78
  const scoreW = 52
  const totalW = labelW + scoreW
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="20" role="img" aria-label="${label}: ${text}">
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="r"><rect width="${totalW}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelW}" height="20" fill="#555"/>
    <rect x="${labelW}" width="${scoreW}" height="20" fill="${color}"/>
    <rect width="${totalW}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelW / 2}" y="15" fill="#fff">${label}</text>
    <text x="${labelW + scoreW / 2}" y="15" fill="#fff">${text}</text>
  </g>
</svg>`
}

function badgeMarkdown(p: {
  score: number
  costUSD?: number
  toolCalls?: number
  doomLoops?: number
  toolErrors?: number
  sessionID?: string
}): string {
  const color =
    p.score >= 80 ? 'brightgreen' : p.score >= 60 ? 'yellow' : p.score >= 40 ? 'orange' : 'red'
  const badgeUrl = `https://img.shields.io/badge/Mira%20Score-${p.score}%2F100-${color}`
  const lines = [
    `![Mira Score](${badgeUrl})`,
    ``,
    `**Mira Score: ${p.score}/100**`,
    p.sessionID ? `Session: \`${p.sessionID.slice(0, 8)}\`` : ``,
    p.costUSD !== undefined ? `Cost: $${Number(p.costUSD).toFixed(4)}` : ``,
    p.toolCalls !== undefined ? `Tool calls: ${p.toolCalls} (errors: ${p.toolErrors ?? 0})` : ``,
    p.doomLoops !== undefined ? `Doom loops: ${p.doomLoops}` : ``,
  ].filter(Boolean)
  return lines.join('  \n')
}
