import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { createDatabase, migrate } from '../storage/db.js'
import { SessionPrompt } from '../session/prompt.js'
import { Bus } from '../bus/index.js'
import { PermissionManager } from '../permission/index.js'
import { ToolRegistry } from '../tools/registry.js'
import type { Gateway } from '../gateway/index.js'
import { mountSessionRoutes } from './session.js'
import { mountOrgRoutes, type OrgMembership } from './orgs.js'
import { sessionVisibleTo } from '../auth/session-access.js'

// P3.3 org tenancy — the core guarantee: a session created under an org is
// visible (list + direct GET) to same-org members, stays 404-hidden from
// everyone else, and membership changes apply live.
// Real fetch against a live Bun.serve socket — never stubs globalThis.fetch.

const stubGateway: Gateway = {
  stream: () => Promise.resolve((async function* () {})()),
  complete: async () => ({ text: '' }),
  summarize: async () => '',
  listModels: async () => [],
  stats: () => ({
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUSD: 0,
    avgLatencyMs: 0,
    byModel: {},
  }),
}

let server!: { stop: (closeActiveConnections?: boolean) => void; port: number | undefined }
let BASE!: string
let prompt!: SessionPrompt
let db!: ReturnType<typeof createDatabase>

// alice + bob share org-1; carol is orgless; dave is in org-2.
const OWNERS: Record<string, string> = {
  'tok-alice': 'alice',
  'tok-bob': 'bob',
  'tok-carol': 'carol',
  'tok-dave': 'dave',
}
const resolveOwner = (t: string): string | undefined => OWNERS[t]
const bearerOf = (h?: string): string => (h?.startsWith('Bearer ') ? h.slice(7) : '')

const ORG_NAMES = new Map<string, string>([
  ['org-1', 'acme'],
  ['org-2', 'beta'],
])
const ORG_MEMBERS = new Map<string, OrgMembership>([
  ['alice', { org: 'org-1', role: 'admin' }],
  ['bob', { org: 'org-1', role: 'member' }],
  ['dave', { org: 'org-2', role: 'member' }],
])
const orgOfOwner = (o: string | null | undefined): string | undefined =>
  o ? ORG_MEMBERS.get(o)?.org : undefined
const orgOfSession = async (id: string) =>
  ((await prompt.getSession(id)) as { orgID?: string | null })?.orgID ?? null

// Mirror of the production closure in index.ts (sessionVisibleTo is the
// shared predicate under test; the closure wires the same pieces).
const authorizedSession = async (
  id: string,
  c: { req: { header: (n: string) => string | undefined } },
) => {
  const s = await prompt.getSession(id)
  if (!s) return null
  if (Object.keys(OWNERS).length === 0) return s
  const caller = resolveOwner(bearerOf(c.req.header('Authorization')))
  return sessionVisibleTo(
    { ownerID: s.ownerID ?? null, orgID: (await orgOfSession(id)) ?? null },
    caller,
    orgOfOwner,
  )
    ? s
    : null
}

const auth = (tok: string) => ({ Authorization: `Bearer ${tok}` })

beforeAll(async () => {
  db = createDatabase(':memory:')
  await migrate(db)
  // Seed orgs + memberships in the DB — mirrors the production boot loader
  // (index.ts reads orgs/org_members into the live maps at startup).
  const now = Date.now()
  await db.insert(db.schema.orgs).values([
    { id: 'org-1', name: 'acme', createdBy: 'root', createdAt: now },
    { id: 'org-2', name: 'beta', createdBy: 'root', createdAt: now },
  ])
  await db.insert(db.schema.orgMembers).values([
    { orgID: 'org-1', owner: 'alice', role: 'admin', createdAt: now },
    { orgID: 'org-1', owner: 'bob', role: 'member', createdAt: now },
    { orgID: 'org-2', owner: 'dave', role: 'member', createdAt: now },
  ])
  const bus = new Bus()
  const permissions = new PermissionManager({})
  const tools = new ToolRegistry({ db, bus: new Bus(), permissions, gateway: stubGateway })
  prompt = new SessionPrompt({ db, bus, gateway: stubGateway, tools, permissions })
  const app = new Hono<{ Variables: { requestId: string } }>()
  mountSessionRoutes(app, {
    db,
    bus,
    prompt,
    authorizedSession,
    ownerOfSession: async (id) => (await prompt.getSession(id))?.ownerID ?? null,
    orgOfOwner,
    orgOfSession,
    resolveOwner,
    bearerOf,
    OWNERSHIP_ENABLED: true,
    sessionOwnerCache: new Map(),
  })
  // org routes so membership mutations apply live within the same test run
  mountOrgRoutes(app, {
    db,
    ORG_NAMES,
    ORG_MEMBERS,
    resolveOwner,
    resolveRole: () => 'operator',
    bearerOf,
  })
  server = Bun.serve({ port: 0, fetch: app.fetch })
  BASE = `http://127.0.0.1:${server.port}`
})

afterAll(() => {
  try {
    server.stop(true)
  } catch {}
})

describe('org-scoped session visibility (P3.3)', () => {
  let aliceSessionID = ''

  test('sessions stamp the creating owner AND their org', async () => {
    const res = await fetch(`${BASE}/session`, {
      method: 'POST',
      headers: { ...auth('tok-alice'), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'alice work' }),
    })
    expect(res.status).toBe(201)
    const s = (await res.json()) as { id: string; ownerID: string | null; orgID: string | null }
    aliceSessionID = s.id
    expect(s.ownerID).toBe('alice')
    expect(s.orgID).toBe('org-1')
  })

  test('orgless ownerID is null-org — personal session stays private', async () => {
    const res = await fetch(`${BASE}/session`, {
      method: 'POST',
      headers: { ...auth('tok-carol'), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'carol private' }),
    })
    const s = (await res.json()) as { ownerID: string | null; orgID: string | null }
    expect(s.ownerID).toBe('carol')
    expect(s.orgID).toBeNull()
  })

  test('same-org member sees the session in their list', async () => {
    const res = await fetch(`${BASE}/session`, { headers: auth('tok-bob') })
    expect(res.status).toBe(200)
    const list = (await res.json()) as Array<{ id: string; ownerID: string | null }>
    expect(list.some((s) => s.id === aliceSessionID)).toBe(true)
  })

  test('same-org member can GET the session directly (200)', async () => {
    const res = await fetch(`${BASE}/session/${aliceSessionID}`, { headers: auth('tok-bob') })
    expect(res.status).toBe(200)
  })

  test('orgless owner gets 404 (no existence leak)', async () => {
    const res = await fetch(`${BASE}/session/${aliceSessionID}`, { headers: auth('tok-carol') })
    expect(res.status).toBe(404)
  })

  test('other-org owner gets 404', async () => {
    const res = await fetch(`${BASE}/session/${aliceSessionID}`, { headers: auth('tok-dave') })
    expect(res.status).toBe(404)
  })

  test('foreign sessions stay hidden in the outsider list', async () => {
    const res = await fetch(`${BASE}/session`, { headers: auth('tok-dave') })
    const list = (await res.json()) as Array<{ id: string }>
    expect(list.some((s) => s.id === aliceSessionID)).toBe(false)
  })

  test('membership removal revokes access live', async () => {
    // bob leaves org-1 via the org route (alice is the org admin)
    const res = await fetch(`${BASE}/orgs/org-1/members/bob`, {
      method: 'DELETE',
      headers: auth('tok-alice'),
    })
    expect(res.status).toBe(200)
    const get = await fetch(`${BASE}/session/${aliceSessionID}`, { headers: auth('tok-bob') })
    expect(get.status).toBe(404)
  })

  test('membership removal leaves the stored orgID intact (stamp is immutable)', async () => {
    const row = await prompt.getSession(aliceSessionID)
    expect(row?.orgID).toBe('org-1')
  })

  test('child sessions inherit the parent org', async () => {
    const child = await prompt.createSession({
      title: 'subagent child',
      parentID: aliceSessionID,
    })
    expect(child.ownerID).toBe('alice')
    expect((child as { orgID?: string | null }).orgID).toBe('org-1')
  })
})

describe('sessionVisibleTo (shared predicate)', () => {
  const orgOf = (o: string | null | undefined) =>
    o === 'alice' || o === 'bob' ? 'org-1' : undefined
  test('ownerless rows are shared (legacy rule preserved)', () => {
    expect(sessionVisibleTo({ ownerID: null, orgID: null }, 'anyone', orgOf)).toBe(true)
  })
  test('owner match', () => {
    expect(sessionVisibleTo({ ownerID: 'alice', orgID: 'org-1' }, 'alice', orgOf)).toBe(true)
  })
  test('same-org member', () => {
    expect(sessionVisibleTo({ ownerID: 'alice', orgID: 'org-1' }, 'bob', orgOf)).toBe(true)
  })
  test('orgless session stays private to its owner', () => {
    expect(sessionVisibleTo({ ownerID: 'alice', orgID: null }, 'bob', orgOf)).toBe(false)
  })
  test('cross-org caller is denied', () => {
    expect(sessionVisibleTo({ ownerID: 'alice', orgID: 'org-1' }, 'carol', orgOf)).toBe(false)
  })
  test('org session but orgless caller is denied', () => {
    const orgless = () => undefined
    expect(sessionVisibleTo({ ownerID: 'alice', orgID: 'org-1' }, 'carol', orgless)).toBe(false)
  })
})
