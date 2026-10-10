/**
 * RBAC middleware tests (P3.1) — viewer is read-only.
 * Real Hono app + fetch (no stubs), minimal surface.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { mountMiddleware } from './index.js'
import type { Role } from '../auth/roles.js'

const TOKENS = {
  admin: 'admin-token',
  viewer: 'viewer-token',
  operator: 'operator-token',
}
const OWNERS = new Map<string, string>([
  [TOKENS.admin, 'default'],
  [TOKENS.viewer, 'vuser'],
  [TOKENS.operator, 'ouser'],
])
const ROLES = new Map<string, Role>([['vuser', 'viewer']])

const resolveOwner = (t: string) =>
  t === TOKENS.admin ? 'default' : OWNERS.has(t) ? (OWNERS.get(t) as string) : undefined
const resolveRole = (t: string): Role => {
  const owner = resolveOwner(t)
  if (owner === 'default') return 'admin'
  return (owner && ROLES.get(owner)) || 'operator'
}
const bearerOf = (h?: string) => (h?.startsWith('Bearer ') ? h.slice(7) : '')

let server: { stop: (closeActiveConnections?: boolean) => void; port: number | undefined }
let base: string

beforeAll(() => {
  const app = new Hono<{ Variables: { requestId: string } }>()
  mountMiddleware(app, {
    CORS_ORIGIN_LIST: [],
    REQUIRED_TOKEN: TOKENS.admin,
    API_KEY_OWNERS: OWNERS,
    resolveOwner,
    resolveRole,
    bearerOf,
    getBunServer: () => null,
  })
  app.get('/thing', (c) => c.json({ ok: true }))
  app.post('/thing', (c) => c.json({ ok: true }, 201))
  server = Bun.serve({ port: 0, fetch: app.fetch })
  base = `http://127.0.0.1:${server.port}`
})

afterAll(() => {
  try {
    server.stop(true)
  } catch {}
})

describe('RBAC middleware — viewer is read-only', () => {
  test('viewer can GET', async () => {
    const res = await fetch(`${base}/thing`, {
      headers: { Authorization: `Bearer ${TOKENS.viewer}` },
    })
    expect(res.status).toBe(200)
  })

  test('viewer POST is 403 with a clear error', async () => {
    const res = await fetch(`${base}/thing`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKENS.viewer}` },
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toContain('read-only')
  })

  test('operator can POST', async () => {
    const res = await fetch(`${base}/thing`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKENS.operator}` },
    })
    expect(res.status).toBe(201)
  })

  test('admin can POST', async () => {
    const res = await fetch(`${base}/thing`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKENS.admin}` },
    })
    expect(res.status).toBe(201)
  })

  test('unknown token still 401', async () => {
    const res = await fetch(`${base}/thing`, { headers: { Authorization: 'Bearer nope' } })
    expect(res.status).toBe(401)
  })

  test('viewer HEAD passes (read-only verb)', async () => {
    const res = await fetch(`${base}/thing`, {
      method: 'HEAD',
      headers: { Authorization: `Bearer ${TOKENS.viewer}` },
    })
    expect(res.status).toBe(200)
  })
})
