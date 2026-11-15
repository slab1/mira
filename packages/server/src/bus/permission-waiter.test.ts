import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { Bus } from './index.js'
import { mountToolsRoutes } from '../routes/tools-routes.js'
import { mountVoiceRoutes } from '../routes/voice.js'
import { ToolRegistry } from '../tools/registry.js'
import { PermissionManager } from '../permission/index.js'
import { GuardrailsManager } from '../guardrails/index.js'
import { createDatabase, migrate } from '../storage/db.js'
import type { Gateway } from '../gateway/index.js'

describe('Bus permission waiters and REST endpoints', () => {
  const bus = new Bus()

  afterEach(() => {
    bus.clear()
  })

  test('waitForPermissionReply tracks metadata and resolves on matching nonce', async () => {
    const p = bus.waitForPermissionReply('tc-1', 'nonce-abc', 5000, {
      sessionID: 'sess-1',
      tool: 'bash',
      args: { command: 'echo hi' },
      reason: 'Need confirmation',
      risk: 'medium',
    })

    const pendingAll = bus.listPendingPermissions()
    expect(pendingAll).toHaveLength(1)
    expect(pendingAll[0]?.toolCallID).toBe('tc-1')
    expect(pendingAll[0]?.sessionID).toBe('sess-1')
    expect(pendingAll[0]?.tool).toBe('bash')

    expect(bus.listPendingPermissions('sess-other')).toHaveLength(0)

    const mismatch = bus.resolvePermissionReply({
      toolCallID: 'tc-1',
      nonce: 'wrong-nonce',
      decision: 'allow',
    })
    expect(mismatch.ok).toBe(false)
    expect(mismatch.status).toBe('nonce_mismatch')
    expect(bus.listPendingPermissions()).toHaveLength(1)

    const resolved = bus.resolvePermissionReply({
      toolCallID: 'tc-1',
      nonce: 'nonce-abc',
      decision: 'allow',
    })
    expect(resolved.ok).toBe(true)
    expect(resolved.status).toBe('resolved')
    expect(await p).toBe('allow')
    expect(bus.listPendingPermissions()).toHaveLength(0)
  })

  test('cancelPermissionWait unblocks waiter immediately', async () => {
    const p = bus.waitForPermissionReply('tc-cancel', 'nonce-2', 30_000, {
      sessionID: 'sess-2',
      tool: 'write',
    })
    expect(bus.listPendingPermissions('sess-2')).toHaveLength(1)

    const cancelled = bus.cancelPermissionWait('tc-cancel', 'deny')
    expect(cancelled).toBe(true)
    expect(await p).toBe('deny')
    expect(bus.listPendingPermissions('sess-2')).toHaveLength(0)
  })

  test('GET /permission/pending and POST /permission/reply wire cleanly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mira-perm-route-'))
    try {
      const db = createDatabase(join(dir, 'test.db'))
      await migrate(db)
      const permissions = new PermissionManager({})
      const stubGateway = {
        stream: async () => (async function* () {})(),
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
      } as unknown as Gateway
      const app = new Hono<{ Variables: { requestId: string } }>()
      mountToolsRoutes(app, {
        tools: new ToolRegistry({ db, bus, permissions, gateway: stubGateway }),
        permissions,
        guardrails: new GuardrailsManager(),
        gateway: stubGateway,
        bus,
      })

      const waitPromise = bus.waitForPermissionReply('tc-http', 'nonce-http', 10_000, {
        sessionID: 'sess-http',
        tool: 'bash',
        args: { command: 'ls' },
      })

      const pendingRes = await app.fetch(new Request('http://local/permission/pending?sessionID=sess-http'))
      expect(pendingRes.status).toBe(200)
      const pendingBody = (await pendingRes.json()) as { pending: Array<{ toolCallID: string; nonce: string }> }
      expect(pendingBody.pending).toHaveLength(1)
      expect(pendingBody.pending[0]?.toolCallID).toBe('tc-http')

      const badRes = await app.fetch(
        new Request('http://local/permission/reply', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ toolCallID: 'tc-http', nonce: 'bad', decision: 'allow' }),
        }),
      )
      expect(badRes.status).toBe(403)

      const okRes = await app.fetch(
        new Request('http://local/permission/reply', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ toolCallID: 'tc-http', nonce: 'nonce-http', decision: 'allow' }),
        }),
      )
      expect(okRes.status).toBe(200)
      expect(await waitPromise).toBe('allow')

      const goneRes = await app.fetch(
        new Request('http://local/permission/reply', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ toolCallID: 'tc-http', nonce: 'nonce-http', decision: 'allow' }),
        }),
      )
      expect(goneRes.status).toBe(404)
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {}
    }
  })
})

describe('Voice routes status & validation', () => {
  const savedGemini = process.env.GEMINI_API_KEY
  const savedGoogleGen = process.env.GOOGLE_GENERATIVE_AI_API_KEY
  const savedGoogle = process.env.GOOGLE_API_KEY
  const savedOpenAI = process.env.OPENAI_API_KEY

  afterEach(() => {
    const restore = (k: string, v: string | undefined) => {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    restore('GEMINI_API_KEY', savedGemini)
    restore('GOOGLE_GENERATIVE_AI_API_KEY', savedGoogleGen)
    restore('GOOGLE_API_KEY', savedGoogle)
    restore('OPENAI_API_KEY', savedOpenAI)
  })

  test('POST /voice/transcribe rejects empty payload with 400', async () => {
    const app = new Hono<{ Variables: { requestId: string } }>()
    mountVoiceRoutes(app)
    const res = await app.fetch(
      new Request('http://local/voice/transcribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    )
    expect(res.status).toBe(400)
  })

  test('GET /voice/status reflects Gemini key availability', async () => {
    process.env.GEMINI_API_KEY = 'AIzaTestDummyKey'
    const app = new Hono<{ Variables: { requestId: string } }>()
    mountVoiceRoutes(app)
    const res = await app.fetch(new Request('http://local/voice/status'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { available: boolean; provider: string; model: string }
    expect(body.available).toBe(true)
    expect(body.provider).toBe('gemini')
    expect(body.model).toBe('gemini-3.5-transcribe')
  })
})
