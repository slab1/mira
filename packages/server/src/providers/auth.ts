/**
 * Provider System — Auth & Env Expansion
 *
 * {env:VAR} expansion for baseURL, apiKey (string|array), headers
 * Key rotation on 429/401
 */

export function expandEnv(value: string): string {
  if (!value) return value
  return value.replace(/\{env:([^}]+)\}/g, (_, name: string) => process.env[name] ?? '')
}

export function expandEnvString(value: string | undefined): string {
  if (!value) return ''
  return expandEnv(value)
}

export function expandEnvArray(value: string | string[] | undefined): string[] {
  if (!value) return []
  if (Array.isArray(value)) {
    const out: string[] = []
    for (const v of value) {
      const expanded = expandEnv(v)
      // Support comma-separated env expansion: "{env:KEYS}" where KEYS="k1,k2"
      // But only if original was a single env template; otherwise keep as-is
      if (expanded.includes(',') && /^\{env:[^}]+\}$/.test(v.trim())) {
        for (const part of expanded.split(',')) {
          const t = part.trim()
          if (t) out.push(t)
        }
      } else if (expanded) {
        out.push(expanded)
      }
    }
    return out
  }
  const expanded = expandEnv(value)
  if (!expanded) return []
  // If expanded contains commas and original was env template, split
  if (expanded.includes(',') && /^\{env:[^}]+\}$/.test(value.trim())) {
    return expanded
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return [expanded]
}

export function expandHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    out[k] = expandEnv(v)
  }
  return out
}

export function expandApiKey(apiKey: string | string[] | undefined): string[] {
  return expandEnvArray(apiKey)
}

/**
 * KeyRing — manages rotation across multiple API keys
 */
export class KeyRing {
  private keys: string[]
  private index = 0

  constructor(apiKey: string | string[] | undefined) {
    this.keys = expandApiKey(apiKey).filter(Boolean)
  }

  get current(): string {
    return this.keys[this.index] ?? ''
  }

  get all(): string[] {
    return [...this.keys]
  }

  get hasKey(): boolean {
    return this.keys.length > 0 && !!this.current
  }

  get currentIndex(): number {
    return this.index
  }

  get size(): number {
    return this.keys.length
  }

  /** Rotate to next key, return new key or null if exhausted (single key = no rotation) */
  rotate(): string | null {
    if (this.keys.length <= 1) return null
    this.index = (this.index + 1) % this.keys.length
    // If we wrapped around to 0, we've exhausted all keys in this cycle
    // Caller should track attempts; we just rotate
    return this.current
  }

  /** Check if error is rotation-eligible (429 or 401) */
  static isRotatableError(status: number | undefined, message: string): boolean {
    if (status === 429 || status === 401) return true
    return /429|401|rate.?limit|unauthorized|invalid.?api.?key/i.test(message)
  }

  /** Reset to first key */
  reset(): void {
    this.index = 0
  }
}

/**
 * Compute exponential backoff delay with jitter.
 * Formula: delay = baseMs * 2^attempt + random(0, jitterMs)
 */
export function exponentialBackoff(baseMs: number, attempts: number, jitterMs: number): number {
  const exponential = baseMs * Math.pow(2, attempts)
  const jitter = Math.random() * jitterMs
  return Math.floor(exponential + jitter)
}

/**
 * Classify an error for retry/fallback decisions.
 * - 'retryable': transient provider errors (429, 500, 502, 503, timeout) — retry same model with backoff, then fallback
 * - 'fallback': provider-level errors where retry won't help but another provider might — fallback to next model
 * - 'none': request-level errors (400, 401, 404) — client mistake, do NOT retry or fallback
 */
export function classifyError(status: number, message: string): 'retryable' | 'fallback' | 'none' {
  // Request-level errors — client mistakes, do NOT retry or fallback
  if (status === 400 || status === 401 || status === 404) return 'none'
  // Rate-limited — retry same model with backoff first, then fallback
  if (status === 429) return 'retryable'
  // Server errors — retry same model with backoff, then fallback
  if (status === 500 || status === 502 || status === 503) return 'retryable'
  if (status === 408 || status === 504) return 'retryable'
  // Timeout / network errors — retry same model
  if (/timeout|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(message)) return 'retryable'
  return 'none'
}

/** Expand a provider's raw options into resolved values */
export function resolveProviderOptions(raw: {
  baseURL?: string
  apiKey?: string | string[]
  headers?: Record<string, string>
  timeout?: number
}): { baseURL: string; apiKeys: string[]; headers: Record<string, string>; timeout: number } {
  return {
    baseURL: expandEnvString(raw.baseURL),
    apiKeys: expandApiKey(raw.apiKey),
    headers: expandHeaders(raw.headers),
    timeout: raw.timeout ?? 120_000,
  }
}
