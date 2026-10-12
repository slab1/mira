import { describe, test, expect } from 'bun:test'
import { PRICING_TABLE, priceFor } from './pricing.js'

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
