import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { createDatabase, migrate } from '../storage/db.js'
import { SessionPrompt } from '../session/prompt.js'
import { Bus } from '../bus/index.js'
import { PermissionManager } from '../permission/index.js'
import { ToolRegistry } from '../tools/registry.js'
import type { Gateway } from '../gateway/index.js'
import { mountSessionRoutes } from './session.js'

// P2-2 roundtrip: export → import preserves content with fresh ids.
// Uses REAL fetch against a live Bun.serve socket — never stubs
// globalThis.fetch (a leaked stub broke CI before; see
// reference/mira-mcp-http-flake-ci-2026-09-07.md).

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

beforeAll(async () => {
  db = createDatabase(':memory:')
  await migrate(db)
  const bus = new Bus()
  const permissions = new PermissionManager({})
  const tools = new ToolRegistry({ db, bus: new Bus(), permissions, gateway: stubGateway })
  prompt = new SessionPrompt({ db, bus, gateway: stubGateway, tools, permissions })
  const app = new Hono<{ Variables: { requestId: string } }>()
  mountSessionRoutes(app, {
    db,
    bus,
    prompt,
    authorizedSession: async (id) => (await prompt.getSession(id)) as never,
    ownerOfSession: async (id) => (await prompt.getSession(id))?.ownerID ?? null,
    resolveOwner: () => undefined,
    bearerOf: () => '',
    OWNERSHIP_ENABLED: false,
    sessionOwnerCache: new Map(),
  })
  server = Bun.serve({ port: 0, fetch: app.fetch })
  BASE = `http://127.0.0.1:${server.port}`
})

afterAll(() => {
  try {
    server.stop(true)
  } catch {}
})

async function seedSession() {
  const s = await prompt.createSession({ title: 'export-me' })
  const m1 = crypto.randomUUID()
  const m2 = crypto.randomUUID()
  await db
    .insert(db.schema.messages)
    .values({ id: m1, sessionID: s.id, role: 'user', createdAt: 1000 })
  await db
    .insert(db.schema.messages)
    .values({ id: m2, sessionID: s.id, role: 'assistant', createdAt: 2000 })
  await db.insert(db.schema.parts).values({
    id: crypto.randomUUID(),
    messageID: m1,
    sessionID: s.id,
    type: 'text',
    text: 'hello mira',
    createdAt: 1000,
  })
  await db.insert(db.schema.parts).values({
    id: crypto.randomUUID(),
    messageID: m2,
    sessionID: s.id,
    type: 'text',
    text: 'hello human',
    createdAt: 2000,
  })
  await db.insert(db.schema.parts).values({
    id: crypto.randomUUID(),
    messageID: m2,
    sessionID: s.id,
    type: 'tool-call',
    tool: 'read',
    toolCallID: 'call-1',
    args: { path: '/tmp/x' },
    createdAt: 2001,
  })
  await prompt.setTodos(s.id, [
    {
      id: crypto.randomUUID(),
      sessionID: s.id,
      content: 'first todo',
      status: 'pending',
      priority: 'high',
      createdAt: 1000,
    },
    {
      id: crypto.randomUUID(),
      sessionID: s.id,
      content: 'second todo',
      status: 'completed',
      priority: 'low',
      createdAt: 1001,
    },
  ])
  return s
}

describe('session export/import roundtrip', () => {
  test('export returns versioned envelope; import copies content with fresh ids', async () => {
    const src = await seedSession()

    const expRes = await fetch(`${BASE}/session/${src.id}/export`)
    expect(expRes.status).toBe(200)
    const envelope = (await expRes.json()) as {
      version: number
      exportedAt: string
      session: { id: string; title: string }
      messages: Array<{
        id: string
        role: string
        parts: Array<{ id: string; type: string; text: string | null; tool: string | null }>
      }>
      todos: Array<{ id: string; content: string; status: string; priority: string }>
    }
    expect(envelope.version).toBe(1)
    expect(typeof envelope.exportedAt).toBe('string')
    expect(envelope.session.title).toBe('export-me')
    expect(envelope.messages).toHaveLength(2)
    expect(envelope.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(envelope.messages[0].parts.map((p) => p.text)).toEqual(['hello mira'])
    expect(envelope.messages[1].parts.map((p) => p.type)).toEqual(['text', 'tool-call'])
    expect(envelope.todos.map((t) => t.content).sort()).toEqual(['first todo', 'second todo'])

    const impRes = await fetch(`${BASE}/session/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
    })
    expect(impRes.status).toBe(201)
    const imported = (await impRes.json()) as {
      id: string
      copiedMessages: number
      copiedParts: number
      copiedTodos: number
    }
    expect(imported.id).toBeDefined()
    expect(imported.id).not.toBe(src.id)
    expect(imported.copiedMessages).toBe(2)
    expect(imported.copiedParts).toBe(3)
    expect(imported.copiedTodos).toBe(2)

    // New session row: title preserved + " (import)", parent dropped (no parent here → null)
    const gotRes = await fetch(`${BASE}/session/${imported.id}`)
    expect(gotRes.status).toBe(200)
    const got = (await gotRes.json()) as { id: string; title: string; parentID: string | null }
    expect(got.title).toBe('export-me (import)')
    expect(got.parentID).toBeNull()

    // Re-export the copy and compare content (ids must all differ)
    const reExp = (await (
      await fetch(`${BASE}/session/${imported.id}/export`)
    ).json()) as typeof envelope
    expect(reExp.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(reExp.messages[0].parts.map((p) => p.text)).toEqual(['hello mira'])
    expect(reExp.messages[1].parts.map((p) => p.type)).toEqual(['text', 'tool-call'])
    expect(reExp.messages[1].parts[1].tool).toBe('read')
    expect(reExp.todos.map((t) => [t.content, t.status, t.priority]).sort()).toEqual(
      [
        ['first todo', 'pending', 'high'],
        ['second todo', 'completed', 'low'],
      ].sort(),
    )
    const srcMsgIds = new Set(envelope.messages.map((m) => m.id))
    const newMsgIds = new Set(reExp.messages.map((m) => m.id))
    expect([...newMsgIds].some((id) => srcMsgIds.has(id))).toBe(false)
    const srcPartIds = new Set(envelope.messages.flatMap((m) => m.parts.map((p) => p.id)))
    const newPartIds = new Set(reExp.messages.flatMap((m) => m.parts.map((p) => p.id)))
    expect([...newPartIds].some((id) => srcPartIds.has(id))).toBe(false)
    const srcTodoIds = new Set(envelope.todos.map((t) => t.id))
    const newTodoIds = new Set(reExp.todos.map((t) => t.id))
    expect([...newTodoIds].some((id) => srcTodoIds.has(id))).toBe(false)
  })

  test('export 404s for missing session', async () => {
    const res = await fetch(`${BASE}/session/does-not-exist/export`)
    expect(res.status).toBe(404)
  })

  test('import rejects unknown envelope version', async () => {
    for (const version of [2, 999, '9.9']) {
      const res = await fetch(`${BASE}/session/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version, session: { title: 'x' }, messages: [], todos: [] }),
      })
      expect(res.status).toBe(400)
    }
  })

  test('import drops parentID when the parent does not exist', async () => {
    const res = await fetch(`${BASE}/session/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        session: { title: 'orphan', parentID: 'missing-parent' },
        messages: [],
        todos: [],
      }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: string }
    const got = (await (await fetch(`${BASE}/session/${body.id}`)).json()) as {
      parentID: string | null
    }
    expect(got.parentID).toBeNull()
  })
})
