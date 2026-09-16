import { describe, it, expect } from 'bun:test'
import { resolveEffectiveModel } from './prompt.js'

describe('resolveEffectiveModel retired guard', () => {
  it('falls back when model is retired', () => {
    const model = resolveEffectiveModel({
      explicitModel: 'anthropic/claude-3-opus-20240229',
      task: 'stream',
    })
    expect(model).not.toContain('claude-3-opus-20240229')
    expect(model).toContain('claude-sonnet-4')
  })

  it('keeps valid model', () => {
    const model = resolveEffectiveModel({
      explicitModel: 'anthropic/claude-sonnet-4',
      task: 'stream',
    })
    expect(model).toContain('claude-sonnet-4')
  })
})
