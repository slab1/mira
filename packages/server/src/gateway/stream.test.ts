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

  test('empty tools object omitted from request body so providers do not reject empty array', async () => {
    const { captured, restore } = stubFetch('data: [DONE]\n\n')
    await drain(
      await liveOpenAIStream({
        baseURL: BASE,
        apiKey: 'k',
        modelID: 'm',
        opts: makeOpts({ tools: {} }),
      }),
    )
    restore()
    expect(captured[0].body.tools).toBeUndefined()
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

  test('promotes reasoning_content to text when content is empty', async () => {
    const sse =
      event({ choices: [{ delta: { reasoning_content: 'Thought process here' } }] }) +
      event({ choices: [{ delta: {}, finish_reason: 'stop' }] })
    const { restore } = stubFetch(sse)
    const chunks = await drain(
      await liveOpenAIStream({ baseURL: BASE, apiKey: 'k', modelID: 'm', opts: makeOpts() }),
    )
    restore()
    const reasoningChunk = chunks.find((c) => c.type === 'reasoning-delta')
    expect(reasoningChunk).toBeDefined()
    expect((reasoningChunk as { text?: string }).text).toBe('Thought process here')
    const text = textOf(chunks)
    expect(text).toBe('Thought process here')
    expect(chunks.some((c) => c.type === 'finish')).toBe(true)
  })

  test('guarantees finish chunk is emitted when stream ends on [DONE] without finish_reason', async () => {
    const sse =
      event({ choices: [{ delta: { content: 'hello' } }] }) +
      'data: [DONE]\n\n'
    const { restore } = stubFetch(sse)
    const chunks = await drain(
      await liveOpenAIStream({ baseURL: BASE, apiKey: 'k', modelID: 'm', opts: makeOpts() }),
    )
    restore()
    const text = textOf(chunks)
    expect(text).toBe('hello')
    const finish = chunks.find((c) => c.type === 'finish')
    expect(finish).toBeDefined()
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

describe('tool message wire serialization', () => {
  test('serializes assistant tool_calls and expands batched toolResults into individual tool_call_id messages', async () => {
    const { captured, restore } = stubFetch('data: [DONE]\n\n')
    await drain(
      await liveOpenAIStream({
        baseURL: BASE,
        apiKey: 'k',
        modelID: 'm',
        opts: makeOpts({
          messages: [
            { role: 'user', content: 'run two tools' },
            {
              role: 'assistant',
              content: '',
              toolCalls: [
                { id: 'call_1', name: 'read', args: { path: 'a.ts' } },
                { id: 'call_2', name: 'bash', args: { command: 'ls' } },
              ],
            },
            {
              role: 'tool',
              content: JSON.stringify([
                { toolCallID: 'call_1', name: 'read', result: 'ok-1', isError: false },
                { toolCallID: 'call_2', name: 'bash', result: 'ok-2', isError: false },
              ]),
              toolResults: [
                { toolCallID: 'call_1', name: 'read', result: 'ok-1', isError: false },
                { toolCallID: 'call_2', name: 'bash', result: 'ok-2', isError: false },
              ],
            },
          ],
        }),
      }),
    )
    restore()

    const msgs = captured[0].body.messages as Array<{
      role: string
      content: string
      tool_call_id?: string
      tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>
    }>
    expect(msgs).toHaveLength(4)
    expect(msgs[1]?.role).toBe('assistant')
    expect(msgs[1]?.tool_calls?.map((t) => t.id)).toEqual(['call_1', 'call_2'])
    expect(msgs[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '"ok-1"' })
    expect(msgs[3]).toEqual({ role: 'tool', tool_call_id: 'call_2', content: '"ok-2"' })
  })

  test('downgrades unattributable role=tool message without tool_call_id so gateway never receives invalid tool role', async () => {
    const { captured, restore } = stubFetch('data: [DONE]\n\n')
    await drain(
      await liveOpenAIStream({
        baseURL: BASE,
        apiKey: 'k',
        modelID: 'm',
        opts: makeOpts({
          messages: [
            { role: 'user', content: 'hello' },
            { role: 'tool', content: 'orphaned output' },
          ],
        }),
      }),
    )
    restore()

    const msgs = captured[0].body.messages as Array<{
      role: string
      content: string
      tool_call_id?: string
    }>
    const toolMsgsWithoutId = msgs.filter((m) => m.role === 'tool' && !m.tool_call_id)
    expect(toolMsgsWithoutId).toHaveLength(0)
    expect(msgs[1]?.role).toBe('user')
    expect(msgs[1]?.content).toContain('orphaned output')
  })
})

describe('chatCompletionsUrl', () => {
  test('rewrites Google Gemini /v1beta baseURL to /v1beta/openai/chat/completions', async () => {
    const { chatCompletionsUrl } = await import('../providers/auth.js')
    expect(chatCompletionsUrl('https://generativelanguage.googleapis.com/v1beta')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    )
    expect(chatCompletionsUrl('https://generativelanguage.googleapis.com/v1beta/openai')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    )
    expect(chatCompletionsUrl('https://integrate.api.nvidia.com/v1')).toBe(
      'https://integrate.api.nvidia.com/v1/chat/completions',
    )
  })

  test('liveOpenAIStream posts to /v1beta/openai/chat/completions for Google Gemini', async () => {
    const urls: string[] = []
    const orig = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      urls.push(url)
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as typeof fetch
    try {
      await drain(
        await liveOpenAIStream({
          baseURL: 'https://generativelanguage.googleapis.com/v1beta',
          apiKey: 'gk-1',
          modelID: 'gemini-2.5-flash',
          opts: makeOpts(),
        }),
      )
    } finally {
      globalThis.fetch = orig
    }
    expect(urls).toEqual([
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    ])
  })
})


