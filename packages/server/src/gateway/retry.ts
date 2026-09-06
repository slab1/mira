/**
 * Gateway — Retry utilities
 *
 * - backoffWithJitter: exponential backoff with jitter
 * - parseRetryAfter: parse Retry-After header (seconds or HTTP date)
 * - withRetry: retry a single candidate up to maxAttempts with jitter + Retry-After
 * - withFallbackChain: try candidates in order, each with withRetry
 */

import { ProviderError } from './errors.js'

export function backoffWithJitter(attempt: number, baseMs = 500, maxMs = 10_000): number {
  const exp = baseMs * Math.pow(2, attempt)
  const capped = Math.min(exp, maxMs)
  // Full jitter: random in [0, capped)
  // Use decorrelated jitter variant: random in [capped/2, capped)
  const jitter = capped / 2 + Math.random() * (capped / 2)
  return Math.round(jitter)
}

export function parseRetryAfter(header: string | null | undefined): number | null {
  if (!header) return null
  const trimmed = header.trim()
  // Numeric seconds
  const secs = Number(trimmed)
  if (Number.isFinite(secs) && secs >= 0) {
    return Math.round(secs * 1000)
  }
  // HTTP date
  const date = Date.parse(trimmed)
  if (Number.isFinite(date)) {
    const diff = date - Date.now()
    if (diff > 0) return diff
    return 0
  }
  return null
}

export interface RetryOptions {
  maxAttempts?: number // per candidate, default 3
  baseMs?: number
  maxMs?: number
  signal?: AbortSignal
  onRetry?: (attempt: number, error: Error, delayMs: number) => void
}

function isRetryableError(e: unknown): boolean {
  if (e instanceof ProviderError) return e.retryable
  const msg = (e as Error)?.message ?? String(e)
  const statusMatch = msg.match(/\b(\d{3})\b/)
  const status = statusMatch ? Number(statusMatch[1]) : undefined
  if (status === 429) return true
  if (status !== undefined && status >= 500 && status < 600) return true
  if (/timeout|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|408/i.test(msg)) return true
  return false
}

function extractRetryAfter(e: unknown): number | null {
  // Try to extract Retry-After from error message or attached header
  const err = e as { headers?: Headers | Record<string, string>; retryAfter?: string | null }
  if (err?.headers) {
    const h =
      err.headers instanceof Headers
        ? err.headers.get('retry-after')
        : ((err.headers as Record<string, string>)['retry-after'] ??
          (err.headers as Record<string, string>)['Retry-After'])
    const parsed = parseRetryAfter(h)
    if (parsed !== null) return parsed
  }
  if (err?.retryAfter) {
    const parsed = parseRetryAfter(err.retryAfter)
    if (parsed !== null) return parsed
  }
  // Also check message for Retry-After hint
  const msg = (e as Error)?.message ?? ''
  const m = msg.match(/retry-after[:\s]+([^\s,;]+)/i)
  if (m) {
    const parsed = parseRetryAfter(m[1])
    if (parsed !== null) return parsed
  }
  return null
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3
  let lastError: unknown = null

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (opts.signal?.aborted) {
      throw new ProviderError({ message: 'Aborted', code: 'ABORTED', status: 499 })
    }
    try {
      return await fn()
    } catch (e) {
      lastError = e
      const retryable = isRetryableError(e)
      const isLast = attempt === maxAttempts - 1
      if (!retryable || isLast) throw e

      const retryAfter = extractRetryAfter(e)
      const delay =
        retryAfter !== null ? retryAfter : backoffWithJitter(attempt, opts.baseMs, opts.maxMs)
      opts.onRetry?.(attempt, e as Error, delay)

      // Wait with abort support and clear timer on abort
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay)
        const onAbort = () => {
          clearTimeout(timer)
          reject(new ProviderError({ message: 'Aborted', code: 'ABORTED', status: 499 }))
        }
        if (opts.signal) {
          if (opts.signal.aborted) {
            clearTimeout(timer)
            reject(new ProviderError({ message: 'Aborted', code: 'ABORTED', status: 499 }))
            return
          }
          opts.signal.addEventListener('abort', onAbort, { once: true })
          // Ensure cleanup
          const origResolve = resolve
          const wrappedResolve = () => {
            opts.signal?.removeEventListener('abort', onAbort)
            origResolve()
          }
          clearTimeout(timer)
          const t2 = setTimeout(wrappedResolve, delay)
          // Re-wire abort to clear t2
          opts.signal.removeEventListener('abort', onAbort)
          opts.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(t2)
              reject(new ProviderError({ message: 'Aborted', code: 'ABORTED', status: 499 }))
            },
            { once: true },
          )
        }
      })
    }
  }
  throw lastError
}

export interface FallbackCandidate<T> {
  key: string
  run: () => Promise<T>
}

export async function withFallbackChain<T>(
  candidates: Array<FallbackCandidate<T>>,
  opts: RetryOptions = {},
): Promise<T> {
  let lastError: unknown = null
  for (const cand of candidates) {
    try {
      return await withRetry(cand.run, opts)
    } catch (e) {
      lastError = e
      // If error is not retryable and not rate-limited, try next candidate immediately
      // withRetry already exhausted retries for this candidate
      continue
    }
  }
  throw (
    lastError ??
    new ProviderError({ message: 'All fallback candidates failed', code: 'PROVIDER_ERROR' })
  )
}
