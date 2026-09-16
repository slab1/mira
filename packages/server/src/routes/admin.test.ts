/**
 * Security regression tests for admin routes:
 *  - Gap 1: HOST=0.0.0.0 (public bind) must NEVER open admin without auth
 *  - Gap 2: raw API keys must never appear in admin responses
 *
 * Uses REAL fetch against live Bun.serve sockets (never stubs globalThis.fetch).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { createDatabase, migrate } from '../storage/db.js'
import { mountAdminRoutes } from './admin.js'

const TOKEN = 'test-admin-master-token'
const RAW_KEY_RE = /[0-9a-f]{96}/

// ── Open-mode app (no REQUIRED_TOKEN, no API keys) ─────────────────────
let openServer!: { stop: (closeActiveConnections?: boolean) => void; port: number | undefined }
let openBase!: string
let openDb!: ReturnType<typeof createDatabase>

// ── Token-mode app (REQUIRED_TOKEN set) ────────────────────────────────
let tokenServer!: { stop: (closeActiveConnections?: boolean) => void; port: number | undefined }
let tokenBase!: string
let tokenDb!: ReturnType<typeof createDatabase>

const resolveOwner = (t: string): string | undefined => (t === TOKEN ? 'default' : undefined)
const bearerOf = (h?: string): string => (h?.startsWith('Bearer ') ? h.slice(7) : '')
const AUTH = { Authorization: `Bearer ${TOKEN}` }

/** Run fn with a controlled HOST / MIRA_STRICT_AUTH env, restoring after. */
async function withEnv(
  env: Record<string, string | undefined>,
  fn: () => Promise<Response>,
): Promise<Response> {
  const prev: Record<string, string | undefined> = {}
  for (const k of ['HOST', 'MIRA_STRICT_AUTH']) {
    prev[k] = process.env[k]
    if (env[k] === undefined) delete process.env[k]
    else process.env[k] = env[k]
  }
  try {
    return await fn()
  } finally {
    for (const k of ['HOST', 'MIRA_STRICT_AUTH']) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
  }
}

beforeAll(async () => {
  // Open-mode app
  openDb = createDatabase(':memory:')
  await migrate(openDb)
  const openApp = new Hono<{ Variables: { requestId: string } }>()
  mountAdminRoutes(openApp, {
    db: openDb,
    REQUIRED_TOKEN: '',
    API_KEY_OWNERS: new Map(),
    resolveOwner,
    bearerOf,
    sessionOwnerCache: new Map(),
  })
  openServer = Bun.serve({ port: 0, fetch: openApp.fetch })
  openBase = `http://127.0.0.1:${openServer.port}`

  // Token-mode app
  tokenDb = createDatabase(':memory:')
  await migrate(tokenDb)
  const tokenApp = new Hono<{ Variables: { requestId: string } }>()
  mountAdminRoutes(tokenApp, {
    db: tokenDb,
    REQUIRED_TOKEN: TOKEN,
    API_KEY_OWNERS: new Map(),
    resolveOwner,
    bearerOf,
    sessionOwnerCache: new Map(),
  })
  tokenServer = Bun.serve({ port: 0, fetch: tokenApp.fetch })
  tokenBase = `http://127.0.0.1:${tokenServer.port}`
})

afterAll(() => {
  try {
    openServer.stop(true)
  } catch {}
  try {
    tokenServer.stop(true)
  } catch {}
})

describe('Gap 1: admin auth on public bind (HOST=0.0.0.0)', () => {
  test('HOST=0.0.0.0 in open mode → admin endpoints require auth (401)', async () => {
    const res = await withEnv({ HOST: '0.0.0.0', MIRA_STRICT_AUTH: undefined }, () =>
      fetch(`${openBase}/admin/api-keys`),
    )
    expect(res.status).toBe(401)
  })

  test('HOST=0.0.0.0 in open mode → mint also requires auth (401)', async () => {
    const res = await withEnv({ HOST: '0.0.0.0', MIRA_STRICT_AUTH: undefined }, () =>
      fetch(`${openBase}/admin/api-keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner: 'alice' }),
      }),
    )
    expect(res.status).toBe(401)
  })

  test('non-loopback HOST (e.g. 192.168.1.5) in open mode → 401', async () => {
    const res = await withEnv({ HOST: '192.168.1.5', MIRA_STRICT_AUTH: undefined }, () =>
      fetch(`${openBase}/admin/api-keys`),
    )
    expect(res.status).toBe(401)
  })

  test('HOST=127.0.0.1 in open mode → admin open (loopback dev preserved)', async () => {
    const res = await withEnv({ HOST: '127.0.0.1', MIRA_STRICT_AUTH: undefined }, () =>
      fetch(`${openBase}/admin/api-keys`),
    )
    expect(res.status).toBe(200)
  })

  test('HOST=localhost in open mode → admin open (loopback dev preserved)', async () => {
    const res = await withEnv({ HOST: 'localhost', MIRA_STRICT_AUTH: undefined }, () =>
      fetch(`${openBase}/admin/api-keys`),
    )
    expect(res.status).toBe(200)
  })

  test('HOST=0.0.0.0 + MIRA_STRICT_AUTH=0 → explicit opt-out still opens admin', async () => {
    const res = await withEnv({ HOST: '0.0.0.0', MIRA_STRICT_AUTH: '0' }, () =>
      fetch(`${openBase}/admin/api-keys`),
    )
    expect(res.status).toBe(200)
  })
})

describe('Gap 2: raw API keys never appear in admin responses', () => {
  test('mint response returns key_prefix + key_hash presence, never the raw key', async () => {
    const res = await fetch(`${tokenBase}/admin/api-keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: JSON.stringify({ owner: 'alice' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.key).toBeUndefined()
    expect(typeof body.key_prefix).toBe('string')
    expect((body.key_prefix as string).length).toBeGreaterThan(0)
    expect((body.key_prefix as string).length).toBeLessThan(20)
    expect(body.key_hash).toBe(true)
    expect(body.owner).toBe('alice')
    // The raw 96-hex key must not appear anywhere in the serialized response
    expect(JSON.stringify(body)).not.toMatch(RAW_KEY_RE)
  })

  test('list response never contains raw keys (only key_prefix + key_hash)', async () => {
    for (const owner of ['alice', 'bob']) {
      const r = await fetch(`${tokenBase}/admin/api-keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: JSON.stringify({ owner }),
      })
      expect(r.status).toBe(201)
    }
    const res = await fetch(`${tokenBase}/admin/api-keys`, { headers: AUTH })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      count: number
      issued: Array<Record<string, unknown>>
    }
    expect(body.count).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(body)).not.toMatch(RAW_KEY_RE)
    for (const row of body.issued) {
      expect(row.key).toBeUndefined()
      expect(row.key_preview).toBeUndefined()
      expect(typeof row.key_prefix).toBe('string')
      expect(typeof row.key_hash).toBe('boolean')
    }
  })

  test('revoke response masks the key', async () => {
    const key = 'a'.repeat(96)
    tokenDb.sqlite
      .prepare(
        'INSERT INTO api_keys (key, key_hash, key_prefix, owner, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(key, 'hash', key.slice(0, 12), 'carol', Date.now(), 'default')
    const res = await fetch(`${tokenBase}/admin/api-keys/${key}`, {
      method: 'DELETE',
      headers: AUTH,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.key).not.toBe(key)
    expect(String(body.key)).toContain('…')
    expect(JSON.stringify(body)).not.toMatch(RAW_KEY_RE)
  })

  test('admin endpoints 401 without auth when token is required', async () => {
    const res = await fetch(`${tokenBase}/admin/api-keys`)
    expect(res.status).toBe(401)
  })
})
