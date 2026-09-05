/**
 * Mira HTTP Client — shared `req()` for web, TUI, and CLI clients.
 *
 * Handles:
 *   - Auth headers (Bearer token)
 *   - JSON content-type
 *   - Error responses (401, 4xx, 5xx)
 *   - Optional retry with exponential backoff
 *   - Optional timeout via AbortController
 *   - Signal propagation (caller abort)
 *
 * Usage:
 *   import { createClient } from '@mira/shared'
 *   const client = createClient({ baseUrl: 'http://localhost:4096', getToken: () => '...' })
 *   const sessions = await client.req<Session[]>('/session')
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export interface ClientOptions {
  /** Base URL of the Mira server (e.g. 'http://localhost:4096') */
  baseUrl: string
  /** Function to retrieve the current auth token */
  getToken: () => string | null
  /** Optional: function called on 401 to clear invalid token */
  onUnauthorized?: () => void
  /** Request timeout in ms (default: 100_000) */
  timeoutMs?: number
  /** Max retries for transient network errors (default: 0) */
  maxRetries?: number
}

export interface ReqInit extends RequestInit {
  /** Skip retry logic for this request */
  noRetry?: boolean
}

/**
 * Create an HTTP client with the given options.
 */
export function createClient(options: ClientOptions) {
  const { baseUrl, getToken, onUnauthorized, timeoutMs = 100_000, maxRetries = 0 } = options

  function authHeaders(extra?: HeadersInit): HeadersInit {
    const t = getToken()
    return { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(extra || {}) }
  }

  async function req<T>(path: string, init?: ReqInit): Promise<T> {
    const retries = init?.noRetry ? 0 : maxRetries
    let lastErr: Error | null = null

    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      // Combine caller signal + timeout signal
      let signal: AbortSignal = controller.signal
      if (init?.signal) {
        const caller = init.signal as AbortSignal
        if (caller.aborted) {
          clearTimeout(timer)
          controller.abort(caller.reason)
        } else {
          caller.addEventListener('abort', () => controller.abort(caller.reason), { once: true })
        }
      }

      try {
        const res = await fetch(`${baseUrl}${path}`, {
          ...init,
          mode: 'cors',
          signal,
          headers: { 'Content-Type': 'application/json', ...authHeaders(init?.headers) },
        })
        clearTimeout(timer)

        if (res.status === 401) {
          onUnauthorized?.()
          throw new ApiError(401, 'unauthorized')
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          let msg = `${res.status} ${res.statusText}${text ? `: ${text}` : ''}`
          try {
            const j = JSON.parse(text) as { error?: string; message?: string }
            if (typeof j.error === 'string' && j.error) msg = `${res.status} ${j.error}`
            else if (typeof j.message === 'string' && j.message) msg = `${res.status} ${j.message}`
          } catch {}
          throw new ApiError(res.status, msg, text)
        }

        // 204 / empty
        const ct = res.headers.get('content-type') || ''
        if (ct.includes('application/json')) return (await res.json()) as T
        return (await res.json().catch(() => ({}) as T)) as T
      } catch (e) {
        clearTimeout(timer)
        if (e instanceof ApiError) throw e

        const err = e as Error
        lastErr = err

        // Don't retry if caller aborted or if it's an abort error
        if (init?.signal?.aborted || err.name === 'AbortError') throw e

        // Only retry on transient network errors (TypeError from fetch)
        const shouldRetry = attempt < retries && err instanceof TypeError
        if (shouldRetry) {
          await new Promise((r) => setTimeout(r, 200 * 2 ** attempt))
          continue
        }
        throw e
      }
    }

    throw lastErr ?? new Error('req failed')
  }

  return { req, authHeaders }
}
