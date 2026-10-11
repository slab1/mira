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
    /** RBAC (P3.1): exposed as `role` in GET /me so clients can adapt their UI */
    resolveRole?: (t: string) => import('../auth/roles.js').Role
    bearerOf: (h?: string) => string
    /** Org tenancy (P3.3) — live membership maps; when absent, GET /me
     *  reports `org: null` (single membership per owner). */
    ORG_NAMES?: Map<string, string>
    ORG_MEMBERS?: Map<string, import('./orgs.js').OrgMembership>
  },
) {
  const { db } = deps

  /** Live org membership for the caller — null when orgless or maps unwired. */
  const orgOf = (owner: string) => {
    const m = deps.ORG_MEMBERS?.get(owner)
    if (!m) return null
    return { id: m.org, name: deps.ORG_NAMES?.get(m.org) ?? '', role: m.role }
  }

  app.get('/me', async (c: Context) => {
    const bearer = deps.bearerOf(c.req.header('Authorization'))
    const owner = deps.resolveOwner(bearer)
    if (!owner) return c.json({ error: 'unauthorized' }, 401)
    const user = await getUserByOwner(db, owner)
    const safe = sanitizeUser(user)
    const org = orgOf(owner)
    if (deps.resolveRole) return c.json({ ...safe, role: deps.resolveRole(bearer), org })
    return c.json({ ...safe, org })
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
