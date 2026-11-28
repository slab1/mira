/**
 * Coordination Routes — §12 multi-agent coordination over HTTP
 *
 * Mounts CoordinationHub primitives with server-derived ownership when auth
 * resolvers are wired, plus fencing token enforcement and lease renewal:
 *   POST   /coordination/tasks             { taskId, owner?, priority?, files?, deps? } → claim
 *   DELETE /coordination/tasks/:id         ?owner=&fencingToken= → release (owner-only)
 *   POST   /coordination/locks             { owner?, paths[], taskId?, ttlMs? } → lock
 *   DELETE /coordination/locks             { owner?, paths[], fencingToken?, fencingTokens? } → unlock
 *   POST   /coordination/leases/renew      { kind, taskId?, paths?, fencingToken?, fencingTokens?, ttlMs? } → renew
 *   POST   /coordination/writes            { path, hash, owner?, fencingToken?, requireFencing? } → record write
 *   POST   /coordination/patches/check     { path, baseHash, owner? } → stale-base check
 *   POST   /coordination/transactions      { owner?, paths[], taskIds? } → begin
 *   POST   /coordination/transactions/:id/commit   { owner? } → commit
 *   POST   /coordination/transactions/:id/abort    { owner? } → abort
 *   GET    /coordination/status            → shared mission state (§12)
 *   GET    /coordination/health            → hub health
 */

import type { Context, Hono } from 'hono'
import { CoordinationHub, FencingTokenError } from '../agents/coordination.js'

export interface CoordinationRouteDeps {
  hub?: CoordinationHub
  coordination?: CoordinationHub
  resolveOwner?: (token: string) => string | undefined
  resolveRole?: (token: string) => 'viewer' | 'operator' | 'admin'
  requireAuth?: boolean
}

function bearerOf(header: string | undefined): string {
  if (!header) return ''
  const m = /^Bearer\s+(.+)$/i.exec(header.trim())
  return m ? m[1].trim() : ''
}

export function mountCoordinationRoutes(
  app: Hono<{ Variables: { requestId: string } }>,
  deps: CoordinationRouteDeps = {},
) {
  const hub = deps.hub ?? deps.coordination ?? new CoordinationHub()
  const strictAuth =
    deps.requireAuth ??
    (Boolean(deps.resolveOwner) || process.env.NODE_ENV === 'production')

  const resolveCaller = (
    c: Context<{ Variables: { requestId: string } }>,
    fallbackOwner: string,
    opts: { mutate?: boolean } = {},
  ): { ok: true; owner: string } | { ok: false; status: 400 | 401 | 403; error: string } => {
    const token = bearerOf(c.req.header('Authorization'))

    if (deps.resolveOwner) {
      if (!token) {
        if (strictAuth) {
          return { ok: false, status: 401, error: 'Authentication required' }
        }
        if (!fallbackOwner) return { ok: false, status: 400, error: 'owner required' }
        return { ok: true, owner: fallbackOwner }
      }
      const owner = deps.resolveOwner(token)
      if (!owner) {
        return { ok: false, status: 401, error: 'Invalid or expired credentials' }
      }
      if (opts.mutate && deps.resolveRole) {
        const role = deps.resolveRole(token)
        if (role === 'viewer') {
          return { ok: false, status: 403, error: 'Insufficient role for coordination mutation' }
        }
      }
      return { ok: true, owner }
    }

    if (strictAuth) {
      return { ok: false, status: 401, error: 'Authentication required' }
    }
    if (!fallbackOwner) {
      return { ok: false, status: 400, error: 'owner required' }
    }
    return { ok: true, owner: fallbackOwner }
  }

  app.get('/coordination/health', (c) =>
    c.json({ ok: true, hub: 'CoordinationHub §12', ...hub.status(), timestamp: Date.now() }),
  )

  app.get('/coordination/status', (c) => {
    if (strictAuth && deps.resolveOwner) {
      const token = bearerOf(c.req.header('Authorization'))
      if (!token || !deps.resolveOwner(token)) {
        return c.json({ error: 'Authentication required' }, 401)
      }
    }
    return c.json({ ok: true, ...hub.status() })
  })

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
    const rawOwner = typeof body?.owner === 'string' ? body.owner.slice(0, 200) : ''
    const auth = resolveCaller(c, rawOwner, { mutate: true })
    if (!auth.ok) return c.json({ error: auth.error }, auth.status)
    if (!taskId) return c.json({ error: 'body.taskId and owner required' }, 400)

    const decision = hub.claimTask({
      taskId,
      owner: auth.owner,
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
    const rawOwner = c.req.query('owner') ?? ''
    const auth = resolveCaller(c, rawOwner, { mutate: true })
    if (!auth.ok) {
      return c.json(
        { error: auth.status === 400 ? 'query.owner required' : auth.error },
        auth.status,
      )
    }
    const rawToken = c.req.query('fencingToken')
    const fencingToken =
      rawToken !== undefined && rawToken !== '' && Number.isFinite(Number(rawToken))
        ? Number(rawToken)
        : undefined
    const r = hub.releaseTask(id, auth.owner, { fencingToken })
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
    const rawOwner = typeof body?.owner === 'string' ? body.owner.slice(0, 200) : ''
    const auth = resolveCaller(c, rawOwner, { mutate: true })
    if (!auth.ok) return c.json({ error: auth.error }, auth.status)

    const paths = Array.isArray(body?.paths)
      ? (body?.paths as unknown[]).map(String).slice(0, 100)
      : []
    if (paths.length === 0) return c.json({ error: 'body.owner and body.paths[] required' }, 400)

    const r = hub.lockFiles(auth.owner, paths, {
      taskId: typeof body?.taskId === 'string' ? body.taskId.slice(0, 200) : undefined,
      ttlMs: typeof body?.ttlMs === 'number' ? body.ttlMs : undefined,
    })
    return c.json({ ok: r.conflicts.length === 0, ...r }, r.conflicts.length === 0 ? 200 : 409)
  })

  app.delete('/coordination/locks', async (c) => {
    let body: {
      owner?: string
      paths?: string[]
      fencingToken?: number
      fencingTokens?: Record<string, number>
    } | null = null
    try {
      body = (await c.req.json()) as {
        owner?: string
        paths?: string[]
        fencingToken?: number
        fencingTokens?: Record<string, number>
      } | null
    } catch {
      body = null
    }
    const rawOwner = typeof body?.owner === 'string' ? body.owner.slice(0, 200) : ''
    const auth = resolveCaller(c, rawOwner, { mutate: true })
    if (!auth.ok) return c.json({ error: auth.error }, auth.status)

    const paths = Array.isArray(body?.paths)
      ? (body?.paths as unknown[]).map(String).slice(0, 100)
      : []
    if (paths.length === 0) return c.json({ error: 'body.owner and body.paths[] required' }, 400)

    const fencingTokens =
      typeof body?.fencingToken === 'number'
        ? body.fencingToken
        : body?.fencingTokens && typeof body.fencingTokens === 'object'
          ? body.fencingTokens
          : undefined
    const r = hub.unlockFiles(auth.owner, paths, { fencingTokens })
    return c.json({ ok: r.errors.length === 0, ...r }, r.errors.length === 0 ? 200 : 409)
  })

  app.post('/coordination/leases/renew', async (c) => {
    type RenewLeaseBody = {
      kind?: 'lock' | 'claim'
      owner?: string
      taskId?: string
      paths?: string[]
      fencingToken?: number
      fencingTokens?: Record<string, number>
      ttlMs?: number
    }
    let body: RenewLeaseBody | null = null
    try {
      body = (await c.req.json()) as RenewLeaseBody | null
    } catch {
      body = null
    }
    const rawOwner = typeof body?.owner === 'string' ? body.owner.slice(0, 200) : ''
    const auth = resolveCaller(c, rawOwner, { mutate: true })
    if (!auth.ok) return c.json({ error: auth.error }, auth.status)

    const kind = body?.kind === 'claim' ? 'claim' : body?.kind === 'lock' ? 'lock' : ''
    if (!kind) return c.json({ error: "body.kind ('lock' | 'claim') required" }, 400)

    if (kind === 'claim') {
      const taskId = typeof body?.taskId === 'string' ? body.taskId.slice(0, 200) : ''
      if (!taskId || typeof body?.fencingToken !== 'number') {
        return c.json({ error: 'body.taskId and numeric body.fencingToken required' }, 400)
      }
      const r = hub.renewTask(taskId, auth.owner, body.fencingToken, {
        ttlMs: typeof body?.ttlMs === 'number' ? body.ttlMs : undefined,
      })
      return c.json(r, r.ok ? 200 : 409)
    }

    const paths = Array.isArray(body?.paths)
      ? (body.paths as unknown[]).map(String).slice(0, 100)
      : []
    const tokens =
      typeof body?.fencingToken === 'number'
        ? body.fencingToken
        : body?.fencingTokens && typeof body.fencingTokens === 'object'
          ? body.fencingTokens
          : undefined
    if (paths.length === 0 || tokens === undefined) {
      return c.json({ error: 'body.paths[] and fencingToken/fencingTokens required' }, 400)
    }
    const r = hub.renewLocks(auth.owner, paths, tokens, {
      ttlMs: typeof body?.ttlMs === 'number' ? body.ttlMs : undefined,
    })
    const ok = r.errors.length === 0 && r.renewed.length === paths.length
    return c.json({ ok, ...r }, ok ? 200 : 409)
  })

  app.post('/coordination/writes', async (c) => {
    let body: {
      path?: string
      hash?: string
      owner?: string
      fencingToken?: number
      requireFencing?: boolean
    } | null = null
    try {
      body = (await c.req.json()) as {
        path?: string
        hash?: string
        owner?: string
        fencingToken?: number
        requireFencing?: boolean
      } | null
    } catch {
      body = null
    }
    const path = typeof body?.path === 'string' ? body.path.slice(0, 500) : ''
    const hash = typeof body?.hash === 'string' ? body.hash.slice(0, 64) : ''
    const rawOwner = typeof body?.owner === 'string' ? body.owner.slice(0, 200) : ''
    const auth = resolveCaller(c, rawOwner, { mutate: true })
    if (!auth.ok) return c.json({ error: auth.error }, auth.status)
    if (!path || !hash) return c.json({ error: 'body.path, body.hash, owner required' }, 400)

    try {
      const w = hub.recordWrite(path, hash, auth.owner, {
        fencingToken: typeof body?.fencingToken === 'number' ? body.fencingToken : undefined,
        requireFencing: body?.requireFencing === true,
      })
      return c.json({ ok: true, write: w })
    } catch (err) {
      if (err instanceof FencingTokenError) {
        return c.json(
          {
            ok: false,
            error: err.message,
            code: err.code,
            holder: err.holder,
            expectedToken: err.expectedToken,
            providedToken: err.providedToken,
          },
          409,
        )
      }
      throw err
    }
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
    const rawOwner = typeof body?.owner === 'string' ? body.owner.slice(0, 200) : ''
    const auth = resolveCaller(c, rawOwner)
    if (!auth.ok) return c.json({ error: auth.error }, auth.status)
    if (!path || !baseHash)
      return c.json({ error: 'body.path, body.baseHash, owner required' }, 400)
    const r = hub.patchConflicts(path, baseHash, auth.owner)
    return c.json({ ok: !r.stale, ...r }, r.stale ? 409 : 200)
  })

  app.post('/coordination/transactions', async (c) => {
    let body: { owner?: string; paths?: string[]; taskIds?: string[] } | null = null
    try {
      body = (await c.req.json()) as { owner?: string; paths?: string[]; taskIds?: string[] } | null
    } catch {
      body = null
    }
    const rawOwner = typeof body?.owner === 'string' ? body.owner.slice(0, 200) : ''
    const auth = resolveCaller(c, rawOwner, { mutate: true })
    if (!auth.ok) return c.json({ error: auth.error }, auth.status)
    const paths = Array.isArray(body?.paths) ? body.paths.map(String).slice(0, 100) : []
    if (paths.length === 0) return c.json({ error: 'body.owner and body.paths[] required' }, 400)
    const r = hub.beginTransaction(
      auth.owner,
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
    const rawOwner = typeof body?.owner === 'string' ? body.owner.slice(0, 200) : ''
    const auth = resolveCaller(c, rawOwner, { mutate: true })
    if (!auth.ok) return c.json({ error: auth.error }, auth.status)
    const r = hub.commit(c.req.param('id'), auth.owner)
    return c.json({ ok: r.ok, error: r.error }, r.ok ? 200 : 409)
  })

  app.post('/coordination/transactions/:id/abort', async (c) => {
    let body: { owner?: string } | null = null
    try {
      body = (await c.req.json()) as { owner?: string } | null
    } catch {
      body = null
    }
    const rawOwner = typeof body?.owner === 'string' ? body.owner.slice(0, 200) : ''
    const auth = resolveCaller(c, rawOwner, { mutate: true })
    if (!auth.ok) return c.json({ error: auth.error }, auth.status)
    const r = hub.abort(c.req.param('id'), auth.owner)
    return c.json({ ok: r.ok, error: r.error }, r.ok ? 200 : 409)
  })
}
