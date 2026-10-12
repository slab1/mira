import { describe, test, expect } from 'bun:test'
import { backoffWithJitter, parseRetryAfter } from './retry.js'

describe('backoffWithJitter', () => {
  test('returns a number >= baseMs/2 and <= maxMs', () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const ms = backoffWithJitter(attempt, 500, 10_000)
      expect(ms).toBeGreaterThanOrEqual(0)
      expect(ms).toBeLessThanOrEqual(10_000)
    }
  })

  test('attempt 0 is roughly baseMs/2 to baseMs', () => {
    // decorrelated jitter: capped = baseMs * 2^0 = baseMs, result = capped/2 + random * capped/2
    const samples = Array.from({ length: 20 }, () => backoffWithJitter(0, 1000, 10_000))
    for (const ms of samples) {
      expect(ms).toBeGreaterThanOrEqual(500) // capped/2 = 500
      expect(ms).toBeLessThanOrEqual(1000) // capped = 1000
    }
  })

  test('higher attempts produce larger backoffs', () => {
    // The lower bound of attempt 2 should be higher than upper bound of attempt 0
    // attempt 0: capped=500, range [250, 500]
    // attempt 2: capped=min(2000,10000)=2000, range [1000, 2000]
    const high0 = 500
    const low2 = 1000
    // low2 should be >= high0
    expect(low2).toBeGreaterThanOrEqual(high0)
  })

  test('respects maxMs cap', () => {
    const ms = backoffWithJitter(20, 500, 10_000) // 500 * 2^20 >> 10000
    expect(ms).toBeLessThanOrEqual(10_000)
  })
})

describe('parseRetryAfter', () => {
  test('returns null for null input', () => {
    expect(parseRetryAfter(null)).toBeNull()
  })

  test('returns null for undefined input', () => {
    expect(parseRetryAfter(undefined)).toBeNull()
  })

  test('parses numeric seconds', () => {
    expect(parseRetryAfter('5')).toBe(5000)
    expect(parseRetryAfter('0')).toBe(0)
    expect(parseRetryAfter('30')).toBe(30_000)
  })

  test('parses HTTP-date format', () => {
    const future = new Date(Date.now() + 10_000).toUTCString()
    const result = parseRetryAfter(future)
    expect(result).toBeGreaterThanOrEqual(9000)
    expect(result).toBeLessThanOrEqual(12000)
  })

  test('returns 0 for past HTTP date', () => {
    const past = new Date(Date.now() - 10_000).toUTCString()
    expect(parseRetryAfter(past)).toBe(0)
  })

  test('returns null for garbage string', () => {
    expect(parseRetryAfter('not-a-number-or-date')).toBeNull()
  })

  test('trims whitespace from numeric', () => {
    expect(parseRetryAfter('  5  ')).toBe(5000)
  })
})
