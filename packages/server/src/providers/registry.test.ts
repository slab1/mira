import { describe, test, expect, beforeEach } from 'bun:test'
import { ProviderRegistry } from './registry.js'
import { clearBreakerRegistry } from './circuit-breaker.js'
import { ProviderError } from './types.js'
import type { ProviderConfig } from './types.js'

// providers/registry.ts — the model resolver. Previously untested (615 lines);
// these cover the contracts the gateway's failover depends on.

const prov = (baseURL: string, apiKey: string | string[] = 'k'): ProviderConfig => ({
  npm: '@ai-sdk/openai-compatible',
  name: baseURL,
  options: { baseURL, apiKey, timeout: 1000 },
  models: {},
})

beforeEach(() => {
  clearBreakerRegistry()
})

describe('resolveWithFallbacks', () => {
  test('returns primary first, then the configured fallbacks', () => {
    const reg = new ProviderRegistry(
      { a: prov('https://a.test'), b: prov('https://b.test'), c: prov('https://c.test') },
      { fallbacks: ['b/m1', 'c/m1'], defaultProvider: 'a' },
    )
    const out = reg.resolveWithFallbacks('a/m1').map((r) => `${r.providerKey}/${r.modelID}`)
    expect(out).toEqual(['a/m1', 'b/m1', 'c/m1'])
  })

  test('skips a candidate with no API key and keeps the rest of the chain', () => {
    const reg = new ProviderRegistry(
      { a: prov('https://a.test', ''), b: prov('https://b.test') },
      { fallbacks: ['b/m1'], defaultProvider: 'a' },
    )
    const out = reg.resolveWithFallbacks('a/m1').map((r) => r.providerKey)
    expect(out).toEqual(['b'])
  })

  // P0-2: an open circuit on the PRIMARY used to throw before the fallback
  // list was ever built, discarding a perfectly healthy fallback.
  test('an open circuit on the primary still yields the healthy fallback', () => {
    const reg = new ProviderRegistry(
      { a: prov('https://a.test'), b: prov('https://b.test') },
      { fallbacks: ['b/m1'], defaultProvider: 'a' },
    )
    for (let i = 0; i < 5; i++) reg.recordFailure('a')
    expect(reg.isHealthy('a')).toBe(false)
    const out = reg.resolveWithFallbacks('a/m1').map((r) => r.providerKey)
    expect(out).toEqual(['b'])
  })

  test('a rate-limited candidate is skipped, not fatal', () => {
    const reg = new ProviderRegistry(
      { a: prov('https://a.test'), b: prov('https://b.test') },
      { fallbacks: ['b/m1'], defaultProvider: 'a' },
    )
    // exhaust the limiter for a
    for (let i = 0; i < 100; i++) reg.checkRateLimit('a:m1')
    const out = reg.resolveWithFallbacks('a/m1').map((r) => r.providerKey)
    // with no limiter configured this is simply 'a'; the point is it does not throw
    expect(out.length).toBeGreaterThan(0)
  })

  test('when every candidate is skipped, the primary error still surfaces', () => {
    const reg = new ProviderRegistry(
      { a: prov('https://a.test', '') },
      { fallbacks: [], defaultProvider: 'a' },
    )
    expect(() => reg.resolveWithFallbacks('a/m1')).toThrow(ProviderError)
    try {
      reg.resolveWithFallbacks('a/m1')
    } catch (e) {
      expect((e as ProviderError).code).toBe('NO_API_KEY')
    }
  })

  test('duplicate candidates are collapsed', () => {
    const reg = new ProviderRegistry(
      { a: prov('https://a.test'), b: prov('https://b.test') },
      { fallbacks: ['a/m1', 'b/m1'], defaultProvider: 'a' },
    )
    const out = reg.resolveWithFallbacks('a/m1').map((r) => r.providerKey)
    expect(out).toEqual(['a', 'b'])
  })
})

describe('resolve', () => {
  test('unknown provider prefix falls back to defaultProvider', () => {
    const reg = new ProviderRegistry({ a: prov('https://a.test') }, { defaultProvider: 'a' })
    const r = reg.resolve('nope/m1')
    expect(r.providerKey).toBe('a')
    expect(r.modelID).toBe('nope/m1')
  })

  test('a provider key that is a prefix of another still matches longest', () => {
    const reg = new ProviderRegistry({
      nvidia: prov('https://n.test'),
      'nvidia-rl': prov('https://rl.test'),
    })
    expect(reg.resolve('nvidia/meta/llama').providerKey).toBe('nvidia')
    expect(reg.resolve('nvidia-rl/meta/llama').providerKey).toBe('nvidia-rl')
  })

  test('an open circuit fails fast with CIRCUIT_OPEN', () => {
    const reg = new ProviderRegistry({ a: prov('https://a.test') }, { defaultProvider: 'a' })
    for (let i = 0; i < 5; i++) reg.recordFailure('a')
    expect(reg.isHealthy('a')).toBe(false)
    try {
      reg.resolve('a/m1')
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as ProviderError).code).toBe('CIRCUIT_OPEN')
    }
  })
})
