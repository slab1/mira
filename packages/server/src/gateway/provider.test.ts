/**
 * Gateway provider helpers — buildRegistry case-insensitive merge + resolve.
 */
import { describe, test, expect } from 'bun:test'
import { buildRegistry, resolveModel } from './provider.js'
import type { MiraConfig } from '../types/index.js'

function cfg(provider: Record<string, unknown>): MiraConfig {
  return {
    model: 'openrouter/anthropic/claude-sonnet-4',
    provider: provider as MiraConfig['provider'],
  } as MiraConfig
}

describe('buildRegistry case-insensitive provider merge', () => {
  test('lowercases provider keys', () => {
    const reg = buildRegistry(
      cfg({
        Nvidia: {
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: 'https://x', apiKey: 'k' },
        },
      }),
    )
    const resolved = reg.resolve('nvidia/meta/llama-3.3-70b-instruct')
    expect(resolved.providerKey).toBe('nvidia')
    expect(resolved.modelID).toBe('meta/llama-3.3-70b-instruct')
  })

  test('merges case-duplicate providers, keyed entry wins', () => {
    const reg = buildRegistry(
      cfg({
        nvidia: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://x', apiKey: '' } },
        Nvidia: {
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: 'https://x', apiKey: 'real-key' },
        },
      }),
    )
    const resolved = reg.resolve('nvidia/meta/llama-3.3-70b-instruct')
    expect(resolved.providerKey).toBe('nvidia')
    expect(reg.hasKey('nvidia')).toBe(true)
  })

  test('empty-key duplicate does not shadow a keyed entry', () => {
    const reg = buildRegistry(
      cfg({
        google: { npm: '@ai-sdk/google', options: { baseURL: 'https://g', apiKey: 'gk' } },
        Google: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://g', apiKey: '' } },
      }),
    )
    const resolved = reg.resolve('google/gemini-2.0-flash')
    expect(resolved.providerKey).toBe('google')
    expect(reg.hasKey('google')).toBe(true)
  })

  test('resolve matches model prefix case-insensitively', () => {
    const reg = buildRegistry(
      cfg({ google: { npm: '@ai-sdk/google', options: { baseURL: 'https://g', apiKey: 'gk' } } }),
    )
    const resolved = reg.resolve('Google/gemini-2.0-flash')
    expect(resolved.providerKey).toBe('google')
    expect(resolved.modelID).toBe('gemini-2.0-flash')
  })

  test('resolveModel wrapper returns providerKey + modelID', () => {
    const reg = buildRegistry(
      cfg({ google: { npm: '@ai-sdk/google', options: { baseURL: 'https://g', apiKey: 'gk' } } }),
    )
    const resolved = resolveModel(reg, 'google/gemini-2.0-flash')
    expect(resolved.providerKey).toBe('google')
    expect(resolved.modelID).toBe('gemini-2.0-flash')
  })
})
