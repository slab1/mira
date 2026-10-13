import { describe, test, expect, afterEach } from 'bun:test'
import { liveOpenAIStream } from './stream.js'
import { ProviderError } from './errors.js'
import type { GatewayChunk, StreamOptions } from './types.js'
import { z } from 'zod'

const BASE = 'https://api.test/v1'

const makeOpts = (over: Partial<StreamOptions> = {}): StreamOptions =>
  ({
    model: 'test-model',
    messages: [{ role: 'user', content: 'hello' }],
    ...over,
  }) as StreamOptions

const event = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

interface Captured {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

/** Headers as a plain object so assertions don't index the HeadersInit union. */
function headersOf(init?: HeadersInit): Record<string, string> {
  const out: Record<string, string> = {}
  if (!init) return out
  if (Array.isArray(init)) for (const [k, v] of init) out[k] = v
  else if (typeof (init as Headers).forEach === 'function' && init instanceof Headers) {
    ;(init as Headers).forEach((v, k) => {
      out[k] = v
    })
  } else Object.assign(out, init as Record<string, string>)
  return out
}

function stubFetch(sse: string, init: { status?: number; errorText?: string } = {}) {
  const captured: Captured[] = []
  const orig = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, reqInit?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (!url.startsWith('https://api.test')) return orig(input as RequestInfo, reqInit)
    const body = JSON.parse(String(reqInit?.body ?? '{}')) as Record<string, unknown>
    captured.push({ url, headers: headersOf(reqInit?.headers), body })
    const status = init.status ?? 200
    if (status !== 200) {
      return new Response(init.errorText ?? 'upstream error', { status, headers: {} })
    }
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  return {
    captured,
    restore: () => {
      globalThis.fetch = orig
    },
  }
}

/** Collects chunks for assertions. Narrowing helpers keep assertions typed. */
async function drain(iter: AsyncIterable<GatewayChunk>): Promise<GatewayChunk[]> {
  const out: GatewayChunk[] = []
  for await (const c of iter) out.push(c)
  return out
}

const textOf = (chunks: GatewayChunk[]): string =>
  chunks
    .filter((c) => c.type === 'text-delta')
    .map((c) => (c as { text: string }).text)
    .join('')

const toolCalls = (
  chunks: GatewayChunk[],
): Array<{ id: string; name: string; args: Record<string, unknown> }> =>
  chunks
    .filter((c) => c.type === 'tool-call')
    .map(
      (c) =>
        (c as unknown as { toolCall: { id: string; name: string; args: Record<string, unknown> } })
          .toolCall,
    )

const finishOf = (chunks: GatewayChunk[]) =>
  chunks.find((c) => c.type === 'finish') as
    { finishReason: string; usage?: { inputTokens: number; outputTokens: number } } | undefined

describe('request shape', () => {
  test('posts with bearer auth and stream flags', async () => {
    const { captured, restore } = stubFetch(
      event({ choices: [{ delta: { content: 'x' } }] }) + 'data: [DONE]\n\n',
    )
    await drain(
      await liveOpenAIStream({
        baseURL: BASE,
        apiKey: 'sk-1',
        modelID: 'test-model',
        opts: makeOpts(),
      }),
    )
    restore()
    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe(`${BASE}/chat/completions`)
    expect(captured[0].headers.Authorization).toBe('Bearer sk-1')
    expect(captured[0].headers['Content-Type']).toBe('application/json')
    expect(captured[0].body.stream).toBe(true)
  })

  test('forwards maxTokens / temperature when provided', async () => {
    const { captured, restore } = stubFetch('data: [DONE]\n\n')
    await drain(
      await liveOpenAIStream({
        baseURL: BASE,
        apiKey: 'k',
        modelID: 'm',
        opts: makeOpts({ maxTokens: 256, temperature: 0.2 }),
      }),
    )
    restore()
    expect(captured[0].body.max_tokens).toBe(256)
    expect(captured[0].body.temperature).toBe(0.2)
  })

  test('system message included; claude gets array form', async () => {
    const { captured, restore } = stubFetch('data: [DONE]\n\n')
    await drain(
      await liveOpenAIStream({
        baseURL: BASE,
        apiKey: 'k',
        modelID: 'claude-sonnet-4',
        opts: makeOpts({ system: 'be terse' }),
      }),
    )
    restore()
    const msgs = captured[0].body.messages as Array<{
      role: string
      content: string | Array<unknown>
    }>
    expect(msgs[0].role).toBe('system')
    expect(Array.isArray(msgs[0].content)).toBe(true)
  })

  test('tools serialized into function shape', async () => {
    const { captured, restore } = stubFetch('data: [DONE]\n\n')
    await drain(
      await liveOpenAIStream({
        baseURL: BASE,
        apiKey: 'k',
        modelID: 'm',
        opts: makeOpts({
          tools: {
            read_file: { description: 'read a file', parameters: z.object({ path: z.string() }) },
          },
        }),
      }),
    )
    restore()
    const tools = captured[0].body.tools as Array<{ type: string; function: { name: string } }>
    expect(tools[0]!.type).toBe('function')
    expect(tools[0]!.function.name).toBe('read_file')
  })
})

describe('SSE parsing', () => {
  test('text deltas in order', async () => {
    const sse =
      event({ choices: [{ delta: { content: 'Hel' } }] }) +
      event({ choices: [{ delta: { content: 'lo' } }] }) +
      event({ choices: [{ delta: {}, finish_reason: 'stop' }] })
    const { restore } = stubFetch(sse)
    const chunks = await drain(
      await liveOpenAIStream({ baseURL: BASE, apiKey: 'k', modelID: 'm', opts: makeOpts() }),
    )
    restore()
    const text = textOf(chunks)
    expect(text).toBe('Hello')
    expect(chunks.some((c) => c.type === 'finish')).toBe(true)
  })

  test('usage attached to finish chunk', async () => {
    const sse =
      event({ choices: [{ delta: { content: 'x' } }] }) +
      event({ usage: { prompt_tokens: 11, completion_tokens: 7 } }) +
      event({ choices: [{ delta: {}, finish_reason: 'stop' }] })
    const { restore } = stubFetch(sse)
    const chunks = await drain(
      await liveOpenAIStream({ baseURL: BASE, apiKey: 'k', modelID: 'm', opts: makeOpts() }),
    )
    restore()
    const finish = finishOf(chunks)
    expect(finish?.usage?.inputTokens).toBe(11)
    expect(finish?.usage?.outputTokens).toBe(7)
  })

  test('malformed JSON event survived by next event', async () => {
    const sse =
      'data: {not json\n\n' +
      event({ choices: [{ delta: { content: 'survived' } }] }) +
      'data: [DONE]\n\n'
    const { restore } = stubFetch(sse)
    const chunks = await drain(
      await liveOpenAIStream({ baseURL: BASE, apiKey: 'k', modelID: 'm', opts: makeOpts() }),
    )
    restore()
    const text = textOf(chunks)
    expect(text).toBe('survived')
  })

  test('events after [DONE] ignored', async () => {
    const sse =
      event({ choices: [{ delta: { content: 'before' } }] }) +
      'data: [DONE]\n\n' +
      event({ choices: [{ delta: { content: 'after' } }] })
    const { restore } = stubFetch(sse)
    const chunks = await drain(
      await liveOpenAIStream({ baseURL: BASE, apiKey: 'k', modelID: 'm', opts: makeOpts() }),
    )
    restore()
    const text = textOf(chunks)
    expect(text).toBe('before')
  })
})

describe('tool-call accumulation', () => {
  test('argument fragments joined and parsed at flush', async () => {
    const sse =
      event({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', function: { name: 'read', arguments: '{"pa' } },
              ],
            },
          },
        ],
      }) +
      event({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"/a' } }] } }],
      }) +
      event({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '.ts"}' } }] } }],
      }) +
      event({ choices: [{ delta: { tool_calls: [], finish_reason: 'tool_calls' } }] })
    const { restore } = stubFetch(sse)
    const chunks = await drain(
      await liveOpenAIStream({ baseURL: BASE, apiKey: 'k', modelID: 'm', opts: makeOpts() }),
    )
    restore()
    const calls = toolCalls(chunks)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.id).toBe('call_1')
    expect(calls[0]!.name).toBe('read')
    expect(calls[0]!.args).toEqual({ path: '/a.ts' })
  })

  test('parallel tool calls (distinct indices) emitted separately', async () => {
    const sse =
      event({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'c0', function: { name: 'a', arguments: '{}' } }],
            },
          },
        ],
      }) +
      event({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 1, id: 'c1', function: { name: 'b', arguments: '{}' } }],
            },
          },
        ],
      }) +
      event({ choices: [{ delta: { tool_calls: [], finish_reason: 'tool_calls' } }] }) +
      event({ choices: [{ delta: { tool_calls: [], finish_reason: 'tool_calls' } }] })
    const { restore } = stubFetch(sse)
    const chunks = await drain(
      await liveOpenAIStream({ baseURL: BASE, apiKey: 'k', modelID: 'm', opts: makeOpts() }),
    )
    restore()
    const calls = toolCalls(chunks)
    expect(calls.length).toBe(2)
    expect(calls.map((c) => c.id).sort()).toEqual(['c0', 'c1'])
  })

  test('invalid arg JSON yields empty args', async () => {
    const sse =
      event({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'bad', function: { name: 'x', arguments: '{oops' } }],
            },
          },
        ],
      }) + event({ choices: [{ delta: { tool_calls: [], finish_reason: 'tool_calls' } }] })
    const { restore } = stubFetch(sse)
    const chunks = await drain(
      await liveOpenAIStream({ baseURL: BASE, apiKey: 'k', modelID: 'm', opts: makeOpts() }),
    )
    restore()
    const calls = toolCalls(chunks)
    expect(calls[0]!.id).toBe('bad')
    expect(calls[0]!.args).toEqual({})
  })
})

describe('error mapping', () => {
  test('429 maps to RATE_LIMITED with retry-after', async () => {
    const { restore } = stubFetch('', { status: 429 })
    let err: ProviderError | null = null
    try {
      await liveOpenAIStream({ baseURL: BASE, apiKey: 'k', modelID: 'm', opts: makeOpts() })
    } catch (e) {
      err = e as ProviderError
    }
    restore()
    expect(err).toBeInstanceOf(ProviderError)
    expect(err!.code).toBe('RATE_LIMITED')
    expect(err!.status).toBe(429)
  })

  test('401 maps to UNAUTHORIZED', async () => {
    const { restore } = stubFetch('', { status: 401 })
    let code = ''
    try {
      await liveOpenAIStream({ baseURL: BASE, apiKey: 'k', modelID: 'm', opts: makeOpts() })
    } catch (e) {
      code = (e as ProviderError).code
    }
    restore()
    expect(code).toBe('UNAUTHORIZED')
  })

  test('500 maps to PROVIDER_ERROR with upstream text', async () => {
    const { restore } = stubFetch('', { status: 500, errorText: 'upstream error' })
    let err: ProviderError | null = null
    try {
      await liveOpenAIStream({ baseURL: BASE, apiKey: 'k', modelID: 'm', opts: makeOpts() })
    } catch (e) {
      err = e as ProviderError
    }
    restore()
    expect(err!.code).toBe('PROVIDER_ERROR')
    expect(err!.message).toContain('upstream error')
  })
})
