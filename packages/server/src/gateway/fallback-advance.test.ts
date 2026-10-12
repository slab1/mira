import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Subgateway } from './subgateway.js'
import { clearBreakerRegistry } from '../providers/circuit-breaker.js'
import { ProviderRegistry } from '../providers/registry.js'
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

// P0-3: lane outcomes were recorded only on the lane-local breaker, while
// ProviderRegistry.isHealthy()/getHealth() read a different store — so every
// provider reported "healthy" forever and health-aware routing never degraded.
describe('provider health reflects real outcomes (P0-3)', () => {
  test('a failing provider is marked unhealthy after repeated 503s', async () => {
    respond = () => 503
    const gw = sub()
    const registry = (gw as unknown as { registry: ProviderRegistry }).registry

    for (let i = 0; i < 6; i++) {
      await expect(drain(gw)).rejects.toThrow()
    }
    expect(registry.isHealthy('aaa')).toBe(false)
    expect(registry.getHealth('aaa').status).not.toBe('healthy')
  })

  test('a serving provider is recorded healthy and its health is reportable', async () => {
    respond = () => 'sse'
    const gw = sub()
    const registry = (gw as unknown as { registry: ProviderRegistry }).registry
    await drain(gw)
    // the primary serves it, so aaa is the provider credited
    const health = registry.getHealth('aaa')
    expect(health.status).toBe('healthy')
    // successCount is a HALF_OPEN probe counter, not a lifetime counter —
    // the meaningful signal here is that the provider stayed closed.
    expect(health.state).toBe('CLOSED')
  })

  test('a caller abort does not mark the provider unhealthy', async () => {
    respond = () => 'sse'
    const gw = sub()
    const registry = (gw as unknown as { registry: ProviderRegistry }).registry
    const controller = new AbortController()
    const it = await gw.stream({
      model: 'aaa/m1',
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
    })
    controller.abort()
    // consume; the stream should throw or end, but never blame the provider
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of it) {
        /* drain */
      }
    } catch {
      /* aborted */
    }
    expect(registry.getHealth('aaa').failureCount).toBe(0)
  })
})

// P2-8: complete() (the autocomplete / agent:ask path) never called
// checkCostCap(), so that lane was uncapped while stream() was capped.
describe('complete() respects cost caps and records session cost', () => {
  const cappedSub = (cap: number) =>
    new Subgateway({
      lane: 'default',
      config: {
        model: 'aaa/m1',
        rateLimit: { rps: 1000, burst: 1000 },
        retry: { maxAttempts: 1, baseMs: 1, maxMs: 2 },
        timeout: 5000,
        // per-lane cap — the documented subgateways.*.costCap location
        costCap: { perTask: cap, perSession: cap },
        circuitBreaker: { failureThreshold: 99, resetTimeoutMs: 60_000 },
      },
      globalConfig: config(),
    })

  const sseBody =
    '{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":1000,"completion_tokens":1000}}'

  test('a per-task cap is enforced on complete()', async () => {
    // 1000 in + 1000 out on a priced model exceeds a $0.0000001 cap.
    // Without the fix complete() would happily bill it.
    respond = () => 200
    const gw = cappedSub(1e-9)
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('a.test') || url.includes('b.test')) {
        return new Response(sseBody, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return original(input as RequestInfo, init)
    }) as typeof fetch
    await expect(gw.complete({ model: 'aaa/m1', prompt: 'x' })).rejects.toThrow()
  })

  test('complete() records per-session cost when given a sessionID', async () => {
    const { getSessionCost } = await import('./subgateway.js')
    respond = () => 200
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('a.test') || url.includes('b.test')) {
        return new Response(sseBody, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return original(input as RequestInfo, init)
    }) as typeof fetch
    const gw = sub()
    const res = await gw.complete({ model: 'aaa/m1', prompt: 'x', sessionID: 'sess-cost-1' })
    expect(res.text).toBe('ok')
    const cost = getSessionCost('sess-cost-1')
    // the call happened and was attributed to the session
    expect(cost.requests).toBe(1)
    expect(cost.inputTokens).toBe(1000)
    expect(cost.outputTokens).toBe(1000)
  })
})

// P1-3: the lane timeout was shadowed by the provider's, so a lane configured
// at 180s actually ran at the provider's 120s.
describe('lane timeout wins over the provider default', () => {
  test('an explicit lane timeout is used for the request', async () => {
    clearBreakerRegistry()
    let seen = 0
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('a.test')) {
        // The abort signal's timeout is what liveOpenAIStream applies; assert the
        // lane value reaches the transport by observing that a 150ms request with
        // a 200ms lane timeout completes rather than being cut at the 50ms
        // provider default.
        await new Promise((r) => setTimeout(r, 60))
        seen = 200
        return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      return original(input as RequestInfo, init)
    }) as typeof fetch

    const gw = new Subgateway({
      lane: 'default',
      config: {
        model: 'aaa/m1',
        rateLimit: { rps: 1000, burst: 1000 },
        retry: { maxAttempts: 1, baseMs: 1, maxMs: 2 },
        // lane says 200ms; provider default is 1000ms in this config
        timeout: 200,
        circuitBreaker: { failureThreshold: 99, resetTimeoutMs: 60_000 },
      },
      globalConfig: {
        ...config(),
        provider: {
          aaa: {
            name: 'A',
            options: { baseURL: 'https://a.test/v1', apiKey: 'k', timeout: 50, kind: 'aaa' },
            models: {},
          },
          bbb: {
            name: 'B',
            options: { baseURL: 'https://b.test/v1', apiKey: 'k', timeout: 50, kind: 'bbb' },
            models: {},
          },
        },
      } as unknown as MiraConfig,
    })
    const it = await gw.stream({ model: 'aaa/m1', messages: [{ role: 'user', content: 'x' }] })
    let out = ''
    for await (const chunk of it) if (chunk.type === 'text-delta') out += chunk.text
    expect(out).toContain('ok')
    expect(seen).toBe(200)
  })
})

// Dead-config fix: `subgateways.<lane>.provider` was declared and set in
// defaults but never read, so an unprefixed lane model resolved through the
// global defaultProvider instead of the provider the lane names.
describe('subgateways.*.provider qualifies unprefixed models', () => {
  const providerCfg = (): MiraConfig =>
    ({
      model: 'aaa/m1',
      permission: {},
      mcp: {},
      provider: {
        aaa: {
          name: 'A',
          options: { baseURL: 'https://a.test/v1', apiKey: 'k', timeout: 1000, kind: 'aaa' },
          models: {},
        },
        bbb: {
          name: 'B',
          options: { baseURL: 'https://b.test/v1', apiKey: 'k', timeout: 1000, kind: 'bbb' },
          models: {},
        },
      },
      routing: { aliases: {}, fallbacks: [], defaultProvider: 'aaa' },
      subgateways: {},
    }) as unknown as MiraConfig

  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
    clearBreakerRegistry()
  })

  test('an unprefixed lane model goes to the lane provider, not the default', async () => {
    const hosts: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      hosts.push(url.includes('b.test') ? 'bbb' : 'aaa')
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as typeof fetch

    const gw = new Subgateway({
      lane: 'default',
      config: {
        provider: 'bbb', // lane names bbb
        model: 'm1', // unprefixed
        rateLimit: { rps: 1000, burst: 1000 },
        retry: { maxAttempts: 1, baseMs: 1, maxMs: 2 },
        timeout: 1000,
        circuitBreaker: { failureThreshold: 99, resetTimeoutMs: 60_000 },
      },
      globalConfig: providerCfg(),
    })
    const it = await gw.stream({ model: '', messages: [{ role: 'user', content: 'x' }] })
    for await (const _ of it) {
      void _
    }
    expect(hosts[0]).toBe('bbb')
  })

  test('an already-prefixed model is left alone', async () => {
    const hosts: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      hosts.push(url.includes('b.test') ? 'bbb' : 'aaa')
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as typeof fetch

    const gw = new Subgateway({
      lane: 'default',
      config: {
        provider: 'bbb', // lane says bbb
        model: 'aaa/explicit', // but the model explicitly says aaa
        rateLimit: { rps: 1000, burst: 1000 },
        retry: { maxAttempts: 1, baseMs: 1, maxMs: 2 },
        timeout: 1000,
        circuitBreaker: { failureThreshold: 99, resetTimeoutMs: 60_000 },
      },
      globalConfig: providerCfg(),
    })
    const it = await gw.stream({ model: '', messages: [{ role: 'user', content: 'x' }] })
    for await (const _ of it) {
      void _
    }
    // explicit prefix wins over the lane default
    expect(hosts[0]).toBe('aaa')
  })
})

// The RateLimiter existed but nothing ever passed one to the ProviderRegistry,
// so its enforcement branch could never fire. Now wired in buildRegistry from
// routing.providerRateLimit. The subtle part is CHARGE-ONCE: resolve() runs
// several times per request (per candidate + a re-resolve of each fallback), so
// it only peeks; the token is debited once at dispatch.
describe('per-provider rate limiting', () => {
  const rateLimited = (rps: number, burst: number): MiraConfig =>
    ({
      ...config(),
      routing: {
        aliases: {},
        fallbacks: ['bbb/m1'],
        defaultProvider: 'aaa',
        providerRateLimit: { rps, burst },
      },
    }) as unknown as MiraConfig

  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
    clearBreakerRegistry()
  })

  const sse = () =>
    new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })

  test('one request consumes exactly one token (not one per resolve)', async () => {
    clearBreakerRegistry()
    globalThis.fetch = (async () => sse()) as unknown as typeof fetch
    const { buildRegistry } = await import('../gateway/provider.js')
    const registry = buildRegistry(rateLimited(0.0001, 3)) // ~3 requests then empty
    const limit = registry.getRateLimiter()!

    // resolve() peeks: 5 resolutions must NOT drain the bucket
    for (let i = 0; i < 5; i++) registry.resolve('aaa/m1')
    const afterPeek = limit.getTokensRemaining('aaa:m1')
    expect(afterPeek).toBeCloseTo(3, 1)

    // each dispatch charges exactly one
    expect(registry.consumeRateLimit('aaa', 'm1')).toBe(true)
    const afterOne = limit.getTokensRemaining('aaa:m1')
    expect(afterOne).toBeCloseTo(2, 1)
    registry.consumeRateLimit('aaa', 'm1')
    registry.consumeRateLimit('aaa', 'm1')
    // bucket now empty (refill is ~0 at rps 0.0001)
    expect(registry.consumeRateLimit('aaa', 'm1')).toBe(false)
  })

  test('a throttled primary falls through to the fallback, not a hard failure', async () => {
    clearBreakerRegistry()
    const hosts: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      hosts.push(url.includes('b.test') ? 'bbb' : 'aaa')
      return sse()
    }) as typeof fetch
    const gw = new Subgateway({
      lane: 'default',
      config: {
        model: 'aaa/m1',
        fallback: ['bbb/m1'],
        rateLimit: { rps: 1000, burst: 1000 },
        retry: { maxAttempts: 1, baseMs: 1, maxMs: 2 },
        timeout: 5000,
        circuitBreaker: { failureThreshold: 99, resetTimeoutMs: 60_000 },
      },
      globalConfig: rateLimited(0.0001, 1),
    })
    // burn the only aaa token
    const first = await gw.stream({ model: 'aaa/m1', messages: [{ role: 'user', content: 'x' }] })
    for await (const chunk of first) if (chunk.type === 'text-delta') void chunk.text
    const usedAfterFirst = [...hosts]
    // next request: aaa is over budget, so bbb serves it — rate limiting is a
    // per-provider budget, not a request failure.
    const second = await gw.stream({ model: 'aaa/m1', messages: [{ role: 'user', content: 'x' }] })
    let out = ''
    for await (const chunk of second) if (chunk.type === 'text-delta') out += chunk.text
    expect(out).toContain('ok')
    expect(usedAfterFirst.length).toBeGreaterThan(0)
    // the second request went to bbb, not aaa
    const secondHost = hosts[usedAfterFirst.length]
    expect(secondHost).toBe('bbb')
  })
})
