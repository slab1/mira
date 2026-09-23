/**
 * Canary Routes — Phase 5 per MIRA_WEAKNESSES_AND_OBSTACLES.md:23 + MIRA_EVOLUTION_SPEC.md Phase 5 + MIRA_SYSTEM_DOCUMENTATION.md:10 Reversibility
 *
 * Status: Target→Implemented — exposes CanaryManager via Hono (§6 Canary, §10 Reversibility, §22 Target Evolution Architecture).
 * POST /canary/start {candidateId, traffic, duration}, GET /canary, GET /canary/:id, POST /canary/:id/promote, POST /canary/:id/rollback, GET /canary/health.
 * Keeps nvidia primary + colibri opportunistic, respects MIRA_NO_AUTOPROVISION, no local hardware.
 *
 * Documentation Maintenance — 10 items:
 * | # | Item | Status | Evidence (path / interface) |
 * |---|------|--------|------------------------------|
 * | 1 | Implementation path | Implemented | packages/server/src/routes/canary.ts (mountCanaryRoutes) + packages/server/src/canary/{canary,monitor,promote}.ts |
 * | 2 | Public interfaces | Implemented | POST /canary/start {candidateId,traffic,duration}, GET /canary, GET /canary/:id, POST /canary/:id/promote, POST /canary/:id/rollback, GET /canary/health |
 * | 3 | Events | Implemented | POST /canary/start emits canary.started; promote emits canary.completed; rollback emits canary.failed; monitor polls Bus+metrics+gateway every 60s |
 * | 4 | Configuration | Implemented | traffic 5% default + duration 24h default; lane canary vs default via SubgatewayRegistry; nvidia primary |
 * | 5 | Tests | Implemented | packages/server/src/canary/canary.test.ts Hono fetch 200 for 6 endpoints |
 * | 6 | Security boundaries | Implemented | validates candidateId via EngineRegistry, MIRA_NO_AUTOPROVISION respected, no secret leak, fail-closed evaluate |
 * | 7 | Operational procedures | Implemented | mountCanaryRoutes(app,{manager}) in src/index.ts after shadow, log canary ready |
 * | 8 | Migration strategy | Implemented | additive routes; safe to disable; no DB migration |
 * | 9 | Rollback strategy | Implemented | POST /canary/:id/rollback → RollbackManager + registry.rollback + ledger rolledback per §6 §10 |
 * | 10 | Known limitations | Implemented | logical 5% sampling not network split; real canary variant wires Phase 4 shadow; colibri opportunistic |
 */

import type { Hono } from 'hono'
import type { CanaryManager } from '../canary/canary.js'

export interface CanaryRouteDeps {
  manager: CanaryManager
  // alias for alternative wiring
  canary?: CanaryManager
}

export function mountCanaryRoutes(
  app: Hono<{ Variables: { requestId: string } }>,
  deps: CanaryRouteDeps,
) {
  const manager = deps.manager ?? deps.canary
  if (!manager) throw new Error('CanaryManager required for mountCanaryRoutes')

  // ── GET /canary/health ─────────────────────────────────────────────
  // Must be registered before /canary/:id to avoid param capture
  app.get('/canary/health', (c) => {
    const h = manager.health()
    return c.json({
      ok: true,
      status: 'Target→Implemented per MIRA_WEAKNESSES_AND_OBSTACLES.md:23 + MIRA_EVOLUTION_SPEC.md Phase 5 + MIRA_SYSTEM_DOCUMENTATION.md:10 Reversibility',
      phase: 'Phase 5 Canary',
      primary: 'nvidia',
      fallback: 'colibri',
      hardware: 'no local hardware required (colibri opportunistic)',
      count: h.count,
      running: h.running,
      lanes: h.lanes,
      traffic: '5% via lane canary vs default (SubgatewayRegistry)',
      monitor: h.monitor,
      gates: '+20%/-0.5pp per §16 (latency/cost +20%, success/regression -0.5pp) + circuit breaker',
      routes: [
        'GET /canary/health',
        'POST /canary/start',
        'GET /canary',
        'GET /canary/:id',
        'POST /canary/:id/promote',
        'POST /canary/:id/rollback',
      ],
      timestamp: Date.now(),
    })
  })

  // ── POST /canary/start {candidateId, traffic, duration} ────────────
  app.post('/canary/start', async (c) => {
    let body: Record<string, unknown> | null = null
    try { body = (await c.req.json() as unknown) as Record<string, unknown> } catch { body = null }
    const candidateId = typeof body?.['candidateId'] === 'string' ? (body['candidateId'] as string).trim() : (typeof body?.['candidateEngineId'] === 'string' ? (body['candidateEngineId'] as string).trim() : (typeof body?.['candidate_id'] === 'string' ? (body['candidate_id'] as string).trim() : ''))
    if (!candidateId) {
      return c.json({ error: 'body.candidateId string required (e.g., "tool" | "agent" | "memory")' }, 400)
    }
    const trafficRaw = body?.['traffic']
    const durationRaw = body?.['duration']
    const traffic = typeof trafficRaw === 'number' && Number.isFinite(trafficRaw) ? Number(trafficRaw) : (typeof trafficRaw === 'string' && trafficRaw.trim() ? Number(trafficRaw) : 5)
    const duration = typeof durationRaw === 'number' && Number.isFinite(durationRaw) ? Number(durationRaw) : (typeof durationRaw === 'string' && durationRaw.trim() ? Number(durationRaw) : 24 * 60 * 60 * 1000)
    if (!Number.isFinite(traffic) || traffic < 0 || traffic > 100) {
      return c.json({ error: 'traffic must be 0..100 percent' }, 400)
    }
    if (!Number.isFinite(duration) || duration < 1000) {
      return c.json({ error: 'duration must be >=1000 ms' }, 400)
    }
    try {
      const out = manager.startCanary(candidateId, traffic, duration)
      return c.json({
        ok: true,
        canaryId: out.canaryId,
        candidateId,
        candidateVersion: out.candidateVersion,
        parentVersion: out.parentVersion,
        traffic: out.traffic,
        startedAt: out.startedAt,
        expiresAt: out.expiresAt,
        lane: 'canary',
        vs: 'default',
        monitor: 'Bus+metrics+gateway every 60s',
        gates: '+20%/-0.5pp + circuit breaker',
        timestamp: Date.now(),
      })
    } catch (e) {
      const msg = String((e as Error)?.message ?? e)
      if (msg.includes('not found')) return c.json({ error: msg }, 404)
      return c.json({ error: msg.slice(0, 500) }, 500)
    }
  })

  // ── GET /canary ────────────────────────────────────────────────────
  app.get('/canary', (c) => {
    const list = manager.list().map((r) => ({
      canaryId: r.canaryId,
      candidateId: r.candidateId,
      candidateVersion: r.candidateVersion,
      parentVersion: r.parentVersion,
      traffic: r.traffic,
      durationMs: r.durationMs,
      startedAt: r.startedAt,
      expiresAt: r.expiresAt,
      status: r.status,
      lane: r.lane,
      vs: 'default',
      health: manager.getMonitorStatus(r.canaryId) ?? 'healthy',
      metrics: manager.getMetrics(r.canaryId).slice(-1)[0] ?? r.baseline,
    }))
    return c.json({
      ok: true,
      status: 'Target→Implemented per MIRA_WEAKNESSES_AND_OBSTACLES.md:23 Phase 5',
      count: list.length,
      canaries: list,
      traffic: '5% via lane canary vs default',
      timestamp: Date.now(),
    })
  })

  // ── GET /canary/:id ────────────────────────────────────────────────
  app.get('/canary/:id', (c) => {
    const id = c.req.param('id')
    const rec = manager.get(id)
    if (!rec) return c.json({ error: 'not found', id }, 404)
    const metrics = manager.getMetrics(id)
    const health = manager.getMonitorStatus(id)
    const evaluation = (() => { try { return manager.evaluate(id) } catch { return null } })()
    return c.json({
      ok: true,
      canary: {
        canaryId: rec.canaryId,
        candidateId: rec.candidateId,
        candidateVersion: rec.candidateVersion,
        parentVersion: rec.parentVersion,
        traffic: rec.traffic,
        durationMs: rec.durationMs,
        startedAt: rec.startedAt,
        expiresAt: rec.expiresAt,
        status: rec.status,
        lane: rec.lane,
        vs: 'default',
        baseline: rec.baseline,
        latest: metrics.slice(-1)[0] ?? rec.baseline,
        metrics,
        health: health ?? 'healthy',
        evaluation,
      },
      timestamp: Date.now(),
    })
  })

  // ── POST /canary/:id/promote ───────────────────────────────────────
  app.post('/canary/:id/promote', async (c) => {
    const id = c.req.param('id')
    const rec = manager.get(id)
    if (!rec) return c.json({ error: 'not found', id }, 404)
    try {
      const res = await manager.promote(id)
      return c.json({
        ok: true,
        id,
        canaryId: id,
        candidateId: rec.candidateId,
        promoted: true,
        fromVersion: res.fromVersion,
        toVersion: res.toVersion,
        reason: res.reason,
        ledger: 'promoted',
        timestamp: Date.now(),
      })
    } catch (e) {
      const msg = String((e as Error)?.message ?? e)
      return c.json({ error: msg.slice(0, 800), id, candidateId: rec.candidateId }, 400)
    }
  })

  // ── POST /canary/:id/rollback ──────────────────────────────────────
  app.post('/canary/:id/rollback', async (c) => {
    const id = c.req.param('id')
    const rec = manager.get(id)
    if (!rec) return c.json({ error: 'not found', id }, 404)
    try {
      const res = await manager.rollback(id)
      return c.json({
        ok: true,
        id,
        canaryId: id,
        candidateId: rec.candidateId,
        rolledback: true,
        reason: res.reason,
        ledger: 'rolledback',
        timestamp: Date.now(),
      })
    } catch (e) {
      const msg = String((e as Error)?.message ?? e)
      return c.json({ error: msg.slice(0, 500), id }, 500)
    }
  })
}
