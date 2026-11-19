import type { Hono, Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import {
  OnlineResearchService,
  resolveResearchGeminiKey,
  type ResearchPlanTrack,
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

export function mountResearchRoutes(
  app: Hono<{ Variables: { requestId: string } }>,
  deps: {
    service: OnlineResearchService
    resolveOwner?: (t: string) => string | undefined
    bearerOf?: (header?: string) => string
    orgOfOwner?: (owner: string) => string | undefined
  },
) {
  const callerOwner = (c: Context) =>
    deps.resolveOwner && deps.bearerOf
      ? deps.resolveOwner(deps.bearerOf(c.req.header('Authorization')))
      : undefined

  app.get('/research/status', (c: Context) => {
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
    const sessionID = c.req.query('sessionId') ?? c.req.query('sessionID') ?? undefined
    const ownerID = callerOwner(c)
    const runs = await deps.service.listRuns({ sessionID, ownerID })
    return c.json({ ok: true, runs })
  })

  app.get('/research/runs/:id', async (c: Context) => {
    const id = c.req.param('id') ?? ''
    if (!id) return c.json({ error: 'Missing run ID' }, 400)
    const run = await deps.service.getRun(id)
    if (!run) return c.json({ error: 'Research run not found' }, 404)
    const ownerID = callerOwner(c)
    if (ownerID && run.ownerID && run.ownerID !== ownerID) {
      return c.json({ error: 'Research run not found' }, 404)
    }
    return c.json({ ok: true, run })
  })

  app.get('/research/runs/:id/stream', async (c: Context) => {
    const id = c.req.param('id') ?? ''
    if (!id) return c.json({ error: 'Missing run ID' }, 400)
    const run = await deps.service.getRun(id)
    if (!run) return c.json({ error: 'Research run not found' }, 404)

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
    const parsed = startSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json({ error: 'Invalid research request', issues: parsed.error.issues }, 400)
    }
    const ownerID = callerOwner(c) ?? null
    const orgID = ownerID && deps.orgOfOwner ? (deps.orgOfOwner(ownerID) ?? null) : null
    const run = await deps.service.startRun({
      ...parsed.data,
      ownerID,
      orgID,
    })
    return c.json({ ok: true, run }, 201)
  })

  app.post('/research/runs/:id/approve', async (c: Context) => {
    const id = c.req.param('id') ?? ''
    if (!id) return c.json({ error: 'Missing run ID' }, 400)
    const parsed = approveSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      return c.json({ error: 'Invalid plan payload', issues: parsed.error.issues }, 400)
    }
    try {
      const run = await deps.service.approveAndRun(id, parsed.data.plan as ResearchPlanTrack[] | undefined)
      return c.json({ ok: true, run })
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 404)
    }
  })

  app.post('/research/runs/:id/cancel', async (c: Context) => {
    const id = c.req.param('id') ?? ''
    if (!id) return c.json({ error: 'Missing run ID' }, 400)
    const run = await deps.service.cancelRun(id)
    if (!run) return c.json({ error: 'Research run not found' }, 404)
    return c.json({ ok: true, run })
  })

  app.post('/research/runs/:id/promote-memory', async (c: Context) => {
    const id = c.req.param('id') ?? ''
    if (!id) return c.json({ error: 'Missing run ID' }, 400)
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
