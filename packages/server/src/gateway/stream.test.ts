import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { liveOpenAIStream } from './stream.js'
import { ProviderError } from './errors.js'
import type { StreamOptions } from './types.js'

const BASE = 'https://api.test/v1'

const makeOpts = (over: Partial<StreamOptions> = {}): StreamOptions => ({
  model: 'test-model',
  messages: [{ role: 'user', content: 'hello' }],
  ...over,
}) as StreamOptions

const event = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function stubFetch(sse: string, init: { status?: number } = {}) {
  const captured: { url: string; init: RequestInit; body: Record<string, unknown> }[] = []
  const orig = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, reqInit?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (!url.startsWith('https://api.test')) return orig(input as RequestInfo, reqInit)
    const body = JSON.parse(String(reqInit?.body ?? '{}')) as Record<string, unknown>
    captured.push({ url, init: reqInit ?? {}, body })
    const status = init.status ?? 200
    if (status !== 200) {
      return new Response(body?.string ?? 'upstream error', { status, headers: {} })
    }
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  return { captured, restore: () => { globalThis.fetch = orig } }
}

async function drain(iter: AsyncIterable<any>) {
  const out: any[] = []
  for await (const c of iter) out.push(c)
  return out
}

describe('request shape', () => {
  test('posts with bearer auth and stream flags', async () => {
    const { captured, restore } = stubFetch(event({ choices: [{ delta: { content: 'x' } }] }) + 'data: [DONE]\n\n')
    await drain(await liveOpenAIStream({ baseURL: BASE, apiKey: 'sk-1', modelID: 'test-model', opts: makeOpts() }))
    restore()
    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe(`${BASE}/chat/completions`)
    expect(captured[0].init.headers.Authorization).toBe('Bearer sk-1')
    expect(captured[0].init.headers['Content-Type']).toBe('application/json')
    expect(captured[0].body.stream).toBe(true)
  })

  test('forwards maxTokens / temperature when provided', async () => {
    const { captured, restore } = stubFetch('data: [DONE]\n\n')
    await drain(await liveOpenAIStream({ baseURL: BASE, apiKey: 'k', modelID: 'm', opts: makeOpts({ maxTokens: 256, temperature: 0.2 }) }))
    restore()
    expect(captured[0].body.max_tokens).toBe(256)
    expect(captured[0].body.temperature).toBe(0.2)
  })

  test('system message included; claude gets array form', async () => {
    const { captured, restore } = stubFetch('data: [DONE]\n\n')
    await drain(
      await liveOpenAIStream({ baseURL: BASE, apiKey: 'k', modelID: 'claude-sonnet-4', opts: makeOpts({ system: 'be terse' }) }),
    )
    restore()
    const msgs = captured[0].body.messages as Array<{ role: string; content: string | Array<unknown> }>
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
          tools: { read_file: { description: 'read a file', parameters: { type: 'object' } } },
        }),
      }),
    )
    restore()
    expect(captured[0].body.tools?.[0].type).toBe('function')
    expect((captured[0].body.tools[0].function as Record<string, unknown>).name).toBe('read_file')
  })
})

describe('SSE parsing', () => {
  test('text deltas in order', async () => {
    const sse = event({ choices: [{ delta: { content: 'Hel' } }] }) + event({ choices: [{ delta: { content: 'lo' } }] }) + event({ choices: [{ delta: {}, finish_reason: 'stop' }] })
    const { captured, restore } = stubFetch(sse)
    const chunks = await drain(await liveOpenAIStream({ baseURL: BASE, apiKey: 'k', modelID: 'm', opts: makeOpts() }))
    restore()
    const text = chunks.filter((c: any) => c.type === 'text-delta').map((c: any) => c.text).join('')
    expect(text).toBe('Hello')
    expect(chunks.some((c: any) => c.type === 'finish')).toBe(true)
  })

  test('usage attached to finish chunk', async () => {
    const sse = event({ choices: [{ delta: { content: 'x' } }] }) + event({ usage: { prompt_tokens: 11, completion_tokens: 7 } }) + event({ choices: [{ delta: {}, finish_reason: 'stop' }] })
    const { captured, restore } = stubFetch(sse)
    const chunks = await drain(await liveOpenAIStream({ baseURL: BASE, apiKey: 'k', modelID: 'm', opts: makeOpts() }))
    restore()
    const finish = chunks.find((c: any) => c.type === 'finish')
    expect(finish.usage?.inputTokens).toBe(11)
    expect(finish.usage?.outputTokens).toBe(7)
  })

  test('malformed JSON event survived by next event', async () => {
    const sse = 'data: {not json\n\n' + event({ choices: [{ delta: { content: 'survived' } }] }) + 'data: [DONE]\n\n'
    const { captured, restore } = stubFetch(sse)
    const chunks = await drain(await liveOpenAIStream({ baseURL: BASE, apiKey: 'k', modelID: 'm', opts: makeOpts() }))
    restore()
    const text = chunks.filter((c: any) => c.type === 'text-delta').map((c: any) => c.text).join('')
    expect(text).toBe('survived')
  })

  test('events after [DONE] ignored', async () => {
    const sse = event({ choices: [{ delta: { content: 'before' } }] }) + 'data: [DONE]\n\n' + event({ choices: [{ delta: { content: 'after' } }] })
    const { captured, restore } = stubFetch(sse)
    const chunks = await drain(await liveOpenAIStream({ baseURL: BASE, apiKey: 'k', modelID: 'm', opts: makeOpts() }))
    restore()
    const text = chunks.filter((c: any) => c.type === 'text-delta').map((c: any) => c.text).join('')
    expect(text).toBe('before')
  })
})

describe('tool-call accumulation', () => {
  test('argument fragments joined and parsed at flush', async () => {
    const sse =
      event({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '{"pa' } }] } }] }) +
      event({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"/a' } }] } }] }) +
      event({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '.ts"}' } }] } }] }) +
      event({ choices: [{ delta: { tool_calls: [], finish_reason: 'tool_calls' } }] })
    const { captured, restore } = stubFetch(sse)
    const chunks = await drain(await liveOpenAIStream({ baseURL: BASE, apiKey: 'k', modelID: 'm', opts: makeOpts() }))
    restore()
    const call = chunks.find((c: any) => c.type === 'tool-call')
    expect(call).toBeTruthy()
    expect(call.toolCall.id).toBe('call_1')
    expect(call.toolCall.name).toBe('read')
    expect(call.toolCall.args).toEqual({ path: '/a.ts' })
  })

  test('parallel tool calls (distinct indices) emitted separately', async () => {
    const sse =
      event({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c0', function: { name: 'a', arguments: '{}' } }] } }] }) +
      event({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'c1', function: { name: 'b', arguments: '{}' } }] } }] }) +
      event({ choices: [{ delta: { tool_calls: [], finish_reason: 'tool_calls' } }] }) +
      event({ choices: [{ delta: { tool_calls: [], finish_reason: 'tool_calls' } }] })
    const { captured, restore } = stubFetch(sse)
    const chunks = await drain(await liveOpenAIStream({ baseURL: BASE, apiKey: 'k', modelID: 'm', opts: makeOpts() }))
    restore()
    const calls = chunks.filter((c: any) => c.type === 'tool-call')
    expect(calls.length).toBe(2)
    expect(calls.map((c: any) => c.toolCall.id).sort()).toEqual(['c0', 'c1'])
  })

  test('invalid arg JSON yields empty args', async () => {
    const sse =
      event({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'bad', function: { name: 'x', arguments: '{oops' } }] } }] }) +
      event({ choices: [{ delta: { tool_calls: [], finish_reason: 'tool_calls' } }] })
    const { captured, restore } = stubFetch(sse)
    const chunks = await drain(await liveOpenAIStream({ baseURL: BASE, apiKey: 'k', modelID: 'm', opts: makeOpts() }))
    restore()
    const call = chunks.find((c: any) => c.type === 'tool-call')
    expect(call.toolCall.id).toBe('bad')
    expect(call.toolCall.args).toEqual({})
  })
})

describe('error mapping', () => {
  test('429 maps to RATE_LIMITED with retry-after', async () => {
    const { captured, restore } = stubFetch('', { status: 429 })
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
    const { restore } = stubFetch('', { status: 500, body: 'upstream error' })
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