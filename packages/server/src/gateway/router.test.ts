import { describe, test, expect } from 'bun:test'
import { GatewayRouter } from './router.js'
import type { MiraConfig } from '../types/index.js'
import type { Gateway, GatewayStats, StreamOptions, GatewayChunk } from './types.js'
import type { SubgatewayRegistry } from './registry.js'

// Stub gateway for tests
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

// Minimal registry stub that implements only what GatewayRouter needs
function createStubRegistry(
  availableLanes: string[] = ['default', 'cheap', 'vision', 'local', 'compaction', 'agent:ask'],
): SubgatewayRegistry {
  const stubs = new Map<string, Gateway>()
  for (const lane of availableLanes) {
    stubs.set(lane, { ...stubGateway })
  }
  return {
    get: (lane: string) => stubs.get(lane) ?? stubs.get('default'),
    getOrDefault: (lane: string) => stubs.get(lane) ?? stubs.get('default')!,
    lanes: () => availableLanes,
    list: () => [...stubs.values()],
    statsAll: () => ({}),
    health: () => ({}),
    syncFromConfig: () => {},
    clear: () => stubs.clear(),
  } as unknown as SubgatewayRegistry
}

function makeConfig(overrides: Partial<MiraConfig> = {}): MiraConfig {
  return {
    model: 'openrouter/anthropic/claude-sonnet-4',
    permission: {},
    mcp: {},
    provider: {},
    routing: {},
    subgateways: {},
    ...overrides,
  } as MiraConfig
}

describe('GatewayRouter.resolve', () => {
  test('summarize task routes to compaction lane', () => {
    const router = new GatewayRouter(createStubRegistry(), makeConfig())
    expect(router.resolve({ task: 'summarize' })).toBe('compaction')
  })

  test('vision task routes to vision lane', () => {
    const router = new GatewayRouter(createStubRegistry(), makeConfig())
    expect(router.resolve({ task: 'vision' })).toBe('vision')
  })

  test('messages with image_url in string content route to vision', () => {
    const router = new GatewayRouter(createStubRegistry(), makeConfig())
    const messages = [
      { role: 'user', content: 'Look at this image_url https://example.com/pic.png' },
    ]
    expect(router.resolve({ messages })).toBe('vision')
  })

  test('messages with image_url part type route to vision', () => {
    const router = new GatewayRouter(createStubRegistry(), makeConfig())
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } },
        ] as unknown as string,
      },
    ]
    expect(router.resolve({ messages })).toBe('vision')
  })

  test('model containing "gpt-4o" routes to vision', () => {
    const router = new GatewayRouter(createStubRegistry(), makeConfig())
    expect(router.resolve({ model: 'openai/gpt-4o' })).toBe('vision')
  })

  test('model containing "vision" routes to vision', () => {
    const router = new GatewayRouter(createStubRegistry(), makeConfig())
    expect(router.resolve({ model: 'claude-vision-3' })).toBe('vision')
  })

  test('model containing "deepseek" routes to cheap', () => {
    const router = new GatewayRouter(createStubRegistry(), makeConfig())
    expect(router.resolve({ model: 'openrouter/deepseek/deepseek-v3' })).toBe('cheap')
  })

  test('model containing "haiku" routes to cheap', () => {
    const router = new GatewayRouter(createStubRegistry(), makeConfig())
    expect(router.resolve({ model: 'anthropic/claude-3-haiku' })).toBe('cheap')
  })

  test('model containing "flash" routes to cheap', () => {
    const router = new GatewayRouter(createStubRegistry(), makeConfig())
    expect(router.resolve({ model: 'google/gemini-flash' })).toBe('cheap')
  })

  test('model containing "mini" routes to cheap', () => {
    const router = new GatewayRouter(createStubRegistry(), makeConfig())
    expect(router.resolve({ model: 'openai/gpt-4.1-mini' })).toBe('cheap')
  })

  test('model starting with "local/" routes to local', () => {
    const router = new GatewayRouter(createStubRegistry(), makeConfig())
    expect(router.resolve({ model: 'local/llama-3' })).toBe('local')
  })

  test('model containing "ollama" routes to local', () => {
    const router = new GatewayRouter(createStubRegistry(), makeConfig())
    expect(router.resolve({ model: 'ollama/llama-3' })).toBe('local')
  })

  test('model containing "lmstudio" routes to local', () => {
    const router = new GatewayRouter(createStubRegistry(), makeConfig())
    expect(router.resolve({ model: 'lmstudio/llama-3' })).toBe('local')
  })

  test('agent binding routes to agent:{name} lane if it exists', () => {
    const router = new GatewayRouter(createStubRegistry(), makeConfig())
    expect(router.resolve({ agent: 'ask' })).toBe('agent:ask')
  })

  test('cheapTier flag routes to cheap', () => {
    const router = new GatewayRouter(createStubRegistry(), makeConfig())
    expect(router.resolve({ cheapTier: true })).toBe('cheap')
  })

  test('autoModel.enabled + tier=cheap routes to cheap', () => {
    const config = makeConfig({ autoModel: { enabled: true, tier: 'cheap' } } as any)
    const router = new GatewayRouter(createStubRegistry(), config)
    expect(router.resolve({})).toBe('cheap')
  })

  test('fallback to default lane', () => {
    const router = new GatewayRouter(createStubRegistry(), makeConfig())
    expect(router.resolve({})).toBe('default')
  })

  test('model matching "cheap" keyword routes to cheap', () => {
    const router = new GatewayRouter(createStubRegistry(), makeConfig())
    expect(router.resolve({ model: 'cheap-model-xyz' })).toBe('cheap')
  })

  test('provider-specific model without cheap/local/vision keywords defaults to default', () => {
    const router = new GatewayRouter(createStubRegistry(), makeConfig())
    expect(router.resolve({ model: 'openrouter/anthropic/claude-sonnet-4' })).toBe('default')
  })
})

describe('GatewayRouter syncConfig', () => {
  test('syncConfig updates internal config', () => {
    const router = new GatewayRouter(createStubRegistry(), makeConfig())
    router.syncConfig(makeConfig({ model: 'new-model' }))
    // The router should use the new config for autoModel checks
  })
})

describe('GatewayRouter getCompactionGateway / getVisionGateway', () => {
  test('getCompactionGateway returns compaction lane gateway', () => {
    const registry = createStubRegistry()
    const router = new GatewayRouter(registry, makeConfig())
    const gw = router.getCompactionGateway()
    expect(gw).toBeDefined()
    expect(gw.stats()).toBeDefined()
  })

  test('getVisionGateway returns vision lane gateway', () => {
    const registry = createStubRegistry()
    const router = new GatewayRouter(registry, makeConfig())
    const gw = router.getVisionGateway()
    expect(gw).toBeDefined()
    expect(gw.stats()).toBeDefined()
  })
})
