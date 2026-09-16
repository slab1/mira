/**
 * P1-6: E2E test for doom-loop detection
 *
 * Verifies that the doom-loop detector fires through the full HTTP stack:
 *   POST /session → POST /session/:id/prompt → SSE stream → doom_loop event
 *
 * Uses a mock gateway that always returns the same tool call (bash ls),
 * which triggers the "identical tool call repeated 3x" detector.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { z } from 'zod'
import { createDatabase, migrate } from './storage/db.js'
import { SessionPrompt } from './session/prompt.js'
import { Bus } from './bus/index.js'
import { PermissionManager } from './permission/index.js'
import { ToolRegistry } from './tools/registry.js'
import type { Gateway, GatewayChunk, StreamOptions } from './gateway/types.js'
import { mountSessionRoutes } from './routes/session.js'
import { mountSessionExtrasRoutes } from './routes/session-extras.js'

// ── Mock gateway: returns the same tool call every iteration ────────────
// Each call to stream() yields one identical tool call.
// The doom-loop detector accumulates across steps and fires on the 3rd.
const doomLoopGateway: Gateway = {
  async stream(_opts: StreamOptions): Promise<AsyncIterable<GatewayChunk>> {
    return (async function* () {
      yield {
        type: 'tool-call',
        toolCall: { id: crypto.randomUUID(), name: 'bash', args: { command: 'ls' } },
      }
      yield {
        type: 'finish',
        finishReason: 'tool-calls',
        usage: { inputTokens: 10, outputTokens: 5 },
      }
    })()
  },
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

// ── Server setup (follows session-export.test.ts pattern) ───────────────

let server!: { stop: (closeActiveConnections?: boolean) => void; port: number | undefined }
let BASE!: string
let prompt!: SessionPrompt
let db!: ReturnType<typeof createDatabase>

beforeAll(async () => {
  db = createDatabase(':memory:')
  await migrate(db)
  const bus = new Bus()
  // BashArity auto-allows `ls` (level 0 → allow), so permission check passes
  const permissions = new PermissionManager({})
  const tools = new ToolRegistry({ db, bus, permissions, gateway: doomLoopGateway })
  // Intentionally NOT calling registerAll() — the doom-loop fires BEFORE tool execution,
  // so we don't need real tools registered.
  prompt = new SessionPrompt({ db, bus, gateway: doomLoopGateway, tools, permissions })

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
  mountSessionExtrasRoutes(app, {
    db,
    bus,
    prompt,
    authorizedSession: async (id) => (await prompt.getSession(id)) as never,
    ownerOfSession: async (id) => (await prompt.getSession(id))?.ownerID ?? null,
    resolveOwner: () => undefined,
    bearerOf: () => '',
    API_KEY_OWNERS: new Map(),
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

// ── SSE parser ──────────────────────────────────────────────────────────

interface SSEEvent {
  event: string
  data: string
}

/** Parse raw SSE text into structured events (ignores comments like ": ping"). */
function parseSSEEvents(text: string): SSEEvent[] {
  const events: SSEEvent[] = []
  let currentEvent = 'message' // SSE default event type
  let currentData = ''

  for (const line of text.split('\n')) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7).trim()
    } else if (line.startsWith('data: ')) {
      // Accumulate data lines (multi-line data support)
      const d = line.slice(6)
      currentData = currentData ? currentData + '\n' + d : d
    } else if (line === '' && currentData) {
      // Empty line = event boundary
      events.push({ event: currentEvent, data: currentData })
      currentEvent = 'message'
      currentData = ''
    }
  }
  // Flush trailing event (stream may end without final blank line)
  if (currentData) {
    events.push({ event: currentEvent, data: currentData })
  }
  return events
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('doom-loop detection E2E', () => {
  test('POST /session creates a session', async () => {
    const res = await fetch(`${BASE}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'doom-loop-test' }),
    })
    expect(res.status).toBe(201)
    const session = (await res.json()) as { id: string; title: string }
    expect(session.id).toBeDefined()
    expect(session.title).toBe('doom-loop-test')
  })

  test('repeated identical tool calls trigger doom_loop SSE event', async () => {
    // 1. Create a session
    const createRes = await fetch(`${BASE}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'doom-loop-e2e' }),
    })
    expect(createRes.status).toBe(201)
    const { id: sessionID } = (await createRes.json()) as { id: string }

    // 2. Send a prompt — the mock gateway returns the same `bash ls` tool call
    //    on every step. After 3 identical calls, doom-loop fires and breaks the loop.
    const promptRes = await fetch(`${BASE}/session/${sessionID}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'run ls repeatedly' }),
    })
    expect(promptRes.status).toBe(200)
    expect(promptRes.headers.get('content-type')).toContain('text/event-stream')

    // 3. Read the full SSE response body (stream closes when loop finishes)
    const body = await promptRes.text()
    const events = parseSSEEvents(body)

    // Debug: print events for CI troubleshooting
    const eventTypes = events.map((e) => e.event)
    console.log('  SSE events:', eventTypes)

    // 4. Verify doom_loop event exists
    const doomEvents = events.filter((e) => e.event === 'doom_loop')
    expect(doomEvents.length).toBeGreaterThanOrEqual(1)

    // 5. Verify doom_loop payload
    const doomPayload = JSON.parse(doomEvents[0].data) as {
      tool: string
      reason?: string
      pattern?: string[]
      step?: number
    }
    expect(doomPayload.tool).toBe('bash')
    expect(doomPayload.reason).toContain('Identical')
    expect(doomPayload.pattern).toBeDefined()
    expect(doomPayload.pattern!.length).toBe(3) // 3 identical calls

    // 6. Verify the stream ends with a finish event
    const finishEvents = events.filter((e) => e.event === 'finish')
    expect(finishEvents.length).toBe(1)

    // 7. Verify step_start events: at least 2 steps before doom-loop (step 1 & 2 succeed,
    //    step 3 fires doom-loop on the 3rd tool call within that step)
    const stepStarts = events.filter((e) => e.event === 'step_start')
    expect(stepStarts.length).toBeGreaterThanOrEqual(2)
  })

  test('doom-loop fires bus server.error with source doom-loop', async () => {
    // Set up bus listener to capture server.error events
    const bus = new Bus()
    const busEvents: Array<{ type: string; payload: unknown }> = []
    bus.subscribe('server.error', (event) => {
      busEvents.push({ type: event.type, payload: event.payload })
    })

    // Create fresh prompt with our instrumented bus
    const permissions = new PermissionManager({})
    const tools = new ToolRegistry({ db, bus, permissions, gateway: doomLoopGateway })
    const testPrompt = new SessionPrompt({ db, bus, gateway: doomLoopGateway, tools, permissions })

    // Create session and run prompt directly (unit-level bus check)
    const session = await testPrompt.createSession({ title: 'doom-loop-bus' })

    // Collect SSE events from the stream
    const sseEvents: SSEEvent[] = []
    const response = await testPrompt.streamResponse(
      session.id,
      'repeat the same tool',
      undefined,
      { maxSteps: 10 },
    )
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
    }
    sseEvents.push(...parseSSEEvents(buffer))

    // Verify bus received server.error with source=doom-loop
    const doomBusEvents = busEvents.filter(
      (e) =>
        e.type === 'server.error' &&
        typeof e.payload === 'object' &&
        e.payload !== null &&
        'source' in e.payload &&
        (e.payload as Record<string, unknown>).source === 'doom-loop',
    )
    expect(doomBusEvents.length).toBe(1)

    const payload = doomBusEvents[0].payload as Record<string, unknown>
    expect(payload.source).toBe('doom-loop')
    expect(payload.tool).toBe('bash')
    expect(typeof payload.error).toBe('string')
    expect((payload.error as string).toLowerCase()).toContain('doom-loop')
  })

  test('non-repeating tool calls do NOT trigger doom-loop', async () => {
    // Gateway that returns a DIFFERENT command each iteration (no repeats)
    // Yields distinct text-delta per step so checkLLMOutput never sees repeats,
    // and registers bash tool so execution doesn't throw Unknown tool.
    let callIndex = 0
    const commands = ['echo hello', 'cat file.txt', 'grep pattern src/', 'wc -l README.md']
    const safeGateway: Gateway = {
      async stream(_opts: StreamOptions): Promise<AsyncIterable<GatewayChunk>> {
        return (async function* () {
          const cmd = commands[callIndex % commands.length]
          yield { type: 'text-delta', text: `step ${callIndex} hello ${cmd}` }
          callIndex++
          yield {
            type: 'tool-call',
            toolCall: {
              id: crypto.randomUUID(),
              name: 'bash',
              args: { command: cmd },
            },
          }
          yield {
            type: 'finish',
            finishReason: 'tool-calls',
            usage: { inputTokens: 10, outputTokens: 5 },
          }
        })()
      },
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

    const permissions = new PermissionManager({})
    const bus = new Bus()
    const tools = new ToolRegistry({ db, bus, permissions, gateway: safeGateway })
    await tools.registerAll()
    // Override real bash with fast mock to keep test deterministic on all platforms (Windows bash hangs)
    tools.unregister('bash')
    tools.register({
      name: 'bash',
      description: 'mock bash for test',
      category: 'execution',
      schema: z.object({ command: z.string() }).passthrough(),
      execute: async (args) => ({
        stdout: `mock ${(args as { command: string }).command}`,
        exitCode: 0,
      }),
    } as never)
    const testPrompt = new SessionPrompt({
      db,
      bus,
      gateway: safeGateway,
      tools,
      permissions,
    })

    const session = await testPrompt.createSession({ title: 'no-doom-loop' })
    const response = await testPrompt.streamResponse(session.id, 'say hello', undefined, {
      maxSteps: 5,
    })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
    }
    const events = parseSSEEvents(buffer)

    // Should NOT contain doom_loop events
    const doomEvents = events.filter((e) => e.event === 'doom_loop')
    expect(doomEvents.length).toBe(0)

    // Should end normally with finish
    const finishEvents = events.filter((e) => e.event === 'finish')
    expect(finishEvents.length).toBe(1)
  })
})
