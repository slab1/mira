import type { Hono, Context } from 'hono'
import { z } from 'zod'
import type { MiraDB } from '../storage/db.js'
import {
  generateReviewCoverageManifest,
  getReviewManifestById,
  listReviewManifests,
  updateReviewManifest,
  ReviewDispositionSchema,
  ReviewFindingSchema,
  ReviewSectionIdSchema,
} from '../review/coverage.js'

const generateSchema = z.object({
  sessionID: z.string().min(1),
  baseRef: z.string().optional(),
  headRef: z.string().optional(),
})

const patchSchema = z.object({
  section: z
    .object({
      id: ReviewSectionIdSchema,
      disposition: ReviewDispositionSchema,
      reason: z.string().optional(),
      evidenceRefs: z.array(z.string()).optional(),
    })
    .optional(),
  item: z
    .object({
      id: z.string(),
      disposition: ReviewDispositionSchema,
      reason: z.string().optional(),
      evidenceRefs: z.array(z.string()).optional(),
      testCommand: z.string().optional(),
    })
    .optional(),
  finding: ReviewFindingSchema.optional(),
})

export function mountReviewRoutes(
  app: Hono<{ Variables: { requestId: string } }>,
  deps: {
    db: MiraDB
    authorizedSession: (id: string, c: Context) => Promise<unknown | null>
  },
) {
  app.get('/review/coverage', async (c: Context) => {
    const sessionId = c.req.query('sessionId') ?? c.req.query('sessionID') ?? undefined
    if (sessionId) {
      const s = await deps.authorizedSession(sessionId, c)
      if (!s) return c.json({ error: 'Session not found' }, 404)
    }
    const manifests = await listReviewManifests(deps.db, sessionId, 20)
    return c.json({ ok: true, manifests })
  })

  app.get('/review/coverage/session/:sessionId', async (c: Context) => {
    const sessionId = c.req.param('sessionId') ?? ''
    if (!sessionId) return c.json({ error: 'Missing session ID' }, 400)
    const s = await deps.authorizedSession(sessionId, c)
    if (!s) return c.json({ error: 'Session not found' }, 404)
    const manifests = await listReviewManifests(deps.db, sessionId, 10)
    return c.json({ ok: true, latest: manifests[0] ?? null, manifests })
  })

  app.post('/review/coverage/generate', async (c: Context) => {
    const parsed = generateSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json({ error: 'Invalid generate payload', issues: parsed.error.issues }, 400)
    }
    const s = (await deps.authorizedSession(parsed.data.sessionID, c)) as { cwd?: string | null } | null
    if (!s) return c.json({ error: 'Session not found' }, 404)
    const manifest = await generateReviewCoverageManifest({
      db: deps.db,
      sessionID: parsed.data.sessionID,
      cwd: s.cwd ?? undefined,
      baseRef: parsed.data.baseRef,
      headRef: parsed.data.headRef,
    })
    return c.json({ ok: true, manifest }, 201)
  })

  app.patch('/review/coverage/:id', async (c: Context) => {
    const id = c.req.param('id') ?? ''
    if (!id) return c.json({ error: 'Missing manifest ID' }, 400)
    const existing = await getReviewManifestById(deps.db, id)
    if (!existing) return c.json({ error: 'Manifest not found' }, 404)
    const s = await deps.authorizedSession(existing.sessionID, c)
    if (!s) return c.json({ error: 'Manifest not found' }, 404)
    const parsed = patchSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json({ error: 'Invalid patch payload', issues: parsed.error.issues }, 400)
    }
    const updated = await updateReviewManifest(deps.db, id, parsed.data)
    return c.json({ ok: true, manifest: updated })
  })
}
