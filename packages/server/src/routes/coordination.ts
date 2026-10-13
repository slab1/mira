/**
 * Coordination Routes — §12 multi-agent coordination over HTTP
 *
 * Mounts CoordinationHub primitives so agents (server-side or external) can
 * claim tasks, lock files, check patch staleness, and read shared state:
 *   POST /coordination/tasks        { taskId, owner, priority?, files?, deps? } → claim
 *   DELETE /coordination/tasks/:id  ?owner= → release (owner-only)
 *   POST /coordination/locks        { owner, paths[], taskId?, ttlMs? } → lock
 *   DELETE /coordination/locks      { owner, paths[] } → unlock
 *   POST /coordination/writes       { path, hash, owner } → record write
 *   POST /coordination/patches/check { path, baseHash, owner } → stale-base check
 *   POST /coordination/transactions { owner, paths[], taskIds? } → begin
 *   POST /coordination/transactions/:id/commit   { owner } → commit
 *   POST /coordination/transactions/:id/abort    { owner } → abort
 *   GET  /coordination/status       → shared mission state (§12)
 *   GET  /coordination/health       → hub health
 *
 * Documentation Maintenance — 10 items:
 * | # | Item | Status | Evidence |
 * |---|------|--------|----------|
 * | 1 | Implementation path | Implemented | packages/server/src/routes/coordination.ts + agents/coordination.ts |
 * | 2 | Public interfaces | Implemented | routes above; every mutation returns conflicts on failure |
 * | 3 | Events | Implemented | caller-visible via status(); Bus emission left to integration (module pure) |
 * | 4 | Configuration | Implemented | MIRA_LOCK_TTL_MS / MIRA_CLAIM_TTL_MS via hub env defaults |
 * | 5 | Tests | Implemented | agents/coordination.test.ts + routes/coordination.test.ts |
 * | 6 | Security boundaries | Implemented | §12: release/unlock/commit/abort are owner-only; conflicts fail-closed |
 * | 7 | Operational procedures | Implemented | mountCoordinationRoutes(app, { hub }) on boot |
 * | 8 | Migration strategy | Implemented | additive routes, in-memory hub, zero-downtime |
 * | 9 | Rollback strategy | Implemented | unmount routes; no persisted state |
 * | 10 | Known limitations | Implemented | single-process hub (multi-process needs shared store — Target) |
 */

import type { Hono } from 'hono'
import { CoordinationHub } from '../agents/coordination.js'

export interface CoordinationRouteDeps {
  hub?: CoordinationHub
}

export function mountCoordinationRoutes(
  app: Hono<{ Variables: { requestId: string } }>,
  deps: CoordinationRouteDeps = {},
) {
  const hub = deps.hub ?? new CoordinationHub()

  app.get('/coordination/health', (c) =>
    c.json({ ok: true, hub: 'CoordinationHub §12', ...hub.status(), timestamp: Date.now() }),
  )

  app.get('/coordination/status', (c) => c.json({ ok: true, ...hub.status() }))

  app.post('/coordination/tasks', async (c) => {
    let body: {
      taskId?: string
      owner?: string
      priority?: number
      files?: string[]
      deps?: string[]
    } | null = null
    try {
      body = (await c.req.json()) as {
        taskId?: string
        owner?: string
        priority?: number
        files?: string[]
        deps?: string[]
      } | null
    } catch {
      body = null
    }
    const taskId = typeof body?.taskId === 'string' ? body.taskId.slice(0, 200) : ''
    const owner = typeof body?.owner === 'string' ? body.owner.slice(0, 200) : ''
    if (!taskId || !owner)
      return c.json({ error: 'body.taskId and body.owner strings required' }, 400)
    const decision = hub.claimTask({
      taskId,
      owner,
      priority: typeof body?.priority === 'number' ? body.priority : undefined,
      files: Array.isArray(body?.files)
        ? (body?.files as unknown[]).map(String).slice(0, 50)
        : undefined,
      deps: Array.isArray(body?.deps)
        ? (body?.deps as unknown[]).map(String).slice(0, 50)
        : undefined,
    })
    return c.json({ ...decision, ok: decision.ok }, decision.ok ? 200 : 409)
  })

  app.delete('/coordination/tasks/:id', async (c) => {
    const id = c.req.param('id')
    const owner = c.req.query('owner') ?? ''
    if (!owner) return c.json({ error: 'query.owner required' }, 400)
    const r = hub.releaseTask(id, owner)
    return c.json({ ok: r.ok, error: r.error }, r.ok ? 200 : 409)
  })

  app.post('/coordination/locks', async (c) => {
    let body: { owner?: string; paths?: string[]; taskId?: string; ttlMs?: number } | null = null
    try {
      body = (await c.req.json()) as {
        owner?: string
        paths?: string[]
        taskId?: string
        ttlMs?: number
      } | null
    } catch {
      body = null
    }
    const owner = typeof body?.owner === 'string' ? body.owner.slice(0, 200) : ''
    const paths = Array.isArray(body?.paths)
      ? (body?.paths as unknown[]).map(String).slice(0, 100)
      : []
    if (!owner || paths.length === 0)
      return c.json({ error: 'body.owner and body.paths[] required' }, 400)
    const r = hub.lockFiles(owner, paths, {
      taskId: typeof body?.taskId === 'string' ? body.taskId.slice(0, 200) : undefined,
      ttlMs: typeof body?.ttlMs === 'number' ? body.ttlMs : undefined,
    })
    return c.json({ ok: r.conflicts.length === 0, ...r }, r.conflicts.length === 0 ? 200 : 409)
  })

  app.delete('/coordination/locks', async (c) => {
    let body: { owner?: string; paths?: string[] } | null = null
    try {
      body = (await c.req.json()) as { owner?: string; paths?: string[] } | null
    } catch {
      body = null
    }
    const owner = typeof body?.owner === 'string' ? body.owner.slice(0, 200) : ''
    const paths = Array.isArray(body?.paths)
      ? (body?.paths as unknown[]).map(String).slice(0, 100)
      : []
    if (!owner || paths.length === 0)
      return c.json({ error: 'body.owner and body.paths[] required' }, 400)
    const r = hub.unlockFiles(owner, paths)
    return c.json({ ok: r.errors.length === 0, ...r }, r.errors.length === 0 ? 200 : 409)
  })

  app.post('/coordination/writes', async (c) => {
    let body: { path?: string; hash?: string; owner?: string } | null = null
    try {
      body = (await c.req.json()) as { path?: string; hash?: string; owner?: string } | null
    } catch {
      body = null
    }
    const path = typeof body?.path === 'string' ? body.path.slice(0, 500) : ''
    const hash = typeof body?.hash === 'string' ? body.hash.slice(0, 64) : ''
    const owner = typeof body?.owner === 'string' ? body.owner.slice(0, 200) : ''
    if (!path || !hash || !owner)
      return c.json({ error: 'body.path, body.hash, body.owner required' }, 400)
    const w = hub.recordWrite(path, hash, owner)
    return c.json({ ok: true, write: w })
  })

  app.post('/coordination/patches/check', async (c) => {
    let body: { path?: string; baseHash?: string; owner?: string } | null = null
    try {
      body = (await c.req.json()) as { path?: string; baseHash?: string; owner?: string } | null
    } catch {
      body = null
    }
    const path = typeof body?.path === 'string' ? body.path.slice(0, 500) : ''
    const baseHash = typeof body?.baseHash === 'string' ? body.baseHash.slice(0, 64) : ''
    const owner = typeof body?.owner === 'string' ? body.owner.slice(0, 200) : ''
    if (!path || !baseHash || !owner)
      return c.json({ error: 'body.path, body.baseHash, body.owner required' }, 400)
    const r = hub.patchConflicts(path, baseHash, owner)
    return c.json({ ok: !r.stale, ...r }, r.stale ? 409 : 200)
  })

  app.post('/coordination/transactions', async (c) => {
    let body: { owner?: string; paths?: string[]; taskIds?: string[] } | null = null
    try {
      body = (await c.req.json()) as { owner?: string; paths?: string[]; taskIds?: string[] } | null
    } catch {
      body = null
    }
    const owner = typeof body?.owner === 'string' ? body.owner.slice(0, 200) : ''
    const paths = Array.isArray(body?.paths) ? body.paths.map(String).slice(0, 100) : []
    if (!owner || paths.length === 0)
      return c.json({ error: 'body.owner and body.paths[] required' }, 400)
    const r = hub.beginTransaction(
      owner,
      paths,
      Array.isArray(body?.taskIds) ? body.taskIds.map(String).slice(0, 50) : [],
    )
    return c.json({ ...r, ok: r.ok }, r.ok ? 200 : 409)
  })

  app.post('/coordination/transactions/:id/commit', async (c) => {
    let body: { owner?: string } | null = null
    try {
      body = (await c.req.json()) as { owner?: string } | null
    } catch {
      body = null
    }
    const owner = typeof body?.owner === 'string' ? body.owner.slice(0, 200) : ''
    if (!owner) return c.json({ error: 'body.owner required' }, 400)
    const r = hub.commit(c.req.param('id'), owner)
    return c.json({ ok: r.ok, error: r.error }, r.ok ? 200 : 409)
  })

  app.post('/coordination/transactions/:id/abort', async (c) => {
    let body: { owner?: string } | null = null
    try {
      body = (await c.req.json()) as { owner?: string } | null
    } catch {
      body = null
    }
    const owner = typeof body?.owner === 'string' ? body.owner.slice(0, 200) : ''
    if (!owner) return c.json({ error: 'body.owner required' }, 400)
    const r = hub.abort(c.req.param('id'), owner)
    return c.json({ ok: r.ok, error: r.error }, r.ok ? 200 : 409)
  })
}
