import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { createHmac } from 'node:crypto'
import { Hono } from 'hono'
import { Bus } from '../bus/index.js'
import type { BusEvent } from '../types/index.js'
import { mountWebhookRoutes } from './webhooks.js'

// Uses REAL fetch against a live Bun.serve socket (never stubs globalThis.fetch).

const SECRET = 'test-webhook-secret'
let server!: { stop: (closeActiveConnections?: boolean) => void; port: number | undefined }
let BASE!: string
let bus!: Bus
let published: BusEvent[] = []

function sign(raw: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(raw, 'utf8').digest('hex')}`
}

async function postWebhook(
  raw: string,
  event: string,
  sig: string | null = sign(raw),
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-GitHub-Event': event,
    'X-GitHub-Delivery': 'delivery-1',
  }
  if (sig !== null) headers['X-Hub-Signature-256'] = sig
  return fetch(`${BASE}/webhooks/github`, { method: 'POST', headers, body: raw })
}

beforeAll(async () => {
  process.env.MIRA_GITHUB_WEBHOOK_SECRET = SECRET
  bus = new Bus()
  bus.subscribeAll((e) => {
    published.push(e)
  })
  const app = new Hono<{ Variables: { requestId: string } }>()
  mountWebhookRoutes(app, { bus })
  server = Bun.serve({ port: 0, fetch: app.fetch })
  BASE = `http://127.0.0.1:${server.port}`
})

afterAll(() => {
  delete process.env.MIRA_GITHUB_WEBHOOK_SECRET
  try {
    server.stop(true)
  } catch {}
})

beforeEach(() => {
  published = []
})

describe('POST /webhooks/github', () => {
  test('rejects unsigned deliveries with 401', async () => {
    const raw = JSON.stringify({ zen: 'hi' })
    const res = await postWebhook(raw, 'ping', 'sha256=deadbeef')
    expect(res.status).toBe(401)
    expect(published.length).toBe(0)
  })

  test('answers ping without publishing', async () => {
    const raw = JSON.stringify({ zen: 'Keep it logically awesome.' })
    const res = await postWebhook(raw, 'ping')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; msg: string }
    expect(body.msg).toContain('awesome')
    expect(published.length).toBe(0)
  })

  test('publishes summarized push event (no raw payload leak)', async () => {
    const raw = JSON.stringify({
      ref: 'refs/heads/main',
      after: 'abc123',
      repository: { full_name: 'slab1/mira' },
      sender: { login: 'slab1' },
      head_commit: { id: 'abc123', message: 'fix' },
      secret_token_inside: 'should-never-forward',
    })
    const res = await postWebhook(raw, 'push')
    expect(res.status).toBe(200)
    expect(published.length).toBe(1)
    expect(published[0].type).toBe('github.webhook')
    const p = published[0].payload as Record<string, unknown>
    expect(p.event).toBe('push')
    expect(p.repo).toBe('slab1/mira')
    expect(p.ref).toBe('refs/heads/main')
    expect(p).not.toHaveProperty('secret_token_inside')
    expect(p).not.toHaveProperty('head_commit')
  })

  test('publishes pull_request summary', async () => {
    const raw = JSON.stringify({
      action: 'opened',
      number: 42,
      repository: { full_name: 'slab1/mira' },
      pull_request: { title: 'feat', state: 'open' },
      sender: { login: 'slab1' },
    })
    const res = await postWebhook(raw, 'pull_request')
    expect(res.status).toBe(200)
    const p = published[0].payload as Record<string, unknown>
    expect(p.action).toBe('opened')
    expect(p.prNumber).toBe(42)
    expect(p.prTitle).toBe('feat')
  })

  test('rejects invalid JSON with 400', async () => {
    const raw = 'not-json{{{'
    const res = await postWebhook(raw, 'push')
    expect(res.status).toBe(400)
    expect(published.length).toBe(0)
  })

  test('fails closed with 503 when secret not configured', async () => {
    delete process.env.MIRA_GITHUB_WEBHOOK_SECRET
    try {
      const raw = JSON.stringify({ zen: 'hi' })
      const res = await postWebhook(raw, 'ping')
      expect(res.status).toBe(503)
    } finally {
      process.env.MIRA_GITHUB_WEBHOOK_SECRET = SECRET
    }
  })
})
