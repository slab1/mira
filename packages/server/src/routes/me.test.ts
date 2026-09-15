import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { createDatabase, migrate } from '../storage/db.js'
import { mountMeRoutes } from './me.js'

// Lane B: GET/PATCH /me — user identity per authenticated owner.
// Uses REAL fetch against a live Bun.serve socket (never stubs globalThis.fetch).

let server!: { stop: (closeActiveConnections?: boolean) => void; port: number | undefined }
let BASE!: string
let db!: ReturnType<typeof createDatabase>

// Auth stub: token "tok-1" → owner "owner-1"; anything else is unauthenticated.
const resolveOwner = (t: string): string | undefined => (t === 'tok-1' ? 'owner-1' : undefined)
const bearerOf = (h?: string): string => (h?.startsWith('Bearer ') ? h.slice(7) : '')

const AUTH = { Authorization: 'Bearer tok-1' }

beforeAll(async () => {
  db = createDatabase(':memory:')
  await migrate(db)
  const app = new Hono<{ Variables: { requestId: string } }>()
  mountMeRoutes(app, { db, resolveOwner, bearerOf })
  server = Bun.serve({ port: 0, fetch: app.fetch })
  BASE = `http://127.0.0.1:${server.port}`
})

afterAll(() => {
  try {
    server.stop(true)
  } catch {}
})

describe('GET /me (Lane B identity)', () => {
  test('auto-creates a user with the default name on first access', async () => {
    const res = await fetch(`${BASE}/me`, { headers: AUTH })
    expect(res.status).toBe(200)
    const me = (await res.json()) as { id: string; owner: string; name: string }
    expect(me.owner).toBe('owner-1')
    expect(me.name).toBe('user')
    expect(me.id).toBeTruthy()
  })

  test('returns the same row on repeat access (no duplicate rows)', async () => {
    const a = (await (await fetch(`${BASE}/me`, { headers: AUTH })).json()) as { id: string }
    const b = (await (await fetch(`${BASE}/me`, { headers: AUTH })).json()) as { id: string }
    expect(a.id).toBe(b.id)
    const rows = db.sqlite
      .prepare('SELECT COUNT(*) AS c FROM users WHERE owner = ?')
      .get('owner-1') as {
      c: number
    }
    expect(rows.c).toBe(1)
  })

  test('401 without a valid token', async () => {
    const res = await fetch(`${BASE}/me`)
    expect(res.status).toBe(401)
  })
})

describe('PATCH /me (name update)', () => {
  test('updates the display name and persists it', async () => {
    const res = await fetch(`${BASE}/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: JSON.stringify({ name: '  Ada Lovelace  ' }),
    })
    expect(res.status).toBe(200)
    const me = (await res.json()) as { name: string; updatedAt: number }
    expect(me.name).toBe('Ada Lovelace') // trimmed
    expect(me.updatedAt).toBeGreaterThan(0)

    // Persisted — a fresh GET returns the updated name
    const got = (await (await fetch(`${BASE}/me`, { headers: AUTH })).json()) as { name: string }
    expect(got.name).toBe('Ada Lovelace')
  })

  test('rejects an empty / whitespace-only name', async () => {
    for (const name of ['', '   ', '\t\n']) {
      const res = await fetch(`${BASE}/me`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: JSON.stringify({ name }),
      })
      expect(res.status).toBe(400)
    }
  })

  test('rejects a name longer than 50 characters', async () => {
    const res = await fetch(`${BASE}/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: JSON.stringify({ name: 'x'.repeat(51) }),
    })
    expect(res.status).toBe(400)
  })

  test('rejects a non-string name', async () => {
    for (const name of [42, null, { name: 'x' }, ['Ada']]) {
      const res = await fetch(`${BASE}/me`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: JSON.stringify({ name }),
      })
      expect(res.status).toBe(400)
    }
  })

  test('401 without a valid token', async () => {
    const res = await fetch(`${BASE}/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ada' }),
    })
    expect(res.status).toBe(401)
  })
})
