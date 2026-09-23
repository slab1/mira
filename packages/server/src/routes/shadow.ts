/**
 * Shadow Routes — Phase 4 per MIRA_WEAKNESSES_AND_OBSTACLES.md:23 + MIRA_EVOLUTION_SPEC.md Phase 4 + MIRA_SYSTEM_DOCUMENTATION.md:11 Shadow Mira
 *
 * Status: Target→Implemented — exposes ShadowMira via Hono (§5 Shadow, §11 Shadow Mira, §22 Target Evolution Architecture).
 * POST /shadow/start {candidateEngineId}, GET /shadow/:id, GET /shadow, POST /shadow/:id/compare, GET /shadow/health.
 * Keeps nvidia primary + colibri opportunistic, respects MIRA_NO_AUTOPROVISION, no local hardware.
 *
 * Documentation Maintenance — 10 items:
 * | # | Item | Status | Evidence (path / interface) |
 * |---|------|--------|------------------------------|
 * | 1 | Implementation path | Implemented | packages/server/src/routes/shadow.ts (mountShadowRoutes) + packages/server/src/shadow/* |
 * | 2 | Public interfaces | Implemented | POST /shadow/start {candidateEngineId}, GET /shadow/:id, GET /shadow, POST /shadow/:id/compare, GET /shadow/health |
 * | 3 | Events | Implemented | POST /shadow/start emits evolution.shadowed via ShadowMira; health exposes telemetry |
 * | 4 | Configuration | Implemented | reads ShadowMira(EngineRegistry+Bus+metrics); no config mutation; nvidia primary |
 * | 5 | Tests | Implemented | packages/server/src/shadow/shadow.test.ts Hono fetch 200 for 4 endpoints |
 * | 6 | Security boundaries | Implemented | no secret leak; MIRA_NO_AUTOPROVISION respected; isolated shadow DB/Bus — no prod side-effects |
 * | 7 | Operational procedures | Implemented | mountShadowRoutes(app,{shadow}) in src/index.ts after engines, log shadow ready |
 * | 8 | Migration strategy | Implemented | additive routes; safe to disable |
 * | 9 | Rollback strategy | Implemented | shadow is isolation — no promotion; POST /shadow/:id/compare + GET /shadow/:id for audit; worse→rollback via evolution |
 * | 10 | Known limitations | Implemented | candidate == production until engine upgrade wires real candidate version; colibri opportunistic |
 */

import type { Hono } from 'hono'
import type { ShadowMira } from '../shadow/shadow.js'

export interface ShadowRouteDeps {
  shadow: ShadowMira
}

export function mountShadowRoutes(
  app: Hono<{ Variables: { requestId: string } }>,
  deps: ShadowRouteDeps,
) {
  const { shadow } = deps

  // ── GET /shadow/health ─────────────────────────────────────────────
  // Must be registered before /shadow/:id to avoid param capture
  app.get('/shadow/health', (c) => {
    const h = shadow.health()
    return c.json({
      ok: true,
      status: 'Target→Implemented per MIRA_WEAKNESSES_AND_OBSTACLES.md:23 + MIRA_EVOLUTION_SPEC.md Phase 4 + MIRA_SYSTEM_DOCUMENTATION.md:11 Shadow Mira',
      phase: 'Phase 4 Shadow Mira',
      primary: 'nvidia',
      fallback: 'colibri',
      hardware: 'no local hardware required (colibri opportunistic, shadow DB isolated)',
      count: h.count,
      engines: h.engines,
      telemetry: h.telemetry,
      shadowDb: h.shadowDb,
      isolated: h.isolated,
      routes: [
        'GET /shadow/health',
        'POST /shadow/start',
        'GET /shadow',
        'GET /shadow/:id',
        'POST /shadow/:id/compare',
      ],
      timestamp: Date.now(),
    })
  })

  // ── POST /shadow/start {candidateEngineId} ─────────────────────────
  app.post('/shadow/start', async (c) => {
    let body: Record<string, unknown> | null = null
    try { body = (await c.req.json() as unknown) as Record<string, unknown> } catch { body = null }
    const candidateEngineId = typeof body?.['candidateEngineId'] === 'string' ? (body['candidateEngineId'] as string).trim() : ''
    if (!candidateEngineId) {
      return c.json({ error: 'body.candidateEngineId string required (e.g., "tool" | "agent" | "memory")' }, 400)
    }
    try {
      const out = await shadow.startShadow(candidateEngineId)
      return c.json({
        ok: true,
        shadowId: out.shadowId,
        candidateEngineId,
        candidateVersion: out.candidateVersion,
        parentVersion: out.parentVersion,
        result: out.result,
        // also expose benchmark summary for verification
        benchmark: {
          production: out.benchmark.aggregated.production,
          candidate: out.benchmark.aggregated.candidate,
          delta: out.benchmark.aggregated.delta,
        },
        telemetry: out.telemetry,
        isolated: true,
        timestamp: Date.now(),
      })
    } catch (e) {
      const msg = String((e as Error)?.message ?? e)
      if (msg.includes('not found')) return c.json({ error: msg }, 404)
      return c.json({ error: msg.slice(0, 500) }, 500)
    }
  })

  // ── GET /shadow ────────────────────────────────────────────────────
  app.get('/shadow', (c) => {
    const list = shadow.list().map((r) => ({
      shadowId: r.shadowId,
      candidateEngineId: r.candidateEngineId,
      candidateVersion: r.candidateVersion,
      parentVersion: r.parentVersion,
      startedAt: r.startedAt,
      isolated: r.isolated,
      verdict: r.result?.verdict ?? null,
      reasoning: r.result?.reasoning ?? null,
    }))
    return c.json({
      ok: true,
      status: 'Target→Implemented per MIRA_WEAKNESSES_AND_OBSTACLES.md:23 Phase 4',
      count: list.length,
      shadows: list,
      timestamp: Date.now(),
    })
  })

  // ── GET /shadow/:id ────────────────────────────────────────────────
  app.get('/shadow/:id', (c) => {
    const id = c.req.param('id')
    const rec = shadow.get(id)
    if (!rec) return c.json({ error: 'not found', id }, 404)
    return c.json({
      ok: true,
      shadow: {
        shadowId: rec.shadowId,
        candidateEngineId: rec.candidateEngineId,
        candidateVersion: rec.candidateVersion,
        parentVersion: rec.parentVersion,
        startedAt: rec.startedAt,
        isolated: rec.isolated,
        benchmark: rec.benchmark
          ? {
              aggregated: rec.benchmark.aggregated,
              delta: rec.benchmark.delta,
              verifier: rec.benchmark.verifier ? { verified: rec.benchmark.verifier.verified, regression: rec.benchmark.verifier.regression, security: rec.benchmark.verifier.security } : null,
            }
          : null,
        result: rec.result,
        telemetry: rec.telemetry,
      },
      timestamp: Date.now(),
    })
  })

  // ── POST /shadow/:id/compare ───────────────────────────────────────
  // Runs benchmark+comparison again for fresh evaluation (§16 gates)
  app.post('/shadow/:id/compare', async (c) => {
    const id = c.req.param('id')
    const rec = shadow.get(id)
    if (!rec) return c.json({ error: 'not found', id }, 404)
    try {
      const out = await shadow.compareShadow(id)
      return c.json({
        ok: true,
        id,
        shadowId: id,
        candidateEngineId: out.shadow.candidateEngineId,
        verdict: out.comparison.verdict,
        reasoning: out.comparison.reasoning,
        scores: out.comparison.scores,
        gates: out.comparison.gates,
        allPass: out.comparison.allPass,
        improved: out.comparison.improved,
        regressed: out.comparison.regressed,
        benchmark: {
          production: out.benchmark.aggregated.production,
          candidate: out.benchmark.aggregated.candidate,
          delta: out.benchmark.aggregated.delta,
        },
        telemetry: shadow.getTelemetry(),
        timestamp: Date.now(),
      })
    } catch (e) {
      return c.json({ error: String(e).slice(0, 500), id }, 500)
    }
  })
}
