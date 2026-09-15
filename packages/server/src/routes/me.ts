/**
 * Routes — /me (Lane B: user identity)
 *
 *   GET  /me   → upsert + return the authenticated user's profile
 *   PATCH /me  → update the display name (1-50 chars, trimmed, non-empty)
 *
 * Auth: the middleware gate already rejects unauthenticated requests (401);
 * here we additionally resolve the owner from the bearer token — a request
 * that passes the gate always has one, but we 401 defensively.
 */
import type { Hono, Context } from 'hono'
import { eq } from 'drizzle-orm'
import type { MiraDB } from '../storage/db.js'
import { getUserByOwner } from '../storage/users.js'

const NAME_MAX = 50

export function mountMeRoutes(
  app: Hono<{ Variables: { requestId: string } }>,
  deps: {
    db: MiraDB
    resolveOwner: (t: string) => string | undefined
    bearerOf: (h?: string) => string
  },
) {
  const { db } = deps

  app.get('/me', async (c: Context) => {
    const owner = deps.resolveOwner(deps.bearerOf(c.req.header('Authorization')))
    if (!owner) return c.json({ error: 'unauthorized' }, 401)
    const user = await getUserByOwner(db, owner)
    return c.json(user)
  })

  app.patch('/me', async (c: Context) => {
    const owner = deps.resolveOwner(deps.bearerOf(c.req.header('Authorization')))
    if (!owner) return c.json({ error: 'unauthorized' }, 401)
    const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null
    const raw = body?.name
    if (typeof raw !== 'string') {
      return c.json({ error: 'name must be a string' }, 400)
    }
    const name = raw.trim()
    if (!name) {
      return c.json({ error: 'name must not be empty' }, 400)
    }
    if (name.length > NAME_MAX) {
      return c.json({ error: `name must be at most ${NAME_MAX} characters` }, 400)
    }
    const user = await getUserByOwner(db, owner)
    const updated = {
      ...user,
      name,
      updatedAt: Date.now(),
    }
    await db
      .update(db.schema.users)
      .set({ name, updatedAt: updated.updatedAt })
      .where(eq(db.schema.users.owner, owner))
    return c.json(updated)
  })
}
