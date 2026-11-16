/**
 * Provider System — Auth & Env Expansion
 *
 * {env:VAR} expansion for baseURL, apiKey (string|array), headers
 * Key rotation on 429/401
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function readMiraEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    const cands = [
      process.env.MIRA_DIR?.trim() ? join(process.env.MIRA_DIR.trim(), 'mira.env') : null,
      process.env.XDG_CONFIG_HOME?.trim()
        ? join(process.env.XDG_CONFIG_HOME.trim(), 'mira', 'mira.env')
        : null,
      join(homedir(), '.mira', 'mira.env'),
    ].filter(Boolean) as string[]
    for (const p of cands) {
      try {
        if (!existsSync(p)) continue
        for (const line of readFileSync(p, 'utf-8').split('\n')) {
          const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
          const k = m?.[1]
          if (k && !(k in out)) out[k] = (m?.[2] ?? '').replace(/^(['"])(.*)\1$/, '$2').trim()
        }
        if (Object.keys(out).length) break
      } catch {}
    }
  } catch {}
  for (const [k, v] of Object.entries(out)) {
    if (v && !process.env[k]) {
      process.env[k] = v
    }
  }
  return out
}

export function writeMiraEnvKey(name: string, value: string): void {
  process.env[name] = value
  try {
    const dir = process.env.MIRA_DIR?.trim() || join(homedir(), '.mira')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    const envFile = join(dir, 'mira.env')
    let content = ''
    if (existsSync(envFile)) {
      content = readFileSync(envFile, 'utf-8')
    }
    const regex = new RegExp(`^\\s*${name}\\s*=.*$`, 'm')
    if (regex.test(content)) {
      content = content.replace(regex, `${name}=${value}`)
    } else {
      content = content.trimEnd() + (content ? '\n' : '') + `${name}=${value}\n`
    }
    writeFileSync(envFile, content, { mode: 0o600 })
  } catch {}
}

export function expandEnv(value: string): string {
  if (!value) return value
  return value.replace(/\{env:([^}]+)\}/g, (_, name: string) => {
    if (process.env[name]) return process.env[name]!
    const envs = readMiraEnv()
    return envs[name] ?? process.env[name] ?? ''
  })
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

const PROVIDER_ENV_FALLBACKS: Record<string, string[]> = {
  nvidia: ['NVIDIA_API_KEY', 'NVAPI_KEY', 'NIM_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  groq: ['GROQ_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  cohere: ['COHERE_API_KEY'],
  fireworks: ['FIREWORKS_API_KEY'],
  replicate: ['REPLICATE_API_KEY'],
}

export function expandApiKey(apiKey: string | string[] | undefined, providerId?: string): string[] {
  const keys = expandEnvArray(apiKey)
  if (keys.length > 0) return keys
  if (providerId) {
    const key = providerId.toLowerCase()
    const envVars = PROVIDER_ENV_FALLBACKS[key] ?? [`${key.toUpperCase()}_API_KEY`]
    for (const envVar of envVars) {
      if (process.env[envVar]) return [process.env[envVar]!]
      const envs = readMiraEnv()
      if (envs[envVar]) return [envs[envVar]!]
    }
  }
  return []
}

/**
 * KeyRing — manages rotation across multiple API keys
 */
export class KeyRing {
  private keys: string[]
  private index = 0

  constructor(apiKey: string | string[] | undefined, providerId?: string) {
    this.keys = expandApiKey(apiKey, providerId).filter(Boolean)
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
  // Deprecated / gone / model unavailable -> immediate fallback (do NOT retry dead model)
  if (status === 410) return 'fallback'
  if (
    status === 404 &&
    /end of life|no longer available|model.*not found|does not exist|deprecated|retired|gone|404 page not found|page not found|not found for account|function ['"][^'"]+['"]: not found/i.test(
      message,
    )
  ) {
    return 'fallback'
  }
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

/**
 * Resolve the OpenAI-compatible `/chat/completions` URL for a provider baseURL.
 * Google Generative AI configures `https://generativelanguage.googleapis.com/v1beta`
 * for model discovery, whereas its OpenAI-compatible chat completions endpoint lives
 * under `/v1beta/openai/chat/completions`.
 */
export function chatCompletionsUrl(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, '')
  if (
    trimmed.includes('generativelanguage.googleapis.com') &&
    !/\/openai$/i.test(trimmed)
  ) {
    return `${trimmed}/openai/chat/completions`
  }
  return `${trimmed}/chat/completions`
}

/** Expand a provider's raw options into resolved values */
export function resolveProviderOptions(
  raw: {
    baseURL?: string
    apiKey?: string | string[]
    headers?: Record<string, string>
    timeout?: number
  },
  providerId?: string,
): { baseURL: string; apiKeys: string[]; headers: Record<string, string>; timeout: number } {
  return {
    baseURL: expandEnvString(raw.baseURL),
    apiKeys: expandApiKey(raw.apiKey, providerId),
    headers: expandHeaders(raw.headers),
    timeout: raw.timeout ?? 120_000,
  }
}
