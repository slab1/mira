/**
 * Inbound GitHub webhooks — POST /webhooks/github
 *
 * Verifies X-Hub-Signature-256 (HMAC-SHA256) against MIRA_GITHUB_WEBHOOK_SECRET,
 * then publishes a summarized `github.webhook` BusEvent (push / pull_request /
 * ping supported; other events acked and summarized generically).
 *
 * Auth: HMAC is the credential, so this path is exempt from the bearer gate
 * (see PUBLIC_PATHS in middleware). Without a configured secret the receiver
 * answers 503 — fail closed, never accept unsigned deliveries.
 */

import type { Hono } from 'hono'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Bus } from '../bus/index.js'
import type { JsonValue } from '../types/index.js'

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/** Small, stable summary — never forwards the raw delivery (may contain secrets). */
function summarize(event: string, payload: unknown): Record<string, JsonValue | undefined> {
  const p = asRecord(payload)
  const repo = asRecord(p.repository)
  const sender = asRecord(p.sender)
  const head = asRecord(p.head_commit)
  const pr = asRecord(p.pull_request)
  return {
    event,
    action: str(p.action),
    repo: str(repo.full_name),
    sender: str(sender.login),
    ref: str(p.ref),
    headSha: str(head.id) ?? str(p.after),
    prNumber: typeof p.number === 'number' ? p.number : undefined,
    prTitle: str(pr.title),
    prState: str(pr.state),
  }
}

export function verifyGitHubSignature(raw: string, signature: string, secret: string): boolean {
  if (!secret || !signature.startsWith('sha256=')) return false
  const expected = `sha256=${createHmac('sha256', secret).update(raw, 'utf8').digest('hex')}`
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function mountWebhookRoutes(
  app: Hono<{ Variables: { requestId: string } }>,
  deps: { bus: Bus },
) {
  app.post('/webhooks/github', async (c) => {
    const secret = process.env.MIRA_GITHUB_WEBHOOK_SECRET ?? ''
    if (!secret) return c.json({ error: 'webhook receiver not configured' }, 503)

    const raw = await c.req.text()
    const sig = c.req.header('X-Hub-Signature-256') ?? ''
    if (!verifyGitHubSignature(raw, sig, secret)) {
      return c.json({ error: 'bad signature' }, 401)
    }

    const event = c.req.header('X-GitHub-Event') ?? 'unknown'
    const delivery = c.req.header('X-GitHub-Delivery') ?? undefined
    let payload: unknown = null
    try {
      payload = JSON.parse(raw)
    } catch {
      return c.json({ error: 'invalid JSON' }, 400)
    }

    if (event === 'ping') {
      return c.json({ ok: true, msg: str(asRecord(payload).zen) ?? 'pong' })
    }

    const summary = summarize(event, payload)
    deps.bus.publish({
      type: 'github.webhook',
      payload: { ...summary, delivery } as Record<string, JsonValue | undefined> as JsonValue,
      timestamp: Date.now(),
    })
    return c.json({ ok: true, event })
  })
}
