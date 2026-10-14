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
import { createGovernanceGate } from '../patching/governance/index.js'
import {
  TrackerMeasurementSource,
  type MeasurementSource,
} from '../patching/governance/measurement.js'
import { VariantWorkspace } from '../patching/governance/variant.js'
import { getVariantRouter } from '../patching/governance/traffic.js'
import { CanaryRunner } from '../patching/governance/canary.js'
import type { LatencyTracker } from '../patching/latency.js'
import { RollbackManager } from '../evolution/rollback.js'
import { ResourceLimits } from '../evolution/resources.js'
import { ImprovementLedger } from '../evolution/ledger.js'
import { authorizePromotion } from '../evolution/approval.js'
import { createAgentMetrics } from '../agents/metrics.js'
import { createMemoryQualityTracker } from './quality.js'
import {
  createWorkspaceIntelligence,
  setSharedWorkspace,
  type WorkspaceItem,
  type WorkspaceItemKind,
} from '../workspace/intelligence.js'
import {
  createGoalStore,
  setSharedGoals,
  type GoalStore,
  type GoalStatus,
  type GoalPriority,
} from '../strategic/goals.js'
import { appendDecision, getWorkflowTrace } from './ledger.js'
import { diagnose } from '../evolution/diagnosis.js'
import { writeFinding } from '../tools/findings.js'
import { createPolicyEngine } from '../policy/engine.js'
import { mountEvolutionProposalRoutes } from '../routes/evolution.js'
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
  /**
   * Late-bound accessor for the canary attribution LatencyTracker. When it
   * yields a tracker, the governance benchmark stage measures REAL routed
   * traffic (TrackerMeasurementSource); when it yields undefined (tracker not
   * constructed yet / no attribution), measure() returns null and the stage
   * BLOCKS — fail-closed unchanged.
   */
  measurementTracker?: () => LatencyTracker | undefined
}

export interface LearningSystem {
  online: OnlineLearner
  usage: UsageLearner
  knowledge: KnowledgeBase
  improvement: ImprovementEngine
  patching: PatchingEngine
  scheduler: LearningScheduler
  governance: ReturnType<typeof createGovernanceGate>
  agentMetrics: ReturnType<typeof createAgentMetrics>
  memoryQuality: ReturnType<typeof createMemoryQualityTracker>
  workspace: ReturnType<typeof createWorkspaceIntelligence>
  goals: GoalStore
  policyEngine: ReturnType<typeof createPolicyEngine>
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

  const agentMetrics = createAgentMetrics({ db: deps.db })
  const memoryQuality = createMemoryQualityTracker({ db: deps.db })
  const workspace = createWorkspaceIntelligence({ db: deps.db })
  setSharedWorkspace(workspace)
  const goals = createGoalStore({ db: deps.db })
  setSharedGoals(goals)
  const policyEngine = createPolicyEngine({ db: deps.db, bus: deps.bus })

  // Create shared dependencies for governance pipeline
  const variantWorkspace = new VariantWorkspace({ rootDir: deps.rootDir ?? process.cwd() })
  const variantRouter = getVariantRouter()
  const latencyTracker = deps.measurementTracker?.()

  const governance = createGovernanceGate({
    db: deps.db,
    bus: deps.bus,
    rootDir: deps.rootDir ?? process.cwd(),
    // Promotion applies a real change, so it requires an authoritative human
    // approval bound to the exact diff. Content-addressed: the artifact is
    // hashed here and matched against approvals recorded by the ApprovalGate.
    approvalCheck: (proposal) =>
      authorizePromotion({ targetFile: proposal.targetFile, change: proposal.change }),
    // Wire CanaryRunner with workspace, router, and candidate execution enabled
    canary: latencyTracker
      ? new CanaryRunner(latencyTracker, {
          workspace: variantWorkspace,
          router: variantRouter,
          executesCandidate: true,
        })
      : undefined,
    // Wire measurement source with the latency tracker for benchmark evidence
    measurements: latencyTracker
      ? ({
          measure: async (proposal: Parameters<MeasurementSource['measure']>[0]) => {
            const tracker = latencyTracker
            if (!tracker) return null
            return new TrackerMeasurementSource({ tracker }).measure(proposal)
          },
        } satisfies MeasurementSource)
      : undefined,
    onStagePass: (proposalId, stage) => {
      // Stamp related memories with elevated provenance when a stage passes
      const provenanceLevel = stage === 'benchmark' ? 'benchmark-verified' : 'ci-verified'
      const related = knowledge
        .list({ limit: 200 })
        .filter((e) => e.metadata.proposalId === proposalId || e.title.includes(proposalId))
      for (const mem of related.slice(0, 5)) {
        void knowledge.stampProvenance(mem.id, provenanceLevel).catch(() => {})
      }
      // Mirror stage pass into workspace intelligence as a decision item
      try {
        workspace.upsert({
          kind: 'decision',
          title: `Governance: ${proposalId}`,
          description: `Stage ${stage} passed`,
          status: 'in-progress',
          priority: 'medium',
          metadata: { proposalId, stage },
        })
      } catch {
        // best-effort — never break governance on workspace write failure
      }
    },
  })

  // Mirror governance terminal transitions (promote/reject/rollback) into workspace items
  // and the decision log (why / evidence / alternatives).
  deps.bus?.subscribe('learning.updated', (e) => {
    const p = e.payload as {
      kind?: string
      proposalId?: string
      from?: string
      to?: string
      stage?: string
      reason?: string
    }
    if (p?.kind !== 'governance.transition' || !p.proposalId || !p.to) return
    try {
      const status: 'open' | 'in-progress' | 'resolved' | 'wontfix' =
        p.to === 'PROMOTED'
          ? 'resolved'
          : p.to === 'REJECTED' || p.to === 'ROLLED_BACK'
            ? 'wontfix'
            : 'in-progress'
      workspace.upsert({
        kind: 'decision',
        title: `Governance: ${p.proposalId}`,
        description: `${p.from ?? '?'} → ${p.to}${p.stage ? ` via ${p.stage}` : ''}${p.reason ? ` — ${p.reason}` : ''}`,
        status,
        priority: 'medium',
        metadata: { proposalId: p.proposalId, from: p.from ?? '', to: p.to, stage: p.stage ?? '' },
      })
      // Decision log for terminal states — records why, evidence, and alternatives
      if (p.to === 'PROMOTED' || p.to === 'REJECTED' || p.to === 'ROLLED_BACK') {
        appendDecision(
          {
            decision: `governance:${p.to.toLowerCase()}`,
            context: `Proposal ${p.proposalId} transitioned ${p.from ?? '?'} → ${p.to}${p.stage ? ` via ${p.stage}` : ''}${p.reason ? ` — ${p.reason}` : ''}`,
            by: 'governance',
            evidence: p.reason
              ? [`stage=${p.stage ?? 'n/a'}`, `reason=${p.reason}`]
              : [`stage=${p.stage ?? 'n/a'}`],
            alternatives: [`remain in ${p.from ?? 'prior state'}`],
          },
          deps.rootDir,
        )
      }
      // P1.4 — auto root-cause analysis on governance failures.
      // A failed stage or regression-blocked promote runs the RCA heuristics and
      // records a finding (which also lands in workspace intelligence as an issue).
      if (p.to === 'REJECTED' || p.to === 'ROLLED_BACK') {
        void (async () => {
          try {
            const diag = diagnose({
              failure: `governance ${p.stage ?? 'unknown'}: ${p.reason ?? p.to}`,
              evidence: { proposalId: p.proposalId, from: p.from, to: p.to },
              timestamp: Date.now(),
            } as Parameters<typeof diagnose>[0])
            await writeFinding(deps.db, {
              title: `Auto-RCA: ${diag.cause}`.slice(0, 200),
              severity: diag.affectedEngine === 'guardrails' ? 'major' : 'minor',
              evidence:
                `proposal=${p.proposalId} stage=${p.stage ?? 'n/a'} confidence=${diag.confidence} ${p.reason ?? ''}`.slice(
                  0,
                  1000,
                ),
              source: 'tool',
            })
          } catch {
            // best-effort — RCA must never block the governance pipeline
          }
        })()
      }
    } catch {
      // best-effort
    }
  })

  const patching = createPatchingSystem(
    { bus: deps.bus, db: deps.db, knowledge, gateway: deps.gateway, governance },
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
    governance,
    agentMetrics,
    memoryQuality,
    workspace,
    goals,
    policyEngine,
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
  // Governance proposal routes (/evolution/proposals*) — wired to the
  // GovernanceGate created in createLearningSystem(). Idempotent: no-ops if
  // mountEvolutionRoutes already mounted them on this app.
  if (!system.db || !system.bus) {
    console.warn(
      '[learning] mountLearningRoutes: db or bus not available, proposal routes may not work fully',
    )
    return
  }
  const resourceLimits = new ResourceLimits({ bus: system.bus, db: system.db })
  const ledger = new ImprovementLedger(system.db, system.bus)
  mountEvolutionProposalRoutes(app, {
    governance: system.governance,
    // promote-time rollback points: exact snapshot linkage by patchId
    rollbackManager: new RollbackManager({ db: system.db, bus: system.bus }),
    resourceLimits,
    ledger,
  })

  // Workspace items — persistent workspace awareness (issues, decisions, roadmap, tech-debt).
  // Fed by findings (issues) and governance transitions (decisions); also writable manually.
  app.get('/workspace/items', (c) => {
    const kind = c.req.query('kind') as WorkspaceItemKind | undefined
    const status = c.req.query('status') as WorkspaceItem['status'] | undefined
    return c.json(system.workspace.query({ kind, status }))
  })

  app.get('/workspace/items/summary', (c) => {
    return c.json(system.workspace.summary())
  })

  app.post('/workspace/items', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      kind?: string
      title?: string
      description?: string
      status?: string
      priority?: string
      metadata?: Record<string, string | number | boolean>
    }
    const validKinds = ['roadmap', 'issue', 'tech-debt', 'ci-status', 'decision']
    const validStatuses = ['open', 'in-progress', 'resolved', 'wontfix']
    const validPriorities = ['low', 'medium', 'high']
    if (!body.kind || !validKinds.includes(body.kind)) {
      return c.json({ error: `kind must be one of: ${validKinds.join(', ')}` }, 400)
    }
    if (!body.title?.trim()) return c.json({ error: 'title required' }, 400)
    if (body.status && !validStatuses.includes(body.status)) {
      return c.json({ error: `status must be one of: ${validStatuses.join(', ')}` }, 400)
    }
    if (body.priority && !validPriorities.includes(body.priority)) {
      return c.json({ error: `priority must be one of: ${validPriorities.join(', ')}` }, 400)
    }
    const item = system.workspace.upsert({
      kind: body.kind as WorkspaceItemKind,
      title: body.title.trim(),
      description: body.description,
      status: body.status as WorkspaceItem['status'],
      priority: body.priority as WorkspaceItem['priority'],
      metadata: body.metadata,
    })
    return c.json(item, 201)
  })

  app.patch('/workspace/items/:id/status', async (c) => {
    const id = c.req.param('id')
    const body = (await c.req.json().catch(() => ({}))) as { status?: string }
    const valid = ['open', 'in-progress', 'resolved', 'wontfix']
    if (!body.status || !valid.includes(body.status)) {
      return c.json({ error: `status must be one of: ${valid.join(', ')}` }, 400)
    }
    const item = system.workspace.get(id)
    if (!item) return c.json({ error: 'not found' }, 404)
    system.workspace.setStatus(id, body.status as WorkspaceItem['status'])
    return c.json(system.workspace.get(id))
  })

  // Decision log — why major actions were taken, with evidence and alternatives
  app.get('/learning/decisions', (c) => {
    const trace = getWorkflowTrace()
    const limit = Math.min(Number(c.req.query('limit') ?? '50') || 50, 200)
    return c.json(trace.decisions.slice(-limit).reverse())
  })

  // Strategic goals (P2.1) — long-term objectives; structured records + lifecycle.
  app.get('/goal', (c) => {
    const status = c.req.query('status') as GoalStatus | undefined
    const limit = Math.min(Number(c.req.query('limit') ?? '50') || 50, 100)
    return c.json(system.goals.list({ status, limit }))
  })

  app.post('/goal', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: string
      description?: string
      rationale?: string
      priority?: string
    }
    if (!body.title?.trim()) return c.json({ error: 'title required' }, 400)
    const validPriorities = ['high', 'medium', 'low']
    if (body.priority && !validPriorities.includes(body.priority)) {
      return c.json({ error: `priority must be one of: ${validPriorities.join(', ')}` }, 400)
    }
    const goal = system.goals.create({
      title: body.title.trim(),
      description: body.description,
      rationale: body.rationale,
      priority: body.priority as GoalPriority,
    })
    system.bus?.publish({
      type: 'job.updated',
      payload: { goal: goal.id, action: 'created' },
      timestamp: Date.now(),
    })
    return c.json(goal, 201)
  })

  app.patch('/goal/:id/status', async (c) => {
    const id = c.req.param('id')
    const body = (await c.req.json().catch(() => ({}))) as { status?: string }
    const valid = ['active', 'achieved', 'abandoned']
    if (!body.status || !valid.includes(body.status)) {
      return c.json({ error: `status must be one of: ${valid.join(', ')}` }, 400)
    }
    const goal = system.goals.updateStatus(id, body.status as GoalStatus)
    if (!goal) return c.json({ error: 'not found' }, 404)
    return c.json(goal)
  })

  app.post('/goal/:id/milestone', async (c) => {
    const id = c.req.param('id')
    const body = (await c.req.json().catch(() => ({}))) as { label?: string; complete?: string }
    if (body.complete) {
      const goal = system.goals.completeMilestone(id, body.complete)
      if (!goal) return c.json({ error: 'not found' }, 404)
      return c.json(goal)
    }
    if (!body.label?.trim())
      return c.json({ error: 'label required (or complete=<milestoneId>)' }, 400)
    const goal = system.goals.addMilestone(id, body.label)
    if (!goal) return c.json({ error: 'not found' }, 404)
    return c.json(goal, 201)
  })

  // Project Health Score (P2.2) — composite over findings/audit/governance/debt.
  // Distinct from /health (process) and /learning/score (session).
  app.get('/workspace/health', async (c) => {
    const { computeProjectHealth } = await import('../workspace/health.js')
    const health = await computeProjectHealth({
      db: system.db,
      workspace: system.workspace,
      governance: system.governance,
    })
    return c.json(health)
  })

  // Repo timeline (P1.5) — bounded git-history analysis; ?mirror=1 also writes
  // hotspot tech-debt items into workspace intelligence.
  app.get('/repo/timeline', async (c) => {
    try {
      const { analyzeTimelineToWorkspace } = await import('../repo/timeline.js')
      const mirror = c.req.query('mirror') === '1' || c.req.query('mirror') === 'true'
      const limit = Math.min(Number(c.req.query('limit') ?? '200') || 200, 500)
      const since = c.req.query('since') ?? null
      const result = analyzeTimelineToWorkspace(
        process.cwd(),
        mirror ? system.workspace : undefined,
        { limit, since },
      )
      if (!result.ok) return c.json(result, 400)
      return c.json(result)
    } catch (err) {
      return c.json({ ok: false, reason: String(err) }, 500)
    }
  })

  app.get('/learning/status', (c) => {
    const { top, bottom } = rankByUtility(system.knowledge)
    return c.json({
      scheduler: system.scheduler.status(),
      knowledge: { size: system.knowledge.size(), tiers: ['episodic', 'semantic', 'procedural'] },
      usage: system.usage.getStats(),
      // Phase 4 surfacing: utility feedback made visible (top 3 / bottom 3)
      topPerforming: top,
      worstPerforming: bottom,
    })
  })

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
      // §6.6: a human asserted this → human-verified (1.0) per §3 mapping
      sourceKind: 'user-stated',
      createdBy: 'user',
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
    // Tombstone + persist — the old in-memory-only delete resurrected the row
    // on every restart.
    if (!system.knowledge.remove(id)) return c.json({ error: 'not found' }, 404)
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
      // Mirror resolution into workspace intelligence
      try {
        const item = system.workspace
          .query({ kind: 'issue' })
          .find((i) => i.metadata.findingId === id)
        if (item) system.workspace.setStatus(item.id, 'resolved')
      } catch {
        // best-effort
      }
      const entry = await system.knowledge.store({
        tier: 'procedural',
        source: 'improvement',
        title: `Resolved: ${String(row.title)}`,
        content: `Finding ${String(row.severity)}: ${String(row.evidence ?? 'no evidence')}. Source: ${String(row.source)}. Resolved to knowledge.`,
        tags: [String(row.severity), String(row.source), 'resolved'],
        metadata: { findingId: id, severity: String(row.severity), source: String(row.source) },
        // §6.6: synthesized from a finding — chain stays queryable (§2.1)
        sourceKind: 'derived',
        derivedFrom: [`finding:${id}`],
        sourceRef: `finding:${id}`,
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

  // GET /eval/model/:model — per-model eval stats (success rate, sessions, last eval time)
  app.get('/eval/model/:model', (c) => {
    const model = decodeURIComponent(c.req.param('model'))
    if (!model) return c.json({ model, successRate: null, sessions: 0 }, 200)

    const all = system.usage.getAllSessionMetrics()
    const modelSessions = all.filter((s) => s.model === model)
    if (!modelSessions.length) {
      return c.json({ model, successRate: null, sessions: 0 }, 200)
    }

    const sessions = modelSessions.length
    const successes = modelSessions.filter((s) => s.success).length
    const successRate = successes / sessions
    const lastEvalAt = modelSessions.length
      ? new Date(modelSessions[modelSessions.length - 1]!.createdAt).toISOString()
      : undefined

    return c.json({ model, successRate, sessions, lastEvalAt })
  })
}

/** Phase 4 surfacing — top/bottom 3 knowledge entries by utility for
 *  `/learning/status` (worst first in `bottom`). Tombstoned entries are
 *  already excluded by `knowledge.list()`. */
function rankByUtility(kb: KnowledgeBase): {
  top: Array<{ id: string; title: string; utility: number; source: string; tags: string[] }>
  bottom: Array<{ id: string; title: string; utility: number; source: string; tags: string[] }>
} {
  const scored = kb.list({ limit: 200 }).map((e) => ({
    id: e.id,
    title: e.title,
    utility: typeof e.metadata.utility === 'number' ? e.metadata.utility : 0,
    source: e.source,
    tags: e.tags,
  }))
  const sorted = [...scored].sort((a, b) => b.utility - a.utility)
  return { top: sorted.slice(0, 3), bottom: sorted.slice(-3).reverse() }
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
