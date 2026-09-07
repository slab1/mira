import { describe, test, expect } from 'bun:test'
import { SubgatewayStatsCollector } from './stats.js'

describe('SubgatewayStatsCollector', () => {
  test('constructor sets lane', () => {
    const c = new SubgatewayStatsCollector('default')
    expect(c.lane).toBe('default')
  })

  test('snapshot is zeroed initially', () => {
    const c = new SubgatewayStatsCollector('default')
    const s = c.snapshot()
    expect(s.requests).toBe(0)
    expect(s.inputTokens).toBe(0)
    expect(s.outputTokens).toBe(0)
    expect(s.costUSD).toBe(0)
    expect(s.avgLatencyMs).toBe(0)
    expect(Object.keys(s.byModel)).toHaveLength(0)
  })

  test('record increments counters', () => {
    const c = new SubgatewayStatsCollector('default')
    c.record('openai/gpt-4o', 1000, 500, 200)
    const s = c.snapshot()
    expect(s.requests).toBe(1)
    expect(s.inputTokens).toBe(1000)
    expect(s.outputTokens).toBe(500)
    expect(s.avgLatencyMs).toBe(200)
  })

  test('record calculates cost correctly using priceFor', () => {
    const c = new SubgatewayStatsCollector('default')
    // gpt-4o: input=2.5/M, output=10/M
    c.record('openai/gpt-4o', 1_000_000, 1_000_000, 100)
    const s = c.snapshot()
    expect(s.costUSD).toBeCloseTo(12.5, 4)
  })

  test('records per-model breakdown', () => {
    const c = new SubgatewayStatsCollector('default')
    c.record('openai/gpt-4o', 1000, 500, 100)
    c.record('openrouter/deepseek/deepseek-v3', 2000, 100, 200)
    const s = c.snapshot()
    expect(s.requests).toBe(2)
    expect(Object.keys(s.byModel)).toHaveLength(2)
    expect(s.byModel['openai/gpt-4o']).toBeDefined()
    expect(s.byModel['openrouter/deepseek/deepseek-v3']).toBeDefined()
    expect(s.byModel['openai/gpt-4o']!.requests).toBe(1)
    expect(s.byModel['openrouter/deepseek/deepseek-v3']!.inputTokens).toBe(2000)
  })

  test('accumulates across multiple records to same model', () => {
    const c = new SubgatewayStatsCollector('default')
    c.record('openai/gpt-4o', 1000, 500, 100)
    c.record('openai/gpt-4o', 2000, 300, 300)
    const s = c.snapshot()
    expect(s.requests).toBe(2)
    expect(s.inputTokens).toBe(3000)
    expect(s.outputTokens).toBe(800)
    expect(s.avgLatencyMs).toBe(200) // (100+300)/2
    expect(s.byModel['openai/gpt-4o']!.requests).toBe(2)
  })

  test('reset clears everything', () => {
    const c = new SubgatewayStatsCollector('default')
    c.record('openai/gpt-4o', 1000, 500, 100)
    c.reset()
    const s = c.snapshot()
    expect(s.requests).toBe(0)
    expect(s.inputTokens).toBe(0)
    expect(s.outputTokens).toBe(0)
    expect(s.costUSD).toBe(0)
    expect(Object.keys(s.byModel)).toHaveLength(0)
  })

  test('raw returns internal state with Map', () => {
    const c = new SubgatewayStatsCollector('default')
    c.record('openai/gpt-4o', 100, 50, 10)
    const raw = c.raw
    expect(raw.requests).toBe(1)
    expect(raw.inputTokens).toBe(100)
    expect(raw.outputTokens).toBe(50)
    expect(raw.byModel).toBeInstanceOf(Map)
    expect(raw.byModel.has('openai/gpt-4o')).toBe(true)
  })

  test('snapshot costUSD is rounded to 6 decimal places', () => {
    const c = new SubgatewayStatsCollector('default')
    c.record('openai/gpt-4o', 1, 1, 10)
    const s = c.snapshot()
    expect(s.costUSD).toBe(Math.round(s.costUSD * 1e6) / 1e6)
  })

  test('avgLatencyMs is 0 with no records', () => {
    const c = new SubgatewayStatsCollector('default')
    expect(c.snapshot().avgLatencyMs).toBe(0)
  })
})
