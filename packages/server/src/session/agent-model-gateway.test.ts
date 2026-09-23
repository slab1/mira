import { describe, test, expect, afterEach, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDatabase, migrate } from '../storage/db.js'
import { SessionPrompt, resolveEffectiveModel } from './prompt.js'
import { Bus } from '../bus/index.js'
import { PermissionManager } from '../permission/index.js'
import { ToolRegistry } from '../tools/registry.js'
import { getAgentTemplates } from '../agents/templates.js'
import type { Gateway, GatewayChunk } from '../gateway/index.js'

// No fetch stubs in this file — gateway resolution is pure (no I/O).
// NVIDIA_API_KEY (default provider) and ANTHROPIC_API_KEY are toggled per test
// to exercise the resolve vs fallback paths; originals are always restored.
const savedNvidiaKey = process.env.NVIDIA_API_KEY
const savedAnthropicKey = process.env.ANTHROPIC_API_KEY
afterEach(() => {
  if (savedNvidiaKey === undefined) delete process.env.NVIDIA_API_KEY
  else process.env.NVIDIA_API_KEY = savedNvidiaKey
  if (savedAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = savedAnthropicKey
})

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

describe('agent model via gateway (P0-1 exp-1)', () => {
  test('ask agent resolves to its cheap template model (precedence over session default)', () => {
    delete process.env.ANTHROPIC_API_KEY
    const askModel = getAgentTemplates().ask.model
    expect(askModel).toBeDefined()
    expect(
      resolveEffectiveModel({
        agent: 'ask',
        sessionModel: 'claude-sonnet-4',
      }),
    ).toBe(askModel!)
  })

  test('explicit model wins over agent model', () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    expect(resolveEffectiveModel({ explicitModel: 'openai/gpt-4o', agent: 'ask' })).toBe(
      'openai/gpt-4o',
    )
  })

  test('selection flows through gateway resolveModel (default-provider normalization)', () => {
    process.env.NVIDIA_API_KEY = 'test-key'
    delete process.env.ANTHROPIC_API_KEY
    // Default provider is nvidia — an unprefixed model gains that prefix via
    // the gateway path; raw string passthrough would return it unchanged.
    expect(resolveEffectiveModel({ explicitModel: 'deepseek-chat' })).toBe(
      'nvidia/deepseek-chat',
    )
  })

  test('falls back to raw candidate when gateway cannot resolve (no API key)', () => {
    delete process.env.NVIDIA_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    expect(resolveEffectiveModel({ explicitModel: 'deepseek-chat' })).toBe('deepseek-chat')
    // Precedence still holds on the fallback path
    const askModel = getAgentTemplates().ask.model!
    expect(resolveEffectiveModel({ agent: 'ask' })).toBe(askModel)
  })
})

describe('plan agent cannot rm (P0-1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mira-plan-rm-'))
  const dbFile = join(dir, 'plan-rm.db')
  afterAll(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })

  test('lane contract denies rm before execution', async () => {
    const db = createDatabase(dbFile)
    await migrate(db)
    const bus = new Bus()
    // Safety net: if lane enforcement regresses, the permission layer would
    // ask — auto-deny immediately instead of hanging on a 120s waiter.
    bus.waitForPermissionReply = async () => 'deny' as const
    const permissions = new PermissionManager({})

    let streamCalls = 0
    const rmChunk: GatewayChunk = {
      type: 'tool-call',
      toolCall: {
        id: 'tc-rm',
        name: 'bash',
        args: { command: 'rm -rf /tmp/plan-cannot-rm-probe' },
      },
    }
    const doneChunk: GatewayChunk = { type: 'finish', finishReason: 'stop' }
    const gateway: Gateway = {
      ...stubGateway,
      stream: () => {
        streamCalls++
        const chunks = streamCalls === 1 ? [rmChunk, doneChunk] : [doneChunk]
        return Promise.resolve(
          (async function* () {
            yield* chunks
          })(),
        )
      },
    }

    const tools = new ToolRegistry({ db, bus, permissions, gateway })
    const executed: string[] = []
    const origExecute = tools.execute.bind(tools)
    tools.execute = (async (...a: Parameters<typeof tools.execute>) => {
      executed.push(a[0])
      return origExecute(...a)
    }) as typeof tools.execute

    const sp = new SessionPrompt({ db, bus, gateway, tools, permissions })
    const s = await sp.createSession({ title: 'plan-rm-probe', agent: 'plan' })

    // Mirror streamResponse: persist user message + assistant placeholder
    // before the loop (parts.* FK → messages.id).
    const assistantMessageID = crypto.randomUUID()
    await db.insert(db.schema.messages).values({
      id: crypto.randomUUID(),
      sessionID: s.id,
      role: 'user',
      createdAt: Date.now(),
    })
    await db.insert(db.schema.messages).values({
      id: assistantMessageID,
      sessionID: s.id,
      role: 'assistant',
      createdAt: Date.now(),
    })

    const events: Array<{ event: string; data: unknown }> = []
    const send = (event: string, data: unknown) => {
      events.push({ event, data })
    }
    const writer = {
      write: () => {},
      close: async () => {},
    } as unknown as WritableStreamDefaultWriter<Uint8Array>
    await (
      sp as unknown as {
        runLoop: (o: Record<string, unknown>) => Promise<void>
      }
    ).runLoop({
      sessionID: s.id,
      assistantMessageID,
      userText: 'clean up temp files',
      model: 'openrouter/anthropic/claude-sonnet-4',
      systemPrompt: 'test system prompt',
      send,
      writer,
      agent: 'plan',
    })

    const toolResults = events.filter((e) => e.event === 'tool_result')
    expect(toolResults.length).toBe(1)
    const payload = toolResults[0].data as { error?: string }
    expect(payload.error ?? '').toContain('lane contract')
    // The destructive command never reached the tool layer
    expect(executed).toEqual([])
  })
})
