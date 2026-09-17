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

const SAFE_PROFILE_KEYS = new Set(['bio', 'avatar', 'theme', 'locale'])
const SECRET_PROFILE_RE = /(secret|token|password|credential|api[_-]?key|bearer)/i

function sanitizeProfile(profile: unknown): Record<string, unknown> | null {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return null
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(profile as Record<string, unknown>)) {
    if (SECRET_PROFILE_RE.test(k)) continue
    if (!SAFE_PROFILE_KEYS.has(k) && typeof v === 'string' && v.length > 200) continue
    out[k] = v
  }
  return Object.keys(out).length ? out : null
}

function sanitizeUser(
  user: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!user || typeof user !== 'object') return null
  const { profile, ...rest } = user as Record<string, unknown>
  const safeProfile = sanitizeProfile(profile)
  return { ...rest, profile: safeProfile }
}

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
    const safe = sanitizeUser(user)
    return c.json(safe)
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
    return c.json(sanitizeUser(updated))
  })
}
