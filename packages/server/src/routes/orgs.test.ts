import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { createDatabase, migrate } from '../storage/db.js'
import { mountOrgRoutes, type OrgMembership } from './orgs.js'

// P3.3 org tenancy — org CRUD + membership management rules.
// Real fetch against a live Bun.serve socket (never stubs globalThis.fetch).
//
// Owners: root (platform admin) · alice (acme org admin) · bob (acme member)
//         carol (beta org admin) · frank (orgless until invited)

let server!: { stop: (closeActiveConnections?: boolean) => void; port: number | undefined }
let BASE!: string
let db!: ReturnType<typeof createDatabase>

const OWNERS: Record<string, string> = {
  'tok-admin': 'root',
  'tok-org': 'alice',
  'tok-member': 'bob',
  'tok-other': 'carol',
  'tok-frank': 'frank',
}
const ROLES: Record<string, string> = { root: 'admin' }
const resolveOwner = (t: string): string | undefined => OWNERS[t]
const resolveRole = (t: string): 'viewer' | 'operator' | 'admin' =>
  (ROLES[OWNERS[t] ?? ''] as 'admin' | undefined) ?? 'operator'
const bearerOf = (h?: string): string => (h?.startsWith('Bearer ') ? h.slice(7) : '')

const ORG_NAMES = new Map<string, string>()
const ORG_MEMBERS = new Map<string, OrgMembership>()

let acmeID = ''
let betaID = ''

beforeAll(async () => {
  db = createDatabase(':memory:')
  await migrate(db)
  const app = new Hono<{ Variables: { requestId: string } }>()
  mountOrgRoutes(app, { db, ORG_NAMES, ORG_MEMBERS, resolveOwner, resolveRole, bearerOf })
  server = Bun.serve({ port: 0, fetch: app.fetch })
  BASE = `http://127.0.0.1:${server.port}`
})

afterAll(() => {
  try {
    server.stop(true)
  } catch {}
})

const auth = (tok: string) => ({ Authorization: `Bearer ${tok}` })
const post = (tok: string, path: string, body: unknown) =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { ...auth(tok), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const del = (tok: string, path: string) =>
  fetch(`${BASE}${path}`, { method: 'DELETE', headers: auth(tok) })

describe('POST /orgs (platform admin only)', () => {
  test('401 unauthenticated', async () => {
    const res = await post('tok-none', '/orgs', { name: 'acme' })
    expect(res.status).toBe(401)
  })

  test('403 for a non-admin bearer', async () => {
    const res = await post('tok-member', '/orgs', { name: 'acme' })
    expect(res.status).toBe(403)
  })

  test('400 for an invalid name', async () => {
    const res = await post('tok-admin', '/orgs', { name: '  ' })
    expect(res.status).toBe(400)
  })

  test('201 for platform admin; designated owner becomes the org admin', async () => {
    const res = await post('tok-admin', '/orgs', { name: 'acme', adminOwner: 'alice' })
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      org: { id: string; name: string }
      admin: { owner: string; role: string }
    }
    acmeID = body.org.id
    expect(body.org.name).toBe('acme')
    expect(body.admin).toEqual({ owner: 'alice', role: 'admin' })
    expect(ORG_MEMBERS.get('alice')).toEqual({ org: acmeID, role: 'admin' })
  })

  test('defaults the first admin to the creator when adminOwner is omitted', async () => {
    const res = await post('tok-admin', '/orgs', { name: 'beta' })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { org: { id: string }; admin: { owner: string } }
    betaID = body.org.id
    expect(body.admin.owner).toBe('root')
    expect(ORG_MEMBERS.get('root')).toEqual({ org: betaID, role: 'admin' })
  })

  test('409 on duplicate org name', async () => {
    const res = await post('tok-admin', '/orgs', { name: 'acme', adminOwner: 'frank' })
    expect(res.status).toBe(409)
  })

  test('409 when the designated admin already belongs to another org', async () => {
    // bob joins acme first…
    const join = await post('tok-org', `/orgs/${acmeID}/members`, { owner: 'bob' })
    expect(join.status).toBe(201)
    // …then a new org cannot claim him
    const res = await post('tok-admin', '/orgs', { name: 'gamma', adminOwner: 'bob' })
    expect(res.status).toBe(409)
    // the half-created org must not linger
    const again = await post('tok-admin', '/orgs', { name: 'gamma', adminOwner: 'carol' })
    expect(again.status).toBe(201)
  })
})

describe('GET /orgs + GET /orgs/:id (members read)', () => {
  test('GET /orgs returns the membership', async () => {
    const res = await fetch(`${BASE}/orgs`, { headers: auth('tok-member') })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { org: { id: string; name: string; role: string } }
    expect(body.org.id).toBe(acmeID)
    expect(body.org.name).toBe('acme')
    expect(body.org.role).toBe('member')
  })

  test('GET /orgs is null for an orgless owner', async () => {
    const res = await fetch(`${BASE}/orgs`, { headers: auth('tok-frank') })
    const body = (await res.json()) as { org: unknown }
    expect(body.org).toBeNull()
  })

  test('GET /orgs/:id lists members for a member', async () => {
    const res = await fetch(`${BASE}/orgs/${acmeID}`, { headers: auth('tok-member') })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { members: Array<{ owner: string; role: string }> }
    const owners = body.members.map((m) => m.owner).sort()
    expect(owners).toEqual(['alice', 'bob'])
  })

  test('GET /orgs/:id 404s for a non-member (no existence leak)', async () => {
    const res = await fetch(`${BASE}/orgs/${acmeID}`, { headers: auth('tok-frank') })
    expect(res.status).toBe(404)
  })

  test('GET /orgs/:id 404s for an unknown org', async () => {
    const res = await fetch(`${BASE}/orgs/org-none`, { headers: auth('tok-admin') })
    expect(res.status).toBe(404)
  })

  test('401 unauthenticated', async () => {
    const res = await fetch(`${BASE}/orgs`)
    expect(res.status).toBe(401)
  })
})

describe('membership management (org admin)', () => {
  test('plain member cannot add members (403)', async () => {
    const res = await post('tok-member', `/orgs/${acmeID}/members`, { owner: 'frank' })
    expect(res.status).toBe(403)
  })

  test('org admin adds frank; live map updates', async () => {
    const res = await post('tok-org', `/orgs/${acmeID}/members`, { owner: 'frank' })
    expect(res.status).toBe(201)
    expect(ORG_MEMBERS.get('frank')).toEqual({ org: acmeID, role: 'member' })
  })

  test('re-adding an existing member of the same org is a 409', async () => {
    const res = await post('tok-org', `/orgs/${acmeID}/members`, { owner: 'frank' })
    expect(res.status).toBe(409)
  })

  test('cross-org single-membership enforced (409)', async () => {
    // frank is in acme; beta's org admin (root) tries to claim him
    const res = await post('tok-admin', `/orgs/${betaID}/members`, { owner: 'frank' })
    expect(res.status).toBe(409)
  })

  test('cannot remove the last org admin (409)', async () => {
    const res = await del('tok-org', `/orgs/${acmeID}/members/alice`)
    expect(res.status).toBe(409)
  })

  test('removing a member drops their live access', async () => {
    const res = await del('tok-org', `/orgs/${acmeID}/members/frank`)
    expect(res.status).toBe(200)
    expect(ORG_MEMBERS.has('frank')).toBe(false)
  })

  test('404 when removing a non-member', async () => {
    const res = await del('tok-org', `/orgs/${acmeID}/members/frank`)
    expect(res.status).toBe(404)
  })

  test('platform admin can manage an org they do not belong to', async () => {
    // root (beta admin) promotes frank in acme — an org root is not a member of
    const res = await post('tok-admin', `/orgs/${acmeID}/members`, {
      owner: 'frank',
      role: 'admin',
    })
    expect(res.status).toBe(201)
    expect(ORG_MEMBERS.get('frank')).toEqual({ org: acmeID, role: 'admin' })
    // a second admin now exists → frank can remove alice
    const rm = await del('tok-frank', `/orgs/${acmeID}/members/alice`)
    expect(rm.status).toBe(200)
    expect(ORG_MEMBERS.has('alice')).toBe(false)
  })
})
