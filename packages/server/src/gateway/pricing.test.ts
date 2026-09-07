import { describe, test, expect } from 'bun:test'
import {
  PRICING_TABLE,
  priceFor,
  createUsageStats,
  record,
  statsSnapshot,
  GatewayStatsStore,
} from './pricing.js'

describe('priceFor', () => {
  test('returns correct pricing for claude-opus models', () => {
    const [input, output] = priceFor('openrouter/anthropic/claude-opus-4')
    expect(input).toBe(15)
    expect(output).toBe(75)
  })

  test('returns correct pricing for claude-sonnet models', () => {
    const [input, output] = priceFor('anthropic/claude-sonnet-4')
    expect(input).toBe(3)
    expect(output).toBe(15)
  })

  test('returns correct pricing for claude-haiku models', () => {
    const [input, output] = priceFor('claude-3-haiku')
    expect(input).toBe(0.8)
    expect(output).toBe(4)
  })

  test('returns correct pricing for gpt-4o', () => {
    const [input, output] = priceFor('openai/gpt-4o')
    expect(input).toBe(2.5)
    expect(output).toBe(10)
  })

  test('returns correct pricing for gpt-4 (non-4o)', () => {
    const [input, output] = priceFor('openai/gpt-4-turbo')
    expect(input).toBe(10)
    expect(output).toBe(30)
  })

  test('returns correct pricing for deepseek', () => {
    const [input, output] = priceFor('openrouter/deepseek/deepseek-v3')
    expect(input).toBe(0.27)
    expect(output).toBe(1.1)
  })

  test('returns correct pricing for gemini', () => {
    const [input, output] = priceFor('google/gemini-2.0-flash')
    expect(input).toBe(1.25)
    expect(output).toBe(5)
  })

  test('returns correct pricing for llama', () => {
    const [input, output] = priceFor('meta-llama/llama-3')
    expect(input).toBe(0.5)
    expect(output).toBe(0.8)
  })

  test('returns correct pricing for mistral', () => {
    const [input, output] = priceFor('mistral/mistral-large')
    expect(input).toBe(0.5)
    expect(output).toBe(0.8)
  })

  test('falls back to default pricing [1, 2] for unknown models', () => {
    const [input, output] = priceFor('unknown/vendor/some-model')
    expect(input).toBe(1)
    expect(output).toBe(2)
  })

  test('matching is case-insensitive', () => {
    const [input, output] = priceFor('OpenRouter/Anthropic/Claude-Opus-4')
    expect(input).toBe(15)
    expect(output).toBe(75)
  })

  test('PRICING_TABLE is non-empty', () => {
    expect(PRICING_TABLE.length).toBeGreaterThan(0)
  })

  test('claude-opus matches before claude-sonnet (order matters)', () => {
    // claude-opus-4 includes 'claude-opus' which should match first
    const [input, output] = priceFor('claude-opus-4')
    expect(input).toBe(15)
    expect(output).toBe(75)
  })
})

describe('createUsageStats', () => {
  test('returns zeroed stats', () => {
    const stats = createUsageStats()
    expect(stats.requests).toBe(0)
    expect(stats.inputTokens).toBe(0)
    expect(stats.outputTokens).toBe(0)
    expect(stats.costUSD).toBe(0)
    expect(stats.totalLatencyMs).toBe(0)
    expect(stats.byModel.size).toBe(0)
  })
})

describe('record', () => {
  test('increments all counters', () => {
    const stats = createUsageStats()
    record(stats, 'openai/gpt-4o', 1000, 500, 200)
    expect(stats.requests).toBe(1)
    expect(stats.inputTokens).toBe(1000)
    expect(stats.outputTokens).toBe(500)
    expect(stats.totalLatencyMs).toBe(200)
  })

  test('calculates cost correctly', () => {
    const stats = createUsageStats()
    // gpt-4o: input=2.5/M, output=10/M
    record(stats, 'openai/gpt-4o', 1_000_000, 1_000_000, 100)
    expect(stats.costUSD).toBeCloseTo(12.5, 4) // 2.5 + 10
  })

  test('tracks per-model stats', () => {
    const stats = createUsageStats()
    record(stats, 'openai/gpt-4o', 1000, 500, 100)
    record(stats, 'openai/gpt-4o', 2000, 300, 200)
    const modelStats = stats.byModel.get('openai/gpt-4o')
    expect(modelStats).toBeDefined()
    expect(modelStats!.requests).toBe(2)
    expect(modelStats!.inputTokens).toBe(3000)
    expect(modelStats!.outputTokens).toBe(800)
  })

  test('accumulates across multiple models', () => {
    const stats = createUsageStats()
    record(stats, 'openai/gpt-4o', 1000, 500, 100)
    record(stats, 'openrouter/deepseek/deepseek-v3', 1000, 500, 100)
    expect(stats.requests).toBe(2)
    expect(stats.byModel.size).toBe(2)
  })
})

describe('statsSnapshot', () => {
  test('produces a snapshot with rounded costUSD', () => {
    const stats = createUsageStats()
    record(stats, 'openai/gpt-4o', 1000, 500, 300)
    const snap = statsSnapshot(stats)
    expect(snap.requests).toBe(1)
    expect(snap.inputTokens).toBe(1000)
    expect(snap.outputTokens).toBe(500)
    expect(snap.avgLatencyMs).toBe(300)
    expect(typeof snap.costUSD).toBe('number')
    // Cost is rounded to 6 decimal places
    expect(snap.costUSD).toBe(Math.round(snap.costUSD * 1e6) / 1e6)
  })

  test('avgLatencyMs is 0 when no requests', () => {
    const stats = createUsageStats()
    const snap = statsSnapshot(stats)
    expect(snap.avgLatencyMs).toBe(0)
  })

  test('byModel in snapshot is a plain object (not Map)', () => {
    const stats = createUsageStats()
    record(stats, 'openai/gpt-4o', 100, 50, 10)
    const snap = statsSnapshot(stats)
    expect(typeof snap.byModel).toBe('object')
    expect(!Array.isArray(snap.byModel)).toBe(true)
    expect(snap.byModel['openai/gpt-4o']).toBeDefined()
  })
})

describe('GatewayStatsStore', () => {
  test('record and snapshot work', () => {
    const store = new GatewayStatsStore()
    store.record('openai/gpt-4o', 1000, 500, 100)
    const snap = store.snapshot()
    expect(snap.requests).toBe(1)
    expect(snap.inputTokens).toBe(1000)
    expect(snap.outputTokens).toBe(500)
  })

  test('raw returns internal stats', () => {
    const store = new GatewayStatsStore()
    store.record('openai/gpt-4o', 100, 50, 10)
    expect(store.raw.requests).toBe(1)
    expect(store.raw.inputTokens).toBe(100)
  })

  test('accumulates across records', () => {
    const store = new GatewayStatsStore()
    store.record('openai/gpt-4o', 100, 50, 10)
    store.record('openrouter/deepseek/deepseek-v3', 200, 100, 20)
    const snap = store.snapshot()
    expect(snap.requests).toBe(2)
    expect(snap.inputTokens).toBe(300)
    expect(snap.outputTokens).toBe(150)
  })
})
