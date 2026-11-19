import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { resolveEffectiveModel } from './prompt.js'

// Pin OPENROUTER_API_KEY + ANTHROPIC_API_KEY so the first routing.fallbacks
// entry (openrouter/google/gemini-2.5-flash) resolves deterministically even if
// ~/.mira/mira.env provides NVIDIA_API_KEY. Restore original env after the suite.
const savedAnthropicKey = process.env.ANTHROPIC_API_KEY
const savedOpenRouterKey = process.env.OPENROUTER_API_KEY
beforeAll(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key'
  process.env.OPENROUTER_API_KEY = 'test-key'
})
afterAll(() => {
  if (savedAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = savedAnthropicKey
  if (savedOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY
  else process.env.OPENROUTER_API_KEY = savedOpenRouterKey
})

describe('resolveEffectiveModel retired guard', () => {
  it('falls back when model is retired', () => {
    const model = resolveEffectiveModel({
      explicitModel: 'anthropic/claude-3-opus-20240229',
      task: 'stream',
    })
    expect(model).not.toContain('claude-3-opus-20240229')
    expect(model).toContain('gemini-2.5-flash')
  })

  it('falls back when NVIDIA EOL models (llama-3.3-70b-instruct / deepseek-v4-flash) are requested', () => {
    const m1 = resolveEffectiveModel({
      sessionModel: 'meta/llama-3.3-70b-instruct',
      task: 'stream',
    })
    expect(m1).not.toContain('llama-3.3-70b-instruct')

    const m2 = resolveEffectiveModel({
      explicitModel: 'nvidia/deepseek-ai/deepseek-v4-flash',
      task: 'stream',
    })
    expect(m2).not.toContain('deepseek-v4-flash')
  })

  it('keeps valid model', () => {
    const model = resolveEffectiveModel({
      explicitModel: 'anthropic/claude-sonnet-4',
      task: 'stream',
    })
    expect(model).toContain('claude-sonnet-4')
  })
})
