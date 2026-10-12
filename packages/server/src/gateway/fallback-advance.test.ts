import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Subgateway } from './subgateway.js'
import { clearBreakerRegistry } from '../providers/circuit-breaker.js'
import { GlobalBus } from '../bus/index.js'
import type { MiraConfig } from '../types/index.js'

// P0-1 regression: the fallback chain only advanced on 401/429, so a provider
// outage (5xx) or a network failure killed the request even though fallbacks
// were configured, traced into `routing.fallbacks` / `subgateways.*.fallback`,
// and advertised in the `gateway.fallback` bus event.
//
// Contract asserted here:
//   503 / 500 / timeout / connection error → advance to the next candidate
//   400 / 404                            → terminal (another provider won't fix it)
//   abort                                → never retried

const PROVIDERS = {
  aaa: { baseURL: 'https://a.test/v1', apiKey: 'k-aaa' },
  bbb: { baseURL: 'https://b.test/v1', apiKey: 'k-bbb' },
} as const

function config(): MiraConfig {
  return {
    model: 'aaa/m1',
    smallModel: 'bbb/m1',
    permission: {},
    mcp: {},
    provider: {
      aaa: { name: 'A', options: { ...PROVIDERS.aaa, timeout: 5000, kind: 'aaa' }, models: {} },
      bbb: { name: 'B', options: { ...PROVIDERS.bbb, timeout: 5000, kind: 'bbb' }, models: {} },
    },
    routing: { aliases: {}, fallbacks: ['bbb/m1'], defaultProvider: 'aaa' },
    subgateways: {},
  } as unknown as MiraConfig
}

/** Records every host contacted and answers with the scripted status per host. */
let hosts: string[] = []
let respond: (host: string, attempt: number) => number | 'sse'

function installFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    const host = url.includes('b.test') ? 'b.test' : 'a.test'
    const attempt = hosts.filter((h) => h === host).length
    hosts.push(host)
    const verdict = respond(host, attempt)
    if (verdict === 'sse') {
      const body =
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
        'data: {"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n' +
        'data: [DONE]\n\n'
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response(JSON.stringify({ error: { message: `status ${verdict}` } }), {
      status: verdict,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}

function sub(): Subgateway {
  return new Subgateway({
    lane: 'default',
    config: {
      model: 'aaa/m1',
      fallback: ['bbb/m1'],
      rateLimit: { rps: 1000, burst: 1000 },
      // one attempt so the test measures candidate advancement, not retries
      retry: { maxAttempts: 1, baseMs: 1, maxMs: 2 },
      timeout: 5000,
      circuitBreaker: { failureThreshold: 99, resetTimeoutMs: 60_000 },
    },
    globalConfig: config(),
  })
}

async function drain(gw: Subgateway): Promise<string> {
  const it = await gw.stream({
    model: 'aaa/m1',
    messages: [{ role: 'user', content: 'hi' }],
  })
  let out = ''
  for await (const chunk of it) {
    if (chunk.type === 'text-delta') out += chunk.text
  }
  return out
}

const originalFetch = globalThis.fetch

beforeEach(() => {
  hosts = []
  respond = () => 503
  GlobalBus.clear()
  clearBreakerRegistry()
  installFetch()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  clearBreakerRegistry()
})

describe('fallback advances on provider failure (P0-1)', () => {
  test('503 on the primary falls through to the fallback provider', async () => {
    respond = (host) => (host === 'a.test' ? 503 : 'sse')
    const out = await drain(sub())
    expect(out).toContain('ok')
    expect(hosts).toContain('a.test')
    expect(hosts).toContain('b.test')
  })

  test('500 on the primary falls through', async () => {
    respond = (host) => (host === 'a.test' ? 500 : 'sse')
    await drain(sub())
    expect(hosts).toContain('b.test')
  })

  test('502 / 504 also fall through', async () => {
    for (const status of [502, 504]) {
      hosts = []
      respond = (host) => (host === 'a.test' ? status : 'sse')
      await drain(sub())
      expect(hosts).toContain('b.test')
    }
  })

  test('a network error on the primary falls through', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('a.test')) throw new Error('connect ECONNREFUSED')
      hosts.push('b.test')
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as typeof fetch
    const out = await drain(sub())
    expect(out).toContain('ok')
    expect(hosts).toContain('b.test')
  })

  test('429 still falls through (regression guard on the old behavior)', async () => {
    respond = (host) => (host === 'a.test' ? 429 : 'sse')
    await drain(sub())
    expect(hosts).toContain('b.test')
  })

  test('both providers down → the request fails', async () => {
    respond = () => 503
    await expect(drain(sub())).rejects.toThrow()
    expect(hosts.length).toBeGreaterThanOrEqual(2)
  })
})

describe('client errors stay terminal (no pointless retry)', () => {
  test('400 on the primary does NOT call the fallback', async () => {
    respond = () => 400
    await expect(drain(sub())).rejects.toThrow()
    expect(hosts).toEqual(['a.test'])
  })

  test('404 on the primary does NOT call the fallback', async () => {
    respond = () => 404
    await expect(drain(sub())).rejects.toThrow()
    expect(hosts).toEqual(['a.test'])
  })
})
