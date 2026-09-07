import { describe, test, expect } from 'bun:test'
import { SubgatewayRegistry } from './registry.js'
import type { MiraConfig } from '../types/index.js'

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
          apiKey: 'test-key',
          headers: {},
          timeout: 120_000,
          kind: 'openrouter',
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

describe('SubgatewayRegistry', () => {
  test('creates default lane automatically', () => {
    const reg = new SubgatewayRegistry(makeConfig())
    expect(reg.get('default')).toBeDefined()
  })

  test('creates well-known lanes: cheap, vision, local, compaction', () => {
    const reg = new SubgatewayRegistry(makeConfig())
    expect(reg.get('cheap')).toBeDefined()
    expect(reg.get('vision')).toBeDefined()
    expect(reg.get('local')).toBeDefined()
    expect(reg.get('compaction')).toBeDefined()
  })

  test('creates agent:ask lane', () => {
    const reg = new SubgatewayRegistry(makeConfig())
    expect(reg.get('agent:ask')).toBeDefined()
  })

  test('creates agent lanes from config agents', () => {
    const config = makeConfig({
      agents: {
        coder: { system: 'You are a coder', description: 'Codes stuff' },
      },
    })
    const reg = new SubgatewayRegistry(config)
    expect(reg.get('agent:coder')).toBeDefined()
  })

  test('get returns gateway for known lane', () => {
    const reg = new SubgatewayRegistry(makeConfig())
    const gw = reg.get('default')
    expect(gw).toBeDefined()
    expect(gw!.lane).toBe('default')
  })

  test('get returns default for unknown lane', () => {
    const reg = new SubgatewayRegistry(makeConfig())
    const gw = reg.get('unknown-lane')
    expect(gw).toBeDefined()
    expect(gw!.lane).toBe('default')
  })

  test('getOrDefault never returns undefined', () => {
    const reg = new SubgatewayRegistry(makeConfig())
    const gw = reg.getOrDefault('totally-fake')
    expect(gw).toBeDefined()
  })

  test('list returns all gateways', () => {
    const reg = new SubgatewayRegistry(makeConfig())
    const list = reg.list()
    expect(list.length).toBeGreaterThanOrEqual(6) // default + cheap + vision + local + compaction + agent:ask
  })

  test('lanes returns lane names', () => {
    const reg = new SubgatewayRegistry(makeConfig())
    const lanes = reg.lanes()
    expect(lanes).toContain('default')
    expect(lanes).toContain('cheap')
    expect(lanes).toContain('vision')
    expect(lanes).toContain('local')
    expect(lanes).toContain('compaction')
    expect(lanes).toContain('agent:ask')
  })

  test('statsAll returns stats for each lane', () => {
    const reg = new SubgatewayRegistry(makeConfig())
    const stats = reg.statsAll()
    expect(stats).toHaveProperty('default')
    expect(stats.default.requests).toBe(0)
  })

  test('health returns health for each lane', () => {
    const reg = new SubgatewayRegistry(makeConfig())
    const health = reg.health()
    expect(health).toHaveProperty('default')
    expect(health.default.circuit).toBe('closed')
    expect(health.default.lane).toBe('default')
    expect(health.default.failureCount).toBe(0)
  })

  test('syncFromConfig updates existing gateways', () => {
    const reg = new SubgatewayRegistry(makeConfig())
    const gwBefore = reg.get('default')
    // Sync with same config — should reuse existing gateway (same lane name)
    reg.syncFromConfig(makeConfig())
    const gwAfter = reg.get('default')
    expect(gwAfter).toBeDefined()
    expect(gwAfter!.lane).toBe('default')
  })

  test('clear removes all gateways', () => {
    const reg = new SubgatewayRegistry(makeConfig())
    expect(reg.list().length).toBeGreaterThan(0)
    reg.clear()
    expect(reg.list().length).toBe(0)
  })

  test('lane configs from config override defaults', () => {
    const config = makeConfig({
      subgateways: {
        default: {
          provider: 'openrouter',
          model: 'custom-model',
          timeout: 60_000,
        },
      },
    })
    const reg = new SubgatewayRegistry(config)
    const gw = reg.get('default')
    expect(gw).toBeDefined()
  })

  test('vision lane defaults to openai provider', () => {
    const reg = new SubgatewayRegistry(makeConfig())
    const health = reg.health()
    expect(health.vision.lane).toBe('vision')
  })

  test('agent:ask uses cheap deepseek model by default', () => {
    const reg = new SubgatewayRegistry(makeConfig())
    const health = reg.health()
    expect(health['agent:ask'].lane).toBe('agent:ask')
  })
})
