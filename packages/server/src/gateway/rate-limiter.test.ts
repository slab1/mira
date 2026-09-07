import { describe, test, expect } from 'bun:test'
import { TokenBucket } from './rate-limiter.js'

describe('TokenBucket', () => {
  test('constructor sets rps and burst from opts', () => {
    const b = new TokenBucket({ rps: 10, burst: 20 })
    expect(b.config.rps).toBe(10)
    expect(b.config.burst).toBe(20)
  })

  test('defaults rps to 10 when given 0', () => {
    const b = new TokenBucket({ rps: 0, burst: 20 })
    expect(b.config.rps).toBe(10)
  })

  test('defaults burst to rps*2 when given 0', () => {
    const b = new TokenBucket({ rps: 5, burst: 0 })
    expect(b.config.burst).toBe(10)
  })

  test('tryConsume returns true when tokens available', () => {
    const b = new TokenBucket({ rps: 10, burst: 10 })
    expect(b.tryConsume(1)).toBe(true)
  })

  test('tryConsume returns false when tokens exhausted', () => {
    const b = new TokenBucket({ rps: 1, burst: 1 })
    b.tryConsume(1) // drain the bucket
    expect(b.tryConsume(1)).toBe(false)
  })

  test('tryConsume with custom n', () => {
    const b = new TokenBucket({ rps: 10, burst: 5 })
    expect(b.tryConsume(5)).toBe(true)
    expect(b.tryConsume(1)).toBe(false)
  })

  test('available returns current token count', () => {
    const b = new TokenBucket({ rps: 10, burst: 10 })
    expect(b.available).toBe(10)
    b.tryConsume(3)
    expect(b.available).toBe(7)
  })

  test('refill over time restores tokens up to burst', async () => {
    const b = new TokenBucket({ rps: 100, burst: 10 })
    b.tryConsume(10)
    expect(b.available).toBe(0)
    // Wait for refill — rps=100 means 10 tokens per 100ms
    await new Promise((r) => setTimeout(r, 200))
    expect(b.available).toBeGreaterThan(0)
    expect(b.available).toBeLessThanOrEqual(10)
  })

  test('available never exceeds burst', async () => {
    const b = new TokenBucket({ rps: 1000, burst: 5 })
    await new Promise((r) => setTimeout(r, 2000))
    expect(b.available).toBeLessThanOrEqual(5)
  })

  test('reset fills bucket back to burst', () => {
    const b = new TokenBucket({ rps: 10, burst: 10 })
    b.tryConsume(10)
    expect(b.available).toBe(0)
    b.reset()
    expect(b.available).toBe(10)
  })

  test('_setTokens clamps to [0, burst]', () => {
    const b = new TokenBucket({ rps: 10, burst: 10 })
    b._setTokens(20)
    expect(b.available).toBe(10) // clamped to burst
    b._setTokens(-5)
    expect(b.available).toBe(0) // clamped to 0
    b._setTokens(7)
    expect(b.available).toBe(7)
  })

  describe('consumeOrDelay', () => {
    test('returns allowed when tokens available', () => {
      const b = new TokenBucket({ rps: 10, burst: 10 })
      const res = b.consumeOrDelay(1)
      expect(res.allowed).toBe(true)
      expect(res.retryAfterMs).toBeUndefined()
    })

    test('returns allowed=false with retryAfterMs when denied', () => {
      const b = new TokenBucket({ rps: 10, burst: 10 })
      b.tryConsume(10)
      const res = b.consumeOrDelay(1)
      expect(res.allowed).toBe(false)
      expect(res.retryAfterMs).toBeGreaterThan(0)
    })

    test('retryAfterMs is correct based on rps', () => {
      const b = new TokenBucket({ rps: 10, burst: 10 })
      b.tryConsume(10)
      const res = b.consumeOrDelay(5)
      // Need 5 tokens at 10/sec = 500ms
      expect(res.retryAfterMs).toBeGreaterThanOrEqual(500)
      expect(res.retryAfterMs).toBeLessThanOrEqual(501)
    })
  })
})
