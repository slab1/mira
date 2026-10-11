/**
 * Org tenancy routes (P3.3) — orgs group owners so they share session
 * visibility (a session stamped with the org is readable by the owner and
 * same-org members, REST + WS).
 *
 * Access model:
 *   - create org            → platform admin (RBAC 'admin')
 *   - manage membership     → the org's 'admin' members, or platform admin
 *   - read org / my orgs    → org members
 *
 * Orgs only matter when per-user ownership is active; without a resolvable
 * owner there is nothing to group, so all routes 401 in open mode (unlike
 * /admin, no loopback exception — orgs are a multi-user feature by design).
 *
 * In-memory mirrors (ORG_NAMES / ORG_MEMBERS) are the live access-control
 * source; DB is durable storage. Mutations update both, mirroring the
 * API_KEY_OWNERS pattern in routes/admin.ts.
 */
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Hono } from 'hono'
import type { MiraDB } from '../storage/db.js'
import type { Role } from '../auth/roles.js'
import {
  addOrgMember,
  createOrg,
  findOrgMember,
  getOrg,
  getOrgByName,
  isOrgRole,
  listOrgMembers,
  removeOrgMember,
  type OrgRole,
} from '../storage/orgs.js'

const orgNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9 ._-]+$/, 'name must be alphanumeric, dot, underscore, space or hyphen')
const ownerSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9._-]+$/, 'owner must be alphanumeric, dot, underscore or hyphen')

/** owner → the single membership (UNIQUE(owner) in org_members). */
export type OrgMembership = { org: string; role: OrgRole }

export function mountOrgRoutes(
  app: Hono<{ Variables: { requestId: string } }>,
  deps: {
    db: MiraDB
    /** orgId → name — presence also marks the org as live */
    ORG_NAMES: Map<string, string>
    /** owner → membership — the live access-control map */
    ORG_MEMBERS: Map<string, OrgMembership>
    resolveOwner: (t: string) => string | undefined
    resolveRole: (t: string) => Role
    bearerOf: (h?: string) => string
  },
) {
  const { db, ORG_NAMES, ORG_MEMBERS, resolveOwner, resolveRole, bearerOf } = deps

  const callerOf = (c: { req: { header: (n: string) => string | undefined } }) =>
    resolveOwner(bearerOf(c.req.header('Authorization')))

  const isPlatformAdmin = (c: { req: { header: (n: string) => string | undefined } }): boolean =>
    resolveRole(bearerOf(c.req.header('Authorization'))) === 'admin'

  /** Org admin (org-scoped role) or platform admin. Caller must be authenticated. */
  const canManageOrg = async (
    c: { req: { header: (n: string) => string | undefined } },
    orgID: string,
    caller: string,
  ): Promise<boolean> => {
    if (isPlatformAdmin(c)) return true
    const m = ORG_MEMBERS.get(caller)
    return m?.org === orgID && m.role === 'admin'
  }

  // ── POST /orgs — create an org (platform admin) ──────────────────
  app.post('/orgs', async (c) => {
    const caller = callerOf(c)
    if (!caller) return c.json({ error: 'unauthorized' }, 401)
    if (!isPlatformAdmin(c)) return c.json({ error: 'admin role required' }, 403)
    const parsed = z
      .object({ name: orgNameSchema, adminOwner: ownerSchema.optional() })
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success)
      return c.json(
        { error: 'invalid org', issues: parsed.error.issues.map((i) => i.message) },
        400,
      )
    const { name, adminOwner } = parsed.data
    if (await getOrgByName(db, name)) return c.json({ error: 'org name already taken' }, 409)
    const org = await createOrg(db, { name, createdBy: caller })
    const firstAdmin = adminOwner ?? caller
    try {
      await addOrgMember(db, { orgID: org.id, owner: firstAdmin, role: 'admin' })
    } catch {
      // UNIQUE(owner) — the designated admin is already in another org
      await db.delete(db.schema.orgs).where(eq(db.schema.orgs.id, org.id))
      return c.json({ error: `'${firstAdmin}' already belongs to another org` }, 409)
    }
    ORG_NAMES.set(org.id, org.name)
    ORG_MEMBERS.set(firstAdmin, { org: org.id, role: 'admin' })
    return c.json({ org, admin: { owner: firstAdmin, role: 'admin' } }, 201)
  })

  // ── GET /orgs — the caller's org (single membership per owner) ────
  app.get('/orgs', async (c) => {
    const caller = callerOf(c)
    if (!caller) return c.json({ error: 'unauthorized' }, 401)
    const m = ORG_MEMBERS.get(caller)
    if (!m) return c.json({ org: null })
    return c.json({ org: { id: m.org, name: ORG_NAMES.get(m.org) ?? '', role: m.role } })
  })

  // ── GET /orgs/:id — org detail + members (members / platform admin) ──
  app.get('/orgs/:id', async (c) => {
    const caller = callerOf(c)
    if (!caller) return c.json({ error: 'unauthorized' }, 401)
    const id = c.req.param('id')
    const org = await getOrg(db, id)
    if (!org) return c.json({ error: 'not found' }, 404)
    const m = ORG_MEMBERS.get(caller)
    const member = m?.org === id
    if (!member && !isPlatformAdmin(c)) return c.json({ error: 'not found' }, 404)
    const members = await listOrgMembers(db, id)
    return c.json({
      org,
      callerRole: member ? m!.role : 'admin',
      members: members.map((row) => ({
        owner: row.owner,
        role: isOrgRole(row.role) ? row.role : 'member',
        createdAt: row.createdAt,
      })),
    })
  })

  // ── POST /orgs/:id/members — add a member (org admin / platform admin) ──
  app.post('/orgs/:id/members', async (c) => {
    const caller = callerOf(c)
    if (!caller) return c.json({ error: 'unauthorized' }, 401)
    const id = c.req.param('id')
    const org = await getOrg(db, id)
    if (!org) return c.json({ error: 'not found' }, 404)
    if (!(await canManageOrg(c, id, caller))) return c.json({ error: 'org admin required' }, 403)
    const parsed = z
      .object({ owner: ownerSchema, role: z.enum(['admin', 'member']).optional() })
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success)
      return c.json(
        { error: 'invalid member', issues: parsed.error.issues.map((i) => i.message) },
        400,
      )
    const { owner, role } = parsed.data
    const sameOrg = await findOrgMember(db, id, owner)
    if (sameOrg) return c.json({ error: `'${owner}' is already a member of this org` }, 409)
    if (ORG_MEMBERS.has(owner) && ORG_MEMBERS.get(owner)!.org !== id)
      return c.json({ error: `'${owner}' already belongs to another org` }, 409)
    try {
      const row = await addOrgMember(db, { orgID: id, owner, role: role ?? 'member' })
      ORG_MEMBERS.set(owner, { org: id, role: row.role })
      return c.json({ member: { owner, role: row.role, createdAt: row.createdAt } }, 201)
    } catch {
      // UNIQUE(owner) race with another org's insert
      return c.json({ error: `'${owner}' already belongs to another org` }, 409)
    }
  })

  // ── DELETE /orgs/:id/members/:owner — remove a member ─────────────
  app.delete('/orgs/:id/members/:owner', async (c) => {
    const caller = callerOf(c)
    if (!caller) return c.json({ error: 'unauthorized' }, 401)
    const id = c.req.param('id')
    const owner = c.req.param('owner')
    const org = await getOrg(db, id)
    if (!org) return c.json({ error: 'not found' }, 404)
    if (!(await canManageOrg(c, id, caller))) return c.json({ error: 'org admin required' }, 403)
    const target = await findOrgMember(db, id, owner)
    if (!target) return c.json({ error: 'not found' }, 404)
    // Never orphan the org: the last org admin cannot be removed.
    if (isOrgRole(target.role) && target.role === 'admin') {
      const members = await listOrgMembers(db, id)
      const admins = members.filter((m) => m.role === 'admin')
      if (admins.length <= 1) return c.json({ error: 'cannot remove the last org admin' }, 409)
    }
    const removed = await removeOrgMember(db, id, owner)
    if (!removed) return c.json({ error: 'not found' }, 404)
    ORG_MEMBERS.delete(owner)
    return c.json({ ok: true, removed: owner })
  })
}
