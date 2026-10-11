import type { Hono, Context } from 'hono'
import type { MiraDB } from '../storage/db.js'
import type { Bus } from '../bus/index.js'
import type { FindingSeverity } from '../tools/findings.js'
import { writeFinding, listFindings, resolveFinding } from '../tools/findings.js'
import { z } from 'zod'

const findingSchema = z.object({
  title: z.string().min(1).max(500),
  severity: z.enum(['info', 'minor', 'major', 'critical']),
  evidence: z.string().max(10000).optional(),
  source: z.enum(['agent', 'tool', 'user']).optional(),
  sessionID: z.string().optional(),
})

export function mountFindingRoutes(
  app: Hono<{ Variables: { requestId: string } }>,
  deps: {
    db: MiraDB
    bus: Bus
    /** Owner of a session, or null for legacy/unknown (P3.3 tenancy gate) */
    ownerOfSession?: (id: string) => Promise<string | null>
    /** Org of a session, or null when orgless (P3.3 tenancy gate) */
    orgOfSession?: (id: string) => Promise<string | null>
    /** Org of the calling owner, or undefined when orgless */
    orgOfOwner?: (owner: string | null | undefined) => string | undefined
    resolveOwner?: (t: string) => string | undefined
    bearerOf?: (h?: string) => string
    /** Ownership active only when API keys exist (same predicate as session routes) */
    OWNERSHIP_ENABLED?: boolean | (() => boolean)
  },
) {
  const { db, bus } = deps
  const ownershipOn = () =>
    typeof deps.OWNERSHIP_ENABLED === 'function'
      ? (deps.OWNERSHIP_ENABLED as () => boolean)()
      : !!deps.OWNERSHIP_ENABLED

  const callerOf = (c: Context): string | undefined =>
    ownershipOn()
      ? deps.resolveOwner?.(deps.bearerOf?.(c.req.header('Authorization')) ?? '')
      : undefined

  /**
   * A finding is visible when its session is (P3.3 rule): ownerless session →
   * shared; owner match; else same-org. Findings with no session at all are
   * caller-independent (they are not attributable) — kept visible as before.
   */
  const findingVisible = async (
    f: { sessionID: string | null },
    caller: string | undefined,
  ): Promise<boolean> => {
    if (!caller || !f.sessionID || !deps.ownerOfSession || !deps.orgOfSession) return true
    const owner = await deps.ownerOfSession(f.sessionID)
    if (owner === null) return true
    if (owner === caller) return true
    const org = await deps.orgOfSession(f.sessionID)
    return org != null && deps.orgOfOwner?.(caller) === org
  }

  app.get('/finding', async (c: Context) => {
    const status = c.req.query('status') as 'open' | 'resolved' | undefined
    const severity = c.req.query('severity') as FindingSeverity | undefined
    const limit = Number(c.req.query('limit') ?? '') || undefined
    const caller = callerOf(c)
    const all = await listFindings(db, { status, severity, limit })
    if (!caller) return c.json(all)
    const visible: Awaited<ReturnType<typeof listFindings>> = []
    for (const f of all) if (await findingVisible(f, caller)) visible.push(f)
    return c.json(visible)
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
    // A finding may only be attached to a session the caller can reach.
    if (body.sessionID && callerOf(c)) {
      const session = await deps.ownerOfSession?.(body.sessionID)
      const visible = await findingVisible({ sessionID: body.sessionID }, callerOf(c))
      if (!visible || session === undefined) return c.json({ error: 'not found' }, 404)
    }
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
    const caller = callerOf(c)
    if (caller && deps.ownerOfSession) {
      // Resolve-by-id needs a lookup, then the same visibility gate.
      const existing = await listFindings(db, { limit: 1000 })
      const target = existing.find((x) => x.id === fid)
      if (target && !(await findingVisible(target, caller)))
        return c.json({ error: 'not found' }, 404)
    }
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
