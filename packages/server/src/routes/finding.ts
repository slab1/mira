import type { Hono, Context } from 'hono'
import type { MiraDB } from '../storage/db.js'
import type { Bus } from '../bus/index.js'
import type { FindingSeverity } from '../tools/findings.js'
import { writeFinding, listFindings, resolveFinding } from '../tools/findings.js'
import { z } from 'zod'

const findingSchema = z.object({
  title: z.string().min(1).max(500),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  evidence: z.string().max(10000).optional(),
  source: z.string().max(200).optional(),
  sessionID: z.string().optional(),
})

export function mountFindingRoutes(
  app: Hono<{ Variables: { requestId: string } }>,
  deps: { db: MiraDB; bus: Bus },
) {
  const { db, bus } = deps

  app.get('/finding', async (c: Context) => {
    const status = c.req.query('status') as 'open' | 'resolved' | undefined
    const severity = c.req.query('severity') as FindingSeverity | undefined
    const limit = Number(c.req.query('limit') ?? '') || undefined
    return c.json(await listFindings(db, { status, severity, limit }))
  })

  app.post('/finding', async (c: Context) => {
    const parsed = findingSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid finding',
          issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        },
        400,
      )
    }
    const body = parsed.data
    const f = await writeFinding(db, {
      title: body.title.trim(),
      severity: body.severity,
      evidence: body.evidence,
      source: body.source ?? 'user',
      sessionID: body.sessionID ?? null,
    })
    bus.publish({
      type: 'job.updated',
      payload: { finding: f.id, action: 'created' },
      timestamp: Date.now(),
    })
    return c.json(f, 201)
  })

  app.post('/finding/:id/resolve', async (c: Context) => {
    const fid = c.req.param('id')
    if (!fid) return c.json({ error: 'not found' }, 404)
    const f = await resolveFinding(db, fid)
    if (!f) return c.json({ error: 'not found' }, 404)
    bus.publish({
      type: 'job.updated',
      payload: { finding: f.id, action: 'resolved' },
      timestamp: Date.now(),
    })
    return c.json(f)
  })
}
