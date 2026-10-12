import { describe, test, expect, beforeEach } from 'bun:test'
import { SemanticCache } from './cache.js'

// SemanticCache — an opt-in prompt→response cache.
//
// It is deliberately NOT wired into the live request path (see the note at the
// top of cache.ts): replaying a cached agentic turn can re-issue a stale edit.
// These tests establish it as a working, correct utility for callers that do
// want determinism, so it is not dead-on-arrival either.

const entry = (text: string, model = 'm1') => ({
  text,
  inputTokens: 10,
  outputTokens: 5,
  costUSD: 0.001,
  timestamp: Date.now(),
  model,
})

describe('SemanticCache', () => {
  let cache: SemanticCache
  beforeEach(() => {
    cache = new SemanticCache()
  })

  test('stores and retrieves an entry', () => {
    const key = cache.key('prompt', 'm1', 0)
    cache.set(key, entry('answer'))
    const got = cache.get(key)
    expect(got?.text).toBe('answer')
  })

  test('key varies with model, temperature and prompt', () => {
    const base = cache.key('p', 'm1', 0)
    expect(cache.key('p', 'm2', 0)).not.toBe(base)
    expect(cache.key('p', 'm1', 1)).not.toBe(base)
    expect(cache.key('q', 'm1', 0)).not.toBe(base)
    // deterministic for identical inputs
    expect(cache.key('p', 'm1', 0)).toBe(base)
  })

  test('a miss returns null and counts the miss', () => {
    expect(cache.get(cache.key('nope', 'm1', 0))).toBeNull()
    expect(cache.stats().misses).toBe(1)
    expect(cache.stats().hits).toBe(0)
  })

  test('a hit is counted', () => {
    const key = cache.key('p', 'm1', 0)
    cache.set(key, entry('a'))
    cache.get(key)
    expect(cache.stats().hits).toBe(1)
  })

  test('entries expire after the TTL', () => {
    const shortLived = new SemanticCache(10) // 10ms
    const key = shortLived.key('p', 'm1', 0)
    shortLived.set(key, entry('a'))
    expect(shortLived.get(key)).not.toBeNull()
    // wait past the TTL synchronously via a busy delay helper
    const until = Date.now() + 25
    while (Date.now() < until) {
      /* spin briefly rather than sleep in a test */
    }
    expect(shortLived.get(key)).toBeNull()
  })

  test('capacity is bounded — oldest entry is evicted', () => {
    const small = new SemanticCache(60_000, 2)
    small.set(small.key('a', 'm1', 0), entry('a'))
    small.set(small.key('b', 'm1', 0), entry('b'))
    small.set(small.key('c', 'm1', 0), entry('c'))
    expect(small.size).toBe(2)
    // 'a' was evicted
    expect(small.get(small.key('a', 'm1', 0))).toBeNull()
    expect(small.get(small.key('c', 'm1', 0))?.text).toBe('c')
  })

  test('invalidate(pattern) drops matching entries only', () => {
    const k1 = cache.key('alpha', 'm1', 0)
    const k2 = cache.key('beta', 'm1', 0)
    cache.set(k1, entry('a'))
    cache.set(k2, entry('b'))
    cache.invalidate(cache.key('alpha', 'm1', 0))
    expect(cache.get(k1)).toBeNull()
    expect(cache.get(k2)).not.toBeNull()
  })

  test('clear resets entries and counters', () => {
    const key = cache.key('p', 'm1', 0)
    cache.set(key, entry('a'))
    cache.get(key) // a hit
    cache.clear()
    expect(cache.size).toBe(0)
    expect(cache.stats()).toEqual({ hits: 0, misses: 0, size: 0 })
  })

  test('set stamps the response with the current time', () => {
    const key = cache.key('p', 'm1', 0)
    const before = Date.now()
    cache.set(key, { ...entry('a'), timestamp: 0 })
    const got = cache.get(key)
    expect(got!.timestamp).toBeGreaterThanOrEqual(before)
  })
})
