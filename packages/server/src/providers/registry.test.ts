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

describe('alias expansion', () => {
  const aliased = () =>
    new ProviderRegistry(
      { a: prov('https://a.test'), b: prov('https://b.test') },
      { aliases: { sonnet: 'b/claude-sonnet-4' }, defaultProvider: 'a' },
    )

  test('a known alias resolves to its target', () => {
    const r = aliased().resolve('sonnet')
    expect(r.providerKey).toBe('b')
    expect(r.modelID).toBe('claude-sonnet-4')
  })

  // P2-5: prefix matching was case-insensitive but alias lookup was not, so a
  // mis-cased alias silently became a model id on the default provider.
  test('alias lookup is case-insensitive', () => {
    for (const input of ['Sonnet', 'SONNET', 'SoNNet', 'sONNET']) {
      const r = aliased().resolve(input)
      expect(r.providerKey).toBe('b')
      expect(r.modelID).toBe('claude-sonnet-4')
    }
  })

  test('an unknown alias is passed through unchanged', () => {
    const r = aliased().resolve('mystery-model')
    expect(r.providerKey).toBe('a')
    expect(r.modelID).toBe('mystery-model')
  })
})

// `options.kind` had a real latent use that was never wired: a user-defined
// provider key (`corp-gateway`, `openrouter-mirror`) matches no capability-table
// entry, so capability routing silently ignored it. Declaring kind lets a custom
// key inherit a known provider's capabilities.
describe('capabilities via options.kind', () => {
  const withKind = (key: string, kind: string) =>
    new ProviderRegistry(
      {
        [key]: {
          name: key,
          options: { baseURL: 'https://x.test', apiKey: 'k', timeout: 1000, kind },
          models: {},
        },
      },
      { defaultProvider: key },
    )

  test('a custom key inherits the capabilities of its declared kind', () => {
    const reg = withKind('corp-gateway', 'openrouter')
    // WITHOUT the kind lookup, an unknown key has no capabilities, so
    // routeByCapability('vision') cannot find a vision provider and falls back
    // to plain resolve() with no capability filtering. WITH the lookup, openrouter's
    // capabilities (incl. vision) apply and corp-gateway is returned as capable.
    expect(reg.capabilitiesOfPublic('corp-gateway')).toContain('vision')
    expect(reg.capabilitiesOfPublic('corp-gateway')).toContain('coding')
  })

  test('without a matching kind, an unknown key has no capabilities', () => {
    const reg = withKind('mystery', 'not-a-known-kind')
    expect(reg.capabilitiesOfPublic('mystery')).toEqual([])
  })

  test('the key entry wins over kind when the key is itself known', () => {
    const reg = withKind('openai', 'google')
    // openai's own capabilities apply, not google's
    expect(reg.capabilitiesOfPublic('openai')).toContain('coding')
    expect(reg.capabilitiesOfPublic('openai')).not.toContain('vision')
  })
})
