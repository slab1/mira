/**
 * Access-control tests for operational endpoints.
 *
 * `/metrics` is no longer public: it exposes per-route request counts, latency
 * histograms, gateway spend and active sessions. `/healthz` stays public.
 *
 * Real Hono app + real fetch — no stubs (same convention as middleware/rbac.test.ts).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { mountMiddleware } from '../middleware/index.js'
import type { Role } from '../auth/roles.js'

const TOKENS = { admin: 'admin-token', viewer: 'viewer-token' }
const OWNERS = new Map<string, string>([
  [TOKENS.admin, 'default'],
  [TOKENS.viewer, 'vuser'],
])
const ROLES = new Map<string, Role>([['vuser', 'viewer']])

const resolveOwner = (t: string) => (OWNERS.has(t) ? (OWNERS.get(t) as string) : undefined)
const resolveRole = (t: string): Role => {
  const owner = resolveOwner(t)
  if (owner === 'default') return 'admin'
  return (owner && ROLES.get(owner)) || 'operator'
}
const bearerOf = (h?: string) => (h?.startsWith('Bearer ') ? h.slice(7) : '')

function buildApp(opts: { requiredToken: string; keys: Map<string, string> }) {
  const app = new Hono<{ Variables: { requestId: string } }>()
  mountMiddleware(app, {
    CORS_ORIGIN_LIST: [],
    REQUIRED_TOKEN: opts.requiredToken,
    API_KEY_OWNERS: opts.keys,
    resolveOwner,
    resolveRole,
    bearerOf,
    getBunServer: () => null,
  })
  app.get('/healthz', (c) => c.json({ ok: true }))
  app.get('/metrics', (c) =>
    c.text('# HELP gateway_cost_total Total gateway cost USD\ngateway_cost_total 1.25\n', 200, {
      'Content-Type': 'text/plain; version=0.0.4',
    }),
  )
  return app
}

let server: { stop: (closeActiveConnections?: boolean) => void; port: number | undefined }
let base: string

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: buildApp({ requiredToken: TOKENS.admin, keys: OWNERS }).fetch,
  })
  base = `http://127.0.0.1:${server.port}`
})

afterAll(() => {
  try {
    server.stop(true)
  } catch {}
})

describe('/metrics requires a credential when auth is enabled', () => {
  test('unauthenticated request is 401', async () => {
    const res = await fetch(`${base}/metrics`)
    expect(res.status).toBe(401)
  })

  test('invalid token is 401', async () => {
    const res = await fetch(`${base}/metrics`, { headers: { Authorization: 'Bearer nope' } })
    expect(res.status).toBe(401)
  })

  test('malformed Authorization header is 401', async () => {
    const res = await fetch(`${base}/metrics`, { headers: { Authorization: TOKENS.admin } })
    expect(res.status).toBe(401)
  })

  test('valid token serves the scrape payload', async () => {
    const res = await fetch(`${base}/metrics`, {
      headers: { Authorization: `Bearer ${TOKENS.admin}` },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/plain')
    expect(await res.text()).toContain('gateway_cost_total')
  })

  test('read-only viewer key can scrape (GET is not a mutating verb)', async () => {
    const res = await fetch(`${base}/metrics`, {
      headers: { Authorization: `Bearer ${TOKENS.viewer}` },
    })
    expect(res.status).toBe(200)
  })
})

describe('/healthz stays public for uptime probes', () => {
  test('no credential is required', async () => {
    const res = await fetch(`${base}/healthz`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { ok?: boolean }).ok).toBe(true)
  })

  test('/metrics is not smuggled in through a health-path traversal', async () => {
    for (const p of ['/healthz/../metrics', '/healthz%2f..%2fmetrics', '/healthz/..%2fmetrics']) {
      const res = await fetch(`${base}${p}`)
      expect(await res.text()).not.toContain('gateway_cost_total')
    }
  })
})

describe('no-auth deployments are unaffected', () => {
  test('/metrics is reachable when no credentials are configured', async () => {
    const open = Bun.serve({
      port: 0,
      fetch: buildApp({ requiredToken: '', keys: new Map() }).fetch,
    })
    try {
      const res = await fetch(`http://127.0.0.1:${open.port}/metrics`)
      expect(res.status).toBe(200)
      expect(await res.text()).toContain('gateway_cost_total')
    } finally {
      open.stop(true)
    }
  })
})
