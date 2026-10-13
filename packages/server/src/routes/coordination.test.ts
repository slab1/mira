/**
 * Coordination routes (§12) — claim/lock/patch-check/transaction/status over HTTP.
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { mountCoordinationRoutes } from './coordination.js'

describe('§12 coordination routes', () => {
  let app: Hono<{ Variables: { requestId: string } }>

  beforeEach(() => {
    app = new Hono()
    mountCoordinationRoutes(app as never)
  })

  test('claim → status shows owner; conflicting claim → 409', async () => {
    const r1 = await app.request('/coordination/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: 't1', owner: 'architect', files: ['src/x.ts'] }),
    })
    expect(r1.status).toBe(200)
    const b1 = (await r1.json()) as { ok: boolean; claim: { taskId: string } }
    expect(b1.ok).toBe(true)
    expect(b1.claim.taskId).toBe('t1')

    const r2 = await app.request('/coordination/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: 't1', owner: 'developer' }),
    })
    expect(r2.status).toBe(409)
    const b2 = (await r2.json()) as { conflicts: Array<{ holder: string }> }
    expect(b2.conflicts[0].holder).toBe('architect')

    const s = await app.request('/coordination/status')
    const sb = (await s.json()) as { claims: Array<{ taskId: string }>; locks: unknown[] }
    expect(sb.claims).toHaveLength(1)
    expect(sb.locks).toHaveLength(1) // claim auto-locked src/x.ts
  })

  test('lock conflicts → 409; stale patch → 409; transaction commit/abort', async () => {
    await app.request('/coordination/locks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: 'a', paths: ['f.ts'] }),
    })
    const r2 = await app.request('/coordination/locks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: 'b', paths: ['f.ts'] }),
    })
    expect(r2.status).toBe(409)

    await app.request('/coordination/writes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'g.ts', hash: 'h1', owner: 'a' }),
    })
    const stale = await app.request('/coordination/patches/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'g.ts', baseHash: 'h0', owner: 'b' }),
    })
    expect(stale.status).toBe(409)

    const tx = await app.request('/coordination/transactions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: 'a', paths: ['n1.ts', 'n2.ts'] }),
    })
    expect(tx.status).toBe(200)
    const txb = (await tx.json()) as { txId: string }
    const commit = await app.request(`/coordination/transactions/${txb.txId}/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: 'b' }),
    })
    expect(commit.status).toBe(409) // wrong owner
    const commit2 = await app.request(`/coordination/transactions/${txb.txId}/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: 'a' }),
    })
    expect(commit2.status).toBe(200)
  })

  test('validation errors → 400', async () => {
    const r = await app.request('/coordination/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: 'x' }),
    })
    expect(r.status).toBe(400)
  })
})
