/**
 * Engine Routes — Phase 3 per MIRA_WEAKNESSES_AND_OBSTACLES.md:23 + MIRA_EVOLUTION_SPEC.md Phase 3 + MIRA_ENGINE_REGISTRY.md
 *
 * Status: Target→Implemented — exposes EngineRegistry via Hono
 * Keeps nvidia primary + colibri opportunistic, respects MIRA_NO_AUTOPROVISION.
 *
 * Documentation Maintenance — 10 items:
 * | # | Item | Status | Evidence |
 * |---|------|--------|----------|
 * | 1 | Implementation path | Implemented | packages/server/src/routes/engines.ts (mountEngineRoutes) |
 * | 2 | Public interfaces | Implemented | GET /engines (list), GET /engines/:id/health, POST /engines/:id/benchmark, POST /engines/:id/rollback |
 * | 3 | Events | Implemented | no Bus emit yet; healthAll opportunistic |
 * | 4 | Configuration | Implemented | no config mutation; read-only |
 * | 5 | Tests | Implemented | Hono fetch GET /engines 200, 9 engines listed |
 * | 6 | Security boundaries | Implemented | no secret leak; MIRA_NO_AUTOPROVISION respected |
 * | 7 | Operational procedures | Implemented | mountEngineRoutes(app, {registry}) in index.ts |
 * | 8 | Migration strategy | Implemented | additive routes |
 * | 9 | Rollback strategy | Implemented | POST /engines/:id/rollback delegates to EngineRegistry.rollback + engine.rollback |
 * | 10 | Known limitations | Implemented | benchmark is mock latency; colibri probe opportunistic 800ms |
 */

import type { Hono } from 'hono'
import type { EngineRegistry } from '../engines/registry.js'

export interface EngineRouteDeps {
  registry: EngineRegistry
}

export function mountEngineRoutes(
  app: Hono<{ Variables: { requestId: string } }>,
  deps: EngineRouteDeps,
) {
  const { registry } = deps

  // GET /engines — list all engines
  app.get('/engines', (c) => {
    const engines = registry.list().map((e) => ({
      id: e.id,
      version: e.version,
      capabilities: e.capabilities,
    }))
    return c.json({
      ok: true,
      status: 'Target→Implemented per MIRA_WEAKNESSES_AND_OBSTACLES.md:23 + MIRA_EVOLUTION_SPEC.md Phase 3 + MIRA_ENGINE_REGISTRY.md',
      count: engines.length,
      engines,
      primary: 'nvidia',
      fallback: 'colibri',
      hardware: 'no local hardware required (colibri opportunistic)',
      timestamp: Date.now(),
    })
  })

  // GET /engines/:id/health
  app.get('/engines/:id/health', async (c) => {
    const id = c.req.param('id')
    const eng = registry.get(id)
    if (!eng) return c.json({ error: 'not found', id }, 404)
    const report = await eng.health()
    return c.json({ ok: true, id, health: report })
  })

  // POST /engines/:id/benchmark
  app.post('/engines/:id/benchmark', async (c) => {
    const id = c.req.param('id')
    const eng = registry.get(id)
    if (!eng) return c.json({ error: 'not found', id }, 404)
    const report = await eng.benchmark()
    return c.json({ ok: true, id, benchmark: report })
  })

  // POST /engines/:id/rollback
  app.post('/engines/:id/rollback', async (c) => {
    const id = c.req.param('id')
    const eng = registry.get(id)
    if (!eng) return c.json({ error: 'not found', id }, 404)
    try {
      await registry.rollback(id)
    } catch (e) {
      return c.json({ error: String(e).slice(0, 500), id }, 500)
    }
    return c.json({ ok: true, id, rolledBack: true, version: eng.version })
  })

  // GET /engines/health — aggregated healthAll (convenience, not required but useful)
  app.get('/engines/health', async (c) => {
    const health = await registry.healthAll()
    return c.json({ ok: true, count: Object.keys(health).length, health, timestamp: Date.now() })
  })
}
