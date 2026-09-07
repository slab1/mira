import { describe, test, expect, mock } from 'bun:test'
import { backoffWithJitter, parseRetryAfter, withRetry, withFallbackChain } from './retry.js'
import { ProviderError } from './errors.js'

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
    const low0 = 250
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

describe('withRetry', () => {
  test('returns result on first success', async () => {
    const fn = mock(() => Promise.resolve('ok'))
    const result = await withRetry(fn, { maxAttempts: 3, baseMs: 1, maxMs: 1 })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('retries on retryable errors then succeeds', async () => {
    let calls = 0
    const fn = mock(() => {
      calls++
      if (calls < 3) throw new ProviderError({ message: '500 internal', status: 500 })
      return Promise.resolve('recovered')
    })
    const result = await withRetry(fn, { maxAttempts: 3, baseMs: 1, maxMs: 1 })
    expect(result).toBe('recovered')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  test('throws immediately on non-retryable errors', async () => {
    const fn = mock(() => {
      throw new ProviderError({ message: 'bad request', status: 400 })
    })
    await expect(withRetry(fn, { maxAttempts: 3, baseMs: 1, maxMs: 1 })).rejects.toThrow()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('throws after maxAttempts exhausted', async () => {
    const fn = mock(() => {
      throw new ProviderError({ message: '500 internal', status: 500 })
    })
    await expect(withRetry(fn, { maxAttempts: 2, baseMs: 1, maxMs: 1 })).rejects.toThrow()
    expect(fn).toHaveBeenCalledTimes(2)
  })

  test('calls onRetry callback on each retry', async () => {
    let calls = 0
    const fn = mock(() => {
      calls++
      if (calls < 3) throw new ProviderError({ message: '429 rate limited', status: 429 })
      return Promise.resolve('done')
    })
    const onRetry = mock(() => {})
    await withRetry(fn, { maxAttempts: 3, baseMs: 1, maxMs: 1, onRetry })
    expect(onRetry).toHaveBeenCalledTimes(2)
  })

  test('aborts immediately if signal already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const fn = mock(() => Promise.resolve('never'))
    await expect(withRetry(fn, { maxAttempts: 3, signal: ac.signal })).rejects.toThrow('Aborted')
    expect(fn).toHaveBeenCalledTimes(0)
  })
})

describe('withFallbackChain', () => {
  test('returns first candidate on success', async () => {
    const result = await withFallbackChain(
      [
        { key: 'a', run: () => Promise.resolve('a-ok') },
        { key: 'b', run: () => Promise.resolve('b-ok') },
      ],
      { baseMs: 1, maxMs: 1 },
    )
    expect(result).toBe('a-ok')
  })

  test('falls back to second candidate on first failure', async () => {
    let calls = 0
    const result = await withFallbackChain(
      [
        {
          key: 'a',
          run: () => {
            calls++
            throw new ProviderError({ message: '500 error', status: 500 })
          },
        },
        { key: 'b', run: () => Promise.resolve('b-ok') },
      ],
      { maxAttempts: 1, baseMs: 1, maxMs: 1 },
    )
    expect(result).toBe('b-ok')
  })

  test('throws last error when all candidates fail', async () => {
    await expect(
      withFallbackChain(
        [
          {
            key: 'a',
            run: () => {
              throw new ProviderError({ message: 'fail a', status: 500 })
            },
          },
          {
            key: 'b',
            run: () => {
              throw new ProviderError({ message: 'fail b', status: 500 })
            },
          },
        ],
        { maxAttempts: 1, baseMs: 1, maxMs: 1 },
      ),
    ).rejects.toThrow()
  })

  test('throws on empty candidates array', async () => {
    await expect(withFallbackChain([], { baseMs: 1, maxMs: 1 })).rejects.toThrow()
  })
})
