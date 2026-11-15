import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { resolveEffectiveModel } from './prompt.js'

// Pin ANTHROPIC_API_KEY so the first routing.fallbacks entry
// (anthropic/claude-sonnet-4) resolves deterministically. Without it, only
// GOOGLE_API_KEY may be present in the shell → fallback lands on
// google/gemini-2.0-flash instead. Restore the original env after the suite.
const savedAnthropicKey = process.env.ANTHROPIC_API_KEY
beforeAll(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key'
})
afterAll(() => {
  if (savedAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = savedAnthropicKey
})

describe('resolveEffectiveModel retired guard', () => {
  it('falls back when model is retired', () => {
    const model = resolveEffectiveModel({
      explicitModel: 'anthropic/claude-3-opus-20240229',
      task: 'stream',
    })
    expect(model).not.toContain('claude-3-opus-20240229')
    expect(model).toContain('claude-sonnet-4')
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
