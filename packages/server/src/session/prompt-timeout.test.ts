import { describe, test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDatabase, migrate } from '../storage/db.js'
import { SessionPrompt } from './prompt.js'
import { Bus } from '../bus/index.js'
import { PermissionManager } from '../permission/index.js'
import { ToolRegistry } from '../tools/registry.js'
import type { Gateway, GatewayChunk } from '../gateway/index.js'

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

describe('SessionPrompt resilience (permission timeout + transient stream retries)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mira-prompt-resilience-'))

  afterAll(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })

  test('permission timeout turns into structured tool error and allows loop to continue gracefully', async () => {
    const db = createDatabase(join(dir, 'timeout.db'))
    await migrate(db)
    const bus = new Bus()
    // Simulate a fast permission timeout rejection matching Bus.waitForPermissionReply error shape
    bus.waitForPermissionReply = async (toolCallID) => {
      throw new Error(`Permission timeout for ${toolCallID} after 50ms`)
    }
    const permissions = new PermissionManager({ bash: { '*': 'ask' } })
    const tools = new ToolRegistry({ db, bus, permissions, gateway: stubGateway })

    let streamCalls = 0
    const gateway: Gateway = {
      ...stubGateway,
      stream: () => {
        streamCalls++
        if (streamCalls === 1) {
          const chunks: GatewayChunk[] = [
            {
              type: 'tool-call',
              toolCall: {
                id: 'call-timeout-1',
                name: 'bash',
                args: { command: 'echo hello' },
              },
            },
            { type: 'finish', finishReason: 'tool-calls' },
          ]
          return Promise.resolve(
            (async function* () {
              yield* chunks
            })(),
          )
        }
        const chunks: GatewayChunk[] = [
          { type: 'text-delta', text: 'Recovered cleanly after timeout.' },
          { type: 'finish', finishReason: 'stop' },
        ]
        return Promise.resolve(
          (async function* () {
            yield* chunks
          })(),
        )
      },
    }

    const sp = new SessionPrompt({ db, bus, gateway, tools, permissions })
    const sess = await sp.createSession({ title: 'Timeout Test' })
    const assistantMessageID = crypto.randomUUID()
    await db.insert(db.schema.messages).values({
      id: crypto.randomUUID(),
      sessionID: sess.id,
      role: 'user',
      createdAt: Date.now(),
    })
    await db.insert(db.schema.messages).values({
      id: assistantMessageID,
      sessionID: sess.id,
      role: 'assistant',
      createdAt: Date.now(),
    })

    const events: Array<{ event: string; data: unknown }> = []
    const writer = {
      write: () => {},
      close: async () => {},
    } as unknown as WritableStreamDefaultWriter<Uint8Array>

    await (
      sp as unknown as {
        runLoop: (o: Record<string, unknown>) => Promise<void>
      }
    ).runLoop({
      sessionID: sess.id,
      assistantMessageID,
      userText: 'Run echo hello',
      model: 'openai/gpt-4o',
      systemPrompt: 'test system prompt',
      send: (event: string, data: unknown) => {
        events.push({ event, data })
      },
      writer,
    })

    expect(streamCalls).toBe(2)
    expect(events.map((e) => e.event)).toContain('permission_ask')
    expect(events.map((e) => e.event)).toContain('permission_timeout')
    expect(events.map((e) => e.event)).toContain('finish')
    const toolResult = events.find((e) => e.event === 'tool_result')?.data as
      | { isError?: boolean; result?: unknown }
      | undefined
    expect(toolResult?.isError).toBe(true)
    expect(JSON.stringify(toolResult?.result ?? '')).toContain('Permission timeout')
  })

  test('transient stream error retries automatically before succeeding', async () => {
    const db = createDatabase(join(dir, 'retry.db'))
    await migrate(db)
    const bus = new Bus()
    const permissions = new PermissionManager({})
    const tools = new ToolRegistry({ db, bus, permissions, gateway: stubGateway })

    let attempts = 0
    const gateway: Gateway = {
      ...stubGateway,
      stream: () => {
        attempts++
        if (attempts === 1) {
          return Promise.reject(new Error('503 Service Unavailable'))
        }
        const chunks: GatewayChunk[] = [
          { type: 'text-delta', text: 'Succeeded on retry!' },
          { type: 'finish', finishReason: 'stop' },
        ]
        return Promise.resolve(
          (async function* () {
            yield* chunks
          })(),
        )
      },
    }

    const sp = new SessionPrompt({ db, bus, gateway, tools, permissions })
    const sess = await sp.createSession({ title: 'Retry Test' })
    const assistantMessageID = crypto.randomUUID()
    await db.insert(db.schema.messages).values({
      id: crypto.randomUUID(),
      sessionID: sess.id,
      role: 'user',
      createdAt: Date.now(),
    })
    await db.insert(db.schema.messages).values({
      id: assistantMessageID,
      sessionID: sess.id,
      role: 'assistant',
      createdAt: Date.now(),
    })

    const chunks: string[] = []
    const writer = {
      write: () => {},
      close: async () => {},
    } as unknown as WritableStreamDefaultWriter<Uint8Array>

    await (
      sp as unknown as {
        runLoop: (o: Record<string, unknown>) => Promise<void>
      }
    ).runLoop({
      sessionID: sess.id,
      assistantMessageID,
      userText: 'Say hi',
      model: 'openai/gpt-4o',
      systemPrompt: 'test system prompt',
      send: (event: string, data: unknown) => {
        if (event === 'text_delta' && data && typeof data === 'object' && 'delta' in data) {
          chunks.push(String((data as { delta: string }).delta))
        }
      },
      writer,
    })

    expect(attempts).toBe(2)
    expect(chunks.join('')).toContain('Succeeded on retry!')
  })
})
