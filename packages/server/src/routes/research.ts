import type { Hono, Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import {
  OnlineResearchService,
  resolveResearchGeminiKey,
  type ResearchPlanTrack,
  type ResearchRunDTO,
} from '../research/online-research.js'

const startSchema = z.object({
  query: z.string().min(1).max(4000),
  mode: z.enum(['quick-grounded', 'deep-investigation']).optional(),
  autoRun: z.boolean().optional(),
  sessionID: z.string().nullable().optional(),
  branchSessionID: z.string().nullable().optional(),
})

const approveSchema = z.object({
  plan: z
    .array(
      z.object({
        id: z.string(),
        title: z.string().min(1),
        query: z.string().min(1),
        focus: z.string().default(''),
      }),
    )
    .optional(),
})

const promoteSchema = z.object({
  title: z.string().optional(),
})

import type { Role } from '../auth/roles.js'

export function mountResearchRoutes(
  app: Hono<{ Variables: { requestId: string } }>,
  deps: {
    service: OnlineResearchService
    resolveOwner?: (t: string) => string | undefined
    bearerOf?: (header?: string) => string
    orgOfOwner?: (owner: string) => string | undefined
    resolveRole?: (t: string) => Role
    requireAuth?: boolean
  },
) {
  const bearerFrom = (c: Context) => {
    const h = c.req.header('Authorization')
    if (deps.bearerOf) return deps.bearerOf(h)
    return h?.startsWith('Bearer ') ? h.slice(7).trim() : ''
  }

  const callerOwner = (c: Context) => {
    if (!deps.resolveOwner) return undefined
    return deps.resolveOwner(bearerFrom(c))
  }

  const callerRole = (c: Context): Role | undefined => {
    if (!deps.resolveRole) return undefined
    const tok = bearerFrom(c)
    if (!tok) return undefined
    return deps.resolveRole(tok)
  }

  const authRequired = () =>
    Boolean(deps.requireAuth || deps.resolveOwner || process.env.NODE_ENV === 'production')

  const requireAuthenticated = (
    c: Context,
  ): { ok: true; ownerID: string | undefined; orgID: string | undefined; role: Role | undefined } | { ok: false; res: Response } => {
    const ownerID = callerOwner(c)
    if (authRequired() && !ownerID) {
      return { ok: false, res: c.json({ error: 'Authentication required' }, 401) }
    }
    const orgID = ownerID && deps.orgOfOwner ? deps.orgOfOwner(ownerID) : undefined
    const role = ownerID ? callerRole(c) : undefined
    return { ok: true, ownerID, orgID, role }
  }

  const requireWritableRole = (c: Context, role: Role | undefined): Response | null => {
    if (role === 'viewer') {
      return c.json({ error: 'forbidden: viewer role is read-only' }, 403)
    }
    return null
  }

  const canAccessRun = (
    ownerID: string | undefined,
    orgID: string | undefined,
    role: Role | undefined,
    run: ResearchRunDTO | null,
  ): run is ResearchRunDTO => {
    if (!run) return false
    if (authRequired() && !ownerID) return false
    if (!run.ownerID) {
      // Quarantine legacy ownerless records: never exposed silently to non-admin callers.
      return role === 'admin'
    }
    if (!ownerID) return !authRequired()
    if (run.ownerID === ownerID) {
      return !run.orgID || !orgID || run.orgID === orgID
    }
    return Boolean(run.orgID && orgID && run.orgID === orgID)
  }

  app.get('/research/status', (c: Context) => {
    const auth = requireAuthenticated(c)
    if (!auth.ok) return auth.res
    const geminiConfigured = Boolean(resolveResearchGeminiKey())
    const firecrawlConfigured = Boolean(process.env.FIRECRAWL_API_KEY)
    const tavilyConfigured = Boolean(process.env.TAVILY_API_KEY)
    return c.json({
      ok: true,
      modes: ['quick-grounded', 'deep-investigation'],
      groundingProvider: geminiConfigured
        ? 'gemini-google-search'
        : firecrawlConfigured
          ? 'firecrawl'
          : tavilyConfigured
            ? 'tavily'
            : 'duckduckgo',
      geminiConfigured,
    })
  })

  app.get('/research/runs', async (c: Context) => {
    const auth = requireAuthenticated(c)
    if (!auth.ok) return auth.res
    const sessionID = c.req.query('sessionId') ?? c.req.query('sessionID') ?? undefined
    const includeLegacy = c.req.query('includeLegacy') === '1'
    const runs = await deps.service.listRuns({
      sessionID,
      ownerID: auth.ownerID,
      orgID: auth.orgID ?? null,
      isAdmin: auth.role === 'admin',
      includeLegacy,
      strictOwnership: authRequired(),
    })
    return c.json({ ok: true, runs })
  })

  app.get('/research/runs/:id', async (c: Context) => {
    const auth = requireAuthenticated(c)
    if (!auth.ok) return auth.res
    const id = c.req.param('id') ?? ''
    if (!id) return c.json({ error: 'Missing run ID' }, 400)
    const run = await deps.service.getRun(id)
    if (!canAccessRun(auth.ownerID, auth.orgID, auth.role, run)) {
      return c.json({ error: 'Research run not found' }, 404)
    }
    return c.json({ ok: true, run })
  })

  app.get('/research/runs/:id/stream', async (c: Context) => {
    const auth = requireAuthenticated(c)
    if (!auth.ok) return auth.res
    const id = c.req.param('id') ?? ''
    if (!id) return c.json({ error: 'Missing run ID' }, 400)
    const run = await deps.service.getRun(id)
    if (!canAccessRun(auth.ownerID, auth.orgID, auth.role, run)) {
      return c.json({ error: 'Research run not found' }, 404)
    }

    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        event: 'snapshot',
        data: JSON.stringify({ type: 'snapshot', run }),
      })
      if (['completed', 'failed', 'cancelled'].includes(run.status)) {
        await stream.writeSSE({ event: 'done', data: JSON.stringify({ type: 'done', run }) })
        return
      }
      await new Promise<void>((resolve) => {
        const unsub = deps.service.subscribe(id, (ev) => {
          void stream
            .writeSSE({
              event: ev.type,
              data: JSON.stringify(ev),
            })
            .catch(() => {})
          if (['completed', 'failed', 'cancelled'].includes(ev.run.status) || ev.type === 'done') {
            unsub()
            resolve()
          }
        })
        c.req.raw.signal.addEventListener(
          'abort',
          () => {
            unsub()
            resolve()
          },
          { once: true },
        )
      })
    })
  })

  app.post('/research/runs', async (c: Context) => {
    const auth = requireAuthenticated(c)
    if (!auth.ok) return auth.res
    const roleErr = requireWritableRole(c, auth.role)
    if (roleErr) return roleErr
    const parsed = startSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json({ error: 'Invalid research request', issues: parsed.error.issues }, 400)
    }
    const ownerID = auth.ownerID ?? null
    const orgID = auth.orgID ?? null
    try {
      const run = await deps.service.startRun({
        ...parsed.data,
        ownerID,
        orgID,
      })
      return c.json({ ok: true, run }, 201)
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400)
    }
  })

  app.post('/research/runs/:id/approve', async (c: Context) => {
    const auth = requireAuthenticated(c)
    if (!auth.ok) return auth.res
    const roleErr = requireWritableRole(c, auth.role)
    if (roleErr) return roleErr
    const id = c.req.param('id') ?? ''
    if (!id) return c.json({ error: 'Missing run ID' }, 400)
    const existing = await deps.service.getRun(id)
    if (!canAccessRun(auth.ownerID, auth.orgID, auth.role, existing)) {
      return c.json({ error: 'Research run not found' }, 404)
    }
    const parsed = approveSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      return c.json({ error: 'Invalid plan payload', issues: parsed.error.issues }, 400)
    }
    try {
      const run = await deps.service.approveAndRun(id, parsed.data.plan as ResearchPlanTrack[] | undefined)
      return c.json({ ok: true, run })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const status = /cannot be started/i.test(msg) ? 409 : 400
      return c.json({ error: msg }, status)
    }
  })

  app.post('/research/runs/:id/cancel', async (c: Context) => {
    const auth = requireAuthenticated(c)
    if (!auth.ok) return auth.res
    const roleErr = requireWritableRole(c, auth.role)
    if (roleErr) return roleErr
    const id = c.req.param('id') ?? ''
    if (!id) return c.json({ error: 'Missing run ID' }, 400)
    const existing = await deps.service.getRun(id)
    if (!canAccessRun(auth.ownerID, auth.orgID, auth.role, existing)) {
      return c.json({ error: 'Research run not found' }, 404)
    }
    const run = await deps.service.cancelRun(id)
    if (!run) return c.json({ error: 'Research run not found' }, 404)
    return c.json({ ok: true, run })
  })

  app.post('/research/runs/:id/promote-memory', async (c: Context) => {
    const auth = requireAuthenticated(c)
    if (!auth.ok) return auth.res
    const roleErr = requireWritableRole(c, auth.role)
    if (roleErr) return roleErr
    const id = c.req.param('id') ?? ''
    if (!id) return c.json({ error: 'Missing run ID' }, 400)
    const existing = await deps.service.getRun(id)
    if (!canAccessRun(auth.ownerID, auth.orgID, auth.role, existing)) {
      return c.json({ error: 'Research run not found' }, 404)
    }
    const parsed = promoteSchema.safeParse(await c.req.json().catch(() => ({})))
    try {
      const entry = await deps.service.promoteRunToMemory(
        id,
        parsed.success ? parsed.data.title : undefined,
      )
      return c.json({ ok: true, entry }, 201)
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400)
    }
  })
}
