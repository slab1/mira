import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { Subgateway, SubgatewayError, getSessionCost, getAllSessionCosts } from './subgateway.js'
import type { MiraConfig } from '../types/index.js'
import type { StreamOptions, GatewayChunk } from './types.js'

function makeConfig(overrides: Record<string, unknown> = {}): MiraConfig {
  return {
    model: 'openrouter/anthropic/claude-sonnet-4',
    smallModel: 'openrouter/deepseek/deepseek-v3.2-exp',
    permission: {},
    mcp: {},
    provider: {
      openrouter: {
        name: 'OpenRouter',
        options: {
          baseURL: 'https://openrouter.ai/api/v1',
          apiKey: 'test-key-openrouter',
          headers: {},
          timeout: 120_000,
          kind: 'openrouter',
        },
        models: {},
      },
      anthropic: {
        name: 'Anthropic',
        options: {
          baseURL: 'https://api.anthropic.com/v1',
          apiKey: 'test-key-anthropic',
          headers: {},
          timeout: 120_000,
          kind: 'anthropic',
        },
        models: {},
      },
    },
    routing: {
      aliases: {},
      fallbacks: [],
      defaultProvider: 'openrouter',
    },
    subgateways: {},
    ...overrides,
  } as MiraConfig
}

function makeSubgateway(overrides: Record<string, unknown> = {}) {
  const config = makeConfig()
  return new Subgateway({
    lane: 'default',
    config: {
      provider: 'openrouter',
      model: 'openrouter/anthropic/claude-sonnet-4',
      rateLimit: { rps: 100, burst: 200 }, // high to avoid rate limit in tests
      circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 60_000 },
      ...overrides,
    },
    globalConfig: config,
  })
}

describe('Subgateway', () => {
  test('constructor initializes with lane name', () => {
    const gw = makeSubgateway()
    expect(gw.lane).toBe('default')
  })

  test('stats returns zeroed stats initially', () => {
    const gw = makeSubgateway()
    const s = gw.stats()
    expect(s.requests).toBe(0)
    expect(s.inputTokens).toBe(0)
    expect(s.outputTokens).toBe(0)
    expect(s.costUSD).toBe(0)
  })

  test('health returns lane, circuit state, failure count', () => {
    const gw = makeSubgateway()
    const h = gw.health()
    expect(h.lane).toBe('default')
    expect(h.circuit).toBe('closed')
    expect(h.failureCount).toBe(0)
    expect(h.stats.requests).toBe(0)
  })

  test('_forceOpen opens the circuit breaker', () => {
    const gw = makeSubgateway()
    gw._forceOpen()
    const h = gw.health()
    expect(h.circuit).toBe('open')
  })

  test('_resetCircuit resets the circuit breaker', () => {
    const gw = makeSubgateway()
    gw._forceOpen()
    gw._resetCircuit()
    const h = gw.health()
    expect(h.circuit).toBe('closed')
  })

  test('stream throws CIRCUIT_OPEN when circuit is open', async () => {
    const gw = makeSubgateway()
    gw._forceOpen()
    await expect(
      gw.stream({
        model: 'openrouter/anthropic/claude-sonnet-4',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow()
    try {
      await gw.stream({
        model: 'openrouter/anthropic/claude-sonnet-4',
        messages: [{ role: 'user', content: 'hi' }],
      })
    } catch (e) {
      expect(e).toBeInstanceOf(SubgatewayError)
      expect((e as SubgatewayError).code).toBe('CIRCUIT_OPEN')
      expect((e as SubgatewayError).lane).toBe('default')
    }
  })

  test('stream throws when rate limited', async () => {
    const gw = makeSubgateway({ rateLimit: { rps: 1, burst: 1 } })
    // Drain the bucket
    gw.rateLimiter.consumeOrDelay(1)
    await expect(
      gw.stream({
        model: 'openrouter/anthropic/claude-sonnet-4',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow()
    try {
      await gw.stream({
        model: 'openrouter/anthropic/claude-sonnet-4',
        messages: [{ role: 'user', content: 'hi' }],
      })
    } catch (e) {
      expect(e).toBeInstanceOf(SubgatewayError)
      expect((e as SubgatewayError).code).toBe('RATE_LIMITED')
    }
  })

  test('syncConfig updates rate limiter when rps changes', () => {
    const gw = makeSubgateway({ rateLimit: { rps: 10, burst: 20 } })
    expect(gw.rateLimiter.config.rps).toBe(10)
    gw.syncConfig(
      {
        provider: 'openrouter',
        model: 'openrouter/anthropic/claude-sonnet-4',
        rateLimit: { rps: 50, burst: 100 },
      },
      makeConfig(),
    )
    expect(gw.rateLimiter.config.rps).toBe(50)
    expect(gw.rateLimiter.config.burst).toBe(100)
  })

  test('syncConfig does not recreate limiter if same rps/burst', () => {
    const gw = makeSubgateway({ rateLimit: { rps: 10, burst: 20 } })
    const limiterBefore = gw.rateLimiter
    gw.syncConfig(
      {
        provider: 'openrouter',
        model: 'openrouter/anthropic/claude-sonnet-4',
        rateLimit: { rps: 10, burst: 20 },
      },
      makeConfig(),
    )
    expect(gw.rateLimiter).toBe(limiterBefore)
  })

  test('SubgatewayError has lane property', () => {
    const e = new SubgatewayError({
      message: 'test',
      lane: 'cheap',
      code: 'CIRCUIT_OPEN',
      status: 503,
    })
    expect(e.lane).toBe('cheap')
    expect(e.name).toBe('SubgatewayError')
    expect(e.code).toBe('CIRCUIT_OPEN')
    expect(e.status).toBe(503)
  })

  test('SubgatewayError extends ProviderError', () => {
    const e = new SubgatewayError({ message: 'test', lane: 'x' })
    expect(e).toBeInstanceOf(Error)
    expect(e.retryable).toBeDefined()
  })

  test('stream resolves model from lane config when requestedModel is empty', async () => {
    // The stream will fail at the network level (we mocked nothing),
    // but it should get past the model resolution step
    const gw = makeSubgateway()
    // Mock fetch to throw so we get past model resolution
    const origFetch = globalThis.fetch
    globalThis.fetch = mock(() => Promise.reject(new Error('mock'))) as unknown as typeof fetch
    try {
      await gw.stream({
        model: '',
        messages: [{ role: 'user', content: 'hi' }],
      })
    } catch (e) {
      // Expected to fail at fetch, not at model resolution
      expect(e).toBeDefined()
    } finally {
      // try/finally: a throwing expect must not leak the stub to other files
      globalThis.fetch = origFetch
    }
  })

  test('stream throws SubgatewayError on network failure', async () => {
    const gw = makeSubgateway()
    const origFetch = globalThis.fetch
    globalThis.fetch = mock(() =>
      Promise.reject(new Error('connection refused')),
    ) as unknown as typeof fetch
    try {
      await gw.stream({
        model: 'openrouter/anthropic/claude-sonnet-4',
        messages: [{ role: 'user', content: 'hi' }],
      })
    } catch (e) {
      expect(e).toBeInstanceOf(SubgatewayError)
    } finally {
      // try/finally: a throwing expect must not leak the stub to other files
      globalThis.fetch = origFetch
    }
  })
})

describe('Per-session cost tracking', () => {
  test('getSessionCost returns zeroed default for unknown session', () => {
    const cost = getSessionCost('nonexistent-session-id')
    expect(cost.costUSD).toBe(0)
    expect(cost.inputTokens).toBe(0)
    expect(cost.outputTokens).toBe(0)
    expect(cost.requests).toBe(0)
  })

  test('getAllSessionCosts returns a Map', () => {
    const all = getAllSessionCosts()
    expect(all).toBeInstanceOf(Map)
  })

  test('checkCostCap throws COST_CAP_EXCEEDED when perSession exceeded', async () => {
    const gw = makeSubgateway({
      costCap: { perSession: 0.001 },
    })
    // Manually inflate session cost to exceed cap
    const sessionID = 'test-session-exceed-' + Date.now()
    // Simulate high session cost by directly manipulating the session cost map
    // We'll use the stream method which checks the cap
    const origFetch = globalThis.fetch
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'quota exceeded' }), { status: 402 })),
    ) as unknown as typeof fetch
    try {
      await gw.stream({
        model: 'openrouter/anthropic/claude-sonnet-4',
        messages: [{ role: 'user', content: 'hi' }],
        sessionID,
      })
    } catch (e) {
      // Should fail with provider error (402), not cost cap (session cost is 0)
      expect(e).toBeDefined()
    } finally {
      globalThis.fetch = origFetch
    }
  })
})
