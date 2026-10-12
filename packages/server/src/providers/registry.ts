/**
 * Provider System — Registry
 *
 * Longest-prefix model resolution for "openrouter/anthropic/claude-sonnet-4"
 * Alias expansion, fallback chains, capability routing, cost-aware routing,
 * health-aware routing, circuit breakers, and OTel-compatible tracing.
 */

import {
  ProviderError,
  type ProviderKind,
  type ProviderConfig,
  type ResolvedProvider,
  type Capability,
  type ProviderHealth,
} from './types.js'
import {
  expandEnv,
  expandEnvArray,
  expandHeaders,
  KeyRing,
  exponentialBackoff,
  classifyError,
} from './auth.js'
import { priceFor } from './pricing.js'
import { RateLimiter } from './rate-limiter.js'
import { createCircuitBreaker } from './circuit-breaker.js'

// ── Capability → ordered fallback chain (best → cheapest) ─────────────────

const FALLBACK_CHAINS: Record<Capability, string[]> = {
  coding: ['anthropic/claude-opus-4', 'anthropic/claude-sonnet-4', 'anthropic/claude-haiku-3'],
  reasoning: ['anthropic/claude-opus-4', 'openai/gpt-4o', 'deepseek/deepseek-v3'],
  vision: ['anthropic/claude-opus-4', 'anthropic/claude-sonnet-4', 'google/gemini-2.0'],
  speed: ['anthropic/claude-haiku-3', 'openai/gpt-4o-mini', 'deepseek/deepseek-v3'],
  cost_optimized: ['deepseek/deepseek-v3', 'anthropic/claude-haiku-3', 'openai/gpt-4o-mini'],
}

// ── Provider → capability mapping ─────────────────────────────────────────

/** Sustained latency above this (EMA) marks a CLOSED provider `degraded`. */
const DEGRADED_LATENCY_MS = 30_000

const PROVIDER_CAPABILITIES: Record<string, Capability[]> = {
  anthropic: ['coding', 'reasoning', 'vision', 'speed'],
  openai: ['coding', 'reasoning', 'speed', 'cost_optimized'],
  deepseek: ['coding', 'reasoning', 'speed', 'cost_optimized'],
  google: ['vision', 'cost_optimized'],
  openrouter: ['coding', 'reasoning', 'vision', 'speed', 'cost_optimized'],
  nvidia: ['coding', 'speed'],
}

export interface RegistryOptions {
  aliases?: Record<string, string>
  fallbacks?: string[]
  defaultProvider?: string
  /** Optional OTel-compatible tracing callback */
  onTrace?: (event: {
    type: string
    provider: string
    model: string
    latencyMs: number
    costUSD: number
    error?: string
  }) => void
  /** Optional rate limiter (per-identity token bucket) */
  rateLimiter?: RateLimiter
}

/** Provider registry uses per-provider CircuitBreaker from circuit-breaker.ts */
export class ProviderRegistry {
  private providers = new Map<string, ProviderConfig>()
  private keyRings = new Map<string, KeyRing>()
  private aliases: Record<string, string>
  private fallbacks: string[]
  private defaultProvider: string
  private onTrace?: RegistryOptions['onTrace']
  /** Real latency / last-check bookkeeping per provider (see noteOutcome). */
  private healthMeta = new Map<
    string,
    { latencyMs: number; lastCheck: number | null; lastSuccess: number | null }
  >()
  private rateLimiter?: RateLimiter

  constructor(providerMap: Record<string, ProviderConfig>, opts?: RegistryOptions) {
    for (const [k, v] of Object.entries(providerMap)) {
      this.providers.set(k, v)
      this.keyRings.set(k, new KeyRing(v.options.apiKey as string | string[]))
    }
    this.aliases = opts?.aliases ?? {}
    this.fallbacks = opts?.fallbacks ?? []
    this.defaultProvider = opts?.defaultProvider ?? 'openrouter'
    this.onTrace = opts?.onTrace
    this.rateLimiter = opts?.rateLimiter
  }

  // ── Core resolution ────────────────────────────────────────────────────

  /**
   * Expand alias: "sonnet" → "openrouter/anthropic/claude-sonnet-4".
   *
   * Alias lookup is case-insensitive, matching the provider-prefix matching
   * below. A mis-cased alias used to miss silently and then be treated as a
   * model id on the default provider — a real, billed request for a model that
   * does not exist. `Sonnet` now resolves to the same target as `sonnet`.
   */
  expandAlias(model: string): string {
    if (this.aliases[model]) return this.aliases[model]
    const lower = model.toLowerCase()
    const hit = Object.keys(this.aliases).find((k) => k.toLowerCase() === lower)
    return hit ? this.aliases[hit] : model
  }

  /** Longest-prefix resolution: "openrouter/anthropic/claude-sonnet-4" → provider openrouter, model "anthropic/claude-sonnet-4" */
  resolve(modelStr: string): ResolvedProvider {
    const expanded = this.expandAlias(modelStr)
    const expandedLower = expanded.toLowerCase()

    // Sort provider keys by length descending for longest-prefix match
    const sortedKeys = [...this.providers.keys()].sort((a, b) => b.length - a.length)

    let providerKey: string | null = null
    let modelID = expanded

    for (const key of sortedKeys) {
      const keyLower = key.toLowerCase()
      if (expandedLower === keyLower) {
        providerKey = key
        modelID = expanded
        break
      }
      if (expandedLower.startsWith(keyLower + '/')) {
        providerKey = key
        modelID = expanded.slice(key.length + 1)
        break
      }
    }

    // No prefix matched → use default provider
    if (!providerKey) {
      providerKey = this.defaultProvider
      if (!this.providers.has(providerKey)) {
        if (this.providers.has('openrouter')) providerKey = 'openrouter'
        else providerKey = sortedKeys[0] ?? 'openrouter'
      }
      modelID = expanded
    }

    const cfg = this.providers.get(providerKey)
    if (!cfg) {
      throw new ProviderError({
        message: `Provider "${providerKey}" not found for model "${modelStr}"`,
        code: 'PROVIDER_NOT_FOUND',
        provider: providerKey,
      })
    }

    // Check circuit breaker health before proceeding
    if (!this.isHealthy(providerKey)) {
      throw new ProviderError({
        message: `Circuit breaker OPEN for provider "${providerKey}" — failing fast`,
        code: 'CIRCUIT_OPEN',
        provider: providerKey,
        status: 503,
        retryable: true,
      })
    }

    // Rate-limit CAPACITY check only (peek, non-consuming). resolve() runs
    // several times per request (per candidate + a re-resolve of each fallback),
    // so charging here would bill one user request multiple tokens. The token is
    // charged once, at dispatch, via consumeRateLimit().
    if (this.rateLimiter) {
      const identity = `${providerKey}:${modelID}`
      const result = this.rateLimiter.peek(identity)
      if (!result.allowed) {
        throw new ProviderError({
          message: `Rate limited for "${identity}" — retry after ${result.retryAfterMs}ms`,
          code: 'RATE_LIMITED',
          provider: providerKey,
          status: 429,
          retryable: true,
        })
      }
    }

    const baseURL = expandEnv(cfg.options.baseURL)
    const headers = expandHeaders(cfg.options.headers)
    const timeout = cfg.options.timeout ?? 120_000
    // `kind` lets a user-defined provider key declare which known provider it
    // behaves like (see capabilitiesOf). Defaults to the key itself.
    const kind = (cfg.options.kind ?? providerKey) as ProviderKind
    const ring = this.keyRings.get(providerKey)
    const apiKey = ring?.current ?? expandEnvArray(cfg.options.apiKey as string | string[])[0] ?? ''

    if (!apiKey) {
      throw new ProviderError({
        message: `No API key configured for provider "${providerKey}" (model "${modelStr}")`,
        code: 'NO_API_KEY',
        provider: providerKey,
      })
    }

    return {
      providerKey,
      kind,
      baseURL,
      apiKey,
      headers,
      timeout,
      modelID,
    }
  }

  // ── 1. Model Router Pattern — routeByCapability ────────────────────────

  /**
   * Route a model string based on capability rather than just prefix.
   * Returns the best provider for the given capability.
   * Prefers healthy providers with valid keys.
   */
  routeByCapability(modelStr: string, capability: Capability): ResolvedProvider {
    const expanded = this.expandAlias(modelStr)
    const capableProviders = this.findCapableProviders(capability)

    // Filter to healthy providers with valid keys
    const healthyProviders = capableProviders.filter((k) => this.hasKey(k) && this.isHealthy(k))
    const candidates = healthyProviders.length > 0 ? healthyProviders : capableProviders

    // If model already has a provider prefix that is capable, use it directly
    try {
      const direct = this.resolve(modelStr)
      if (candidates.includes(direct.providerKey)) {
        this.emitTrace('route_by_capability', direct.providerKey, expanded, 0, 0)
        return direct
      }
    } catch {
      // Not directly resolvable, try capability routing
    }

    // Try each capable provider with the model string
    for (const prov of candidates) {
      try {
        const resolved = this.resolve(`${prov}/${expanded}`)
        this.emitTrace('route_by_capability', prov, expanded, 0, 0)
        return resolved
      } catch {
        continue
      }
    }

    // Last resort: default resolution
    const resolved = this.resolve(modelStr)
    this.emitTrace('route_by_capability', resolved.providerKey, expanded, 0, 0)
    return resolved
  }

  // ── 2. Capability-based fallback chains ────────────────────────────────

  /**
   * Returns ordered fallback chain for a capability.
   * e.g., coding: opus → sonnet → haiku (not random fallback).
   */
  getFallbackChain(modelStr: string, capability: Capability): ResolvedProvider[] {
    const chain = FALLBACK_CHAINS[capability]
    const results: ResolvedProvider[] = []
    const seen = new Set<string>()

    for (const model of chain) {
      try {
        const resolved = this.resolve(model)
        const key = `${resolved.providerKey}:${resolved.modelID}`
        if (!seen.has(key)) {
          seen.add(key)
          results.push(resolved)
        }
      } catch {
        // Skip unavailable models in the chain
        continue
      }
    }

    // Also add the original model if not already in chain
    try {
      const original = this.resolve(modelStr)
      const origKey = `${original.providerKey}:${original.modelID}`
      if (!seen.has(origKey)) {
        results.unshift(original)
      }
    } catch {
      // Original model not resolvable, skip
    }

    return results
  }

  // ── 3. Error classification for fallback ───────────────────────────────

  /**
   * Returns true for provider-level errors that SHOULD trigger fallback.
   * Delegates to classifyError for consistent classification.
   */
  static shouldFallback(error: ProviderError): boolean {
    const status = error.status ?? 0
    const cls = classifyError(status, error.message)
    // retryable errors should fallback after retries exhausted
    if (cls === 'retryable') return true
    // also check explicit codes
    if (error.code === 'RATE_LIMITED' || error.code === 'TIMEOUT') return true
    return false
  }

  // ── 4. Same-model retry with exponential backoff + jitter ──────────────

  /**
   * Retry the SAME model with exponential backoff + jitter before falling back.
   * Formula: delay = baseMs * 2^attempt + random(0, jitterMs)
   */
  async retryWithBackoff<T>(
    providerKey: string,
    modelID: string,
    fn: (providerKey: string, modelID: string) => Promise<T>,
    attempts: number = 3,
    baseMs: number = 1000,
    jitterMs: number = 500,
  ): Promise<T> {
    let lastError: Error | null = null

    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const result = await fn(providerKey, modelID)
        this.recordSuccess(providerKey)
        this.emitTrace('retry_success', providerKey, modelID, 0, 0)
        return result
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        const error =
          err instanceof ProviderError ? err : new ProviderError({ message: String(err) })

        // Only retry on retryable errors — 400/401/404 should NOT retry
        if (!ProviderRegistry.shouldFallback(error)) {
          this.emitTrace('retry_skip', providerKey, modelID, 0, 0, error.message)
          throw error
        }

        // Calculate exponential backoff with jitter
        const delay = exponentialBackoff(baseMs, attempt, jitterMs)
        this.emitTrace('retry_backoff', providerKey, modelID, delay, 0)

        // Wait before retrying
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }

    // All retries exhausted — record failure and throw
    this.recordFailure(providerKey)
    this.emitTrace('retry_exhausted', providerKey, modelID, 0, 0, lastError?.message)
    throw lastError ?? new Error('Retry exhausted')
  }

  // ── 5. Cost-aware routing ──────────────────────────────────────────────

  /**
   * Pick the cheapest provider whose model cost is under the budget.
   * Uses PRICING_TABLE from pricing.ts.
   * maxCostPer1k is the max cost per 1000 tokens (in USD).
   * Falls back to cheapest healthy provider if no model-specific match.
   */
  routeByCost(modelStr: string, maxCostPer1k: number): ResolvedProvider | null {
    const expanded = this.expandAlias(modelStr)

    // Collect all healthy providers with valid keys and their costs
    const candidates: Array<{ key: string; costPer1k: number }> = []

    for (const key of this.providers.keys()) {
      if (!this.hasKey(key)) continue
      if (!this.isHealthy(key)) continue

      // Use pricing for the model string directly
      const [inputCost, outputCost] = priceFor(expanded)
      const avgCostPer1k = (inputCost + outputCost) / 2 / 1000

      // Also check provider-specific models for more accurate pricing
      const cfg = this.providers.get(key)
      if (cfg && Object.keys(cfg.models).length > 0) {
        let matched = false
        for (const modelKey of Object.keys(cfg.models)) {
          if (expanded.toLowerCase().includes(modelKey.toLowerCase())) {
            const [mInput, mOutput] = priceFor(modelKey)
            const mCostPer1k = (mInput + mOutput) / 2 / 1000
            if (mCostPer1k <= maxCostPer1k) {
              candidates.push({ key, costPer1k: mCostPer1k })
            }
            matched = true
            break
          }
        }
        if (!matched && avgCostPer1k <= maxCostPer1k) {
          candidates.push({ key, costPer1k: avgCostPer1k })
        }
      } else if (avgCostPer1k <= maxCostPer1k) {
        candidates.push({ key, costPer1k: avgCostPer1k })
      }
    }

    if (candidates.length === 0) return null

    // Pick cheapest
    candidates.sort((a, b) => a.costPer1k - b.costPer1k)
    const best = candidates[0]

    try {
      const resolved = this.resolve(`${best.key}/${expanded}`)
      this.emitTrace('route_by_cost', best.key, expanded, 0, best.costPer1k)
      return resolved
    } catch {
      // If prefixed resolution fails, try direct
      try {
        const resolved = this.resolve(expanded)
        if (resolved.providerKey === best.key) {
          this.emitTrace('route_by_cost', best.key, expanded, 0, best.costPer1k)
          return resolved
        }
      } catch {}
      return null
    }
  }

  // ── 6. Health-aware routing ────────────────────────────────────────────

  /**
   * Check if a provider is healthy (circuit breaker not OPEN).
   */
  isHealthy(providerKey: string): boolean {
    const breaker = createCircuitBreaker(providerKey)
    return breaker.getState() !== 'OPEN'
  }

  /**
   * Get health status for a provider.
   *
   * `degraded` now has two real sources instead of one: a HALF_OPEN breaker, and
   * sustained high latency on a CLOSED breaker. Previously latency was hardcoded
   * to 0, so the latency branch could never fire and `degraded` was effectively
   * unreachable for a serving-but-slow provider.
   */
  getHealth(providerKey: string): ProviderHealth {
    const breaker = createCircuitBreaker(providerKey)
    const state = breaker.getState()
    const latencyMs = this.healthMeta.get(providerKey)?.latencyMs ?? 0
    const lastCheck = this.healthMeta.get(providerKey)?.lastCheck ?? null
    // Only judge latency on a recently-seen provider, so a provider that was
    // fast an hour ago is not called degraded forever.
    const latencyIsFresh = lastCheck !== null && Date.now() - lastCheck < 5 * 60_000
    const status =
      state === 'OPEN'
        ? ('down' as const)
        : state === 'HALF_OPEN' || (latencyIsFresh && latencyMs > DEGRADED_LATENCY_MS)
          ? ('degraded' as const)
          : ('healthy' as const)
    return {
      providerKey,
      state,
      status,
      latencyMs,
      lastCheck,
      failureCount: breaker.getFailureCount(),
      successCount: breaker.getSuccessCount(),
      lastFailureTime: breaker.getLastFailureTime(),
      lastSuccessTime: this.healthMeta.get(providerKey)?.lastSuccess ?? null,
      consecutiveFailures: breaker.getFailureCount(),
      cooldownUntil: state === 'OPEN' ? Date.now() + breaker.getTimeUntilReset() : null,
    }
  }

  /** Get health for all providers */
  getAllHealth(): Map<string, ProviderHealth> {
    const result = new Map<string, ProviderHealth>()
    for (const key of this.providers.keys()) {
      result.set(key, this.getHealth(key))
    }
    return result
  }

  /**
   * Charge one token for an actual outbound request.
   *
   * `resolve()` only PEEKS (see the note there) so that a single user request —
   * which resolves several times — is billed once. Call this immediately before
   * dispatching to the provider; returns false when the identity is over budget.
   */
  consumeRateLimit(providerKey: string, modelID: string, tokens = 1): boolean {
    if (!this.rateLimiter) return true
    return this.rateLimiter.check(`${providerKey}:${modelID}`, tokens).allowed
  }

  /**
   * Record success — delegates to per-provider CircuitBreaker.
   * `latencyMs` feeds the real latency reported by getHealth().
   */
  recordSuccess(providerKey: string, latencyMs?: number): void {
    const breaker = createCircuitBreaker(providerKey)
    breaker.recordSuccess()
    this.noteOutcome(providerKey, latencyMs, true)
  }

  /** Record failure — delegates to per-provider CircuitBreaker. */
  recordFailure(providerKey: string, latencyMs?: number): void {
    const breaker = createCircuitBreaker(providerKey)
    breaker.recordFailure()
    this.noteOutcome(providerKey, latencyMs, false)
  }

  /**
   * Track real latency / last-check time per provider.
   *
   * getHealth() previously hardcoded `latencyMs: 0` and `lastCheck: null`, so
   * every provider reported `healthy` with no latency evidence and the
   * `degraded` state was unreachable. Latency is an exponential moving average
   * (recent requests matter more than a long tail).
   */
  private noteOutcome(providerKey: string, latencyMs: number | undefined, ok: boolean): void {
    const cur = this.healthMeta.get(providerKey) ?? {
      latencyMs: 0,
      lastCheck: null,
      lastSuccess: null,
    }
    if (typeof latencyMs === 'number' && Number.isFinite(latencyMs) && latencyMs >= 0) {
      cur.latencyMs = cur.latencyMs === 0 ? latencyMs : cur.latencyMs * 0.7 + latencyMs * 0.3
      cur.lastCheck = Date.now()
    }
    if (ok) cur.lastSuccess = Date.now()
    this.healthMeta.set(providerKey, cur)
  }

  /** Check rate limit for an identity without consuming */
  checkRateLimit(identity: string): { allowed: boolean; retryAfterMs?: number } {
    if (!this.rateLimiter) return { allowed: true }
    return this.rateLimiter.check(identity, 0)
  }

  /** Get rate limiter instance */
  getRateLimiter(): RateLimiter | undefined {
    return this.rateLimiter
  }

  /** Set rate limiter */
  setRateLimiter(limiter: RateLimiter): void {
    this.rateLimiter = limiter
  }

  // ── Existing methods (preserved) ───────────────────────────────────────

  /** Resolve with fallbacks: primary + routing fallbacks */
  resolveWithFallbacks(modelStr: string): ResolvedProvider[] {
    const results: ResolvedProvider[] = []
    const seen = new Set<string>()

    const tryAdd = (m: string) => {
      try {
        const r = this.resolve(m)
        const key = `${r.providerKey}:${r.modelID}`
        if (!seen.has(key)) {
          seen.add(key)
          results.push(r)
        }
      } catch (e) {
        // Skip candidates that cannot serve a request right now, so ONE bad
        // candidate cannot discard the rest of the chain:
        //   NO_API_KEY    — no credential configured
        //   CIRCUIT_OPEN  — that provider is cooling down after failures
        //   RATE_LIMITED  — that provider's bucket is exhausted
        // The request then goes to the next candidate instead of dying on a
        // provider that was never going to answer.
        if (e instanceof ProviderError) {
          if (e.code === 'NO_API_KEY' || e.code === 'CIRCUIT_OPEN' || e.code === 'RATE_LIMITED') {
            return
          }
          throw e
        }
        throw e
      }
    }

    tryAdd(modelStr)
    for (const fb of this.fallbacks) {
      tryAdd(fb)
    }

    if (results.length === 0) {
      // Every candidate was skipped. Surface the primary's real reason rather
      // than a bare resolve() error that hides the cause.
      return [this.resolve(modelStr)]
    }

    return results
  }

  /** Get provider config by key */
  getProvider(key: string): ProviderConfig | undefined {
    return this.providers.get(key)
  }

  /** List all provider keys */
  keys(): string[] {
    return [...this.providers.keys()]
  }

  /** Check if provider has valid key */
  hasKey(providerKey: string): boolean {
    const ring = this.keyRings.get(providerKey)
    if (ring) return ring.hasKey
    const cfg = this.providers.get(providerKey)
    if (!cfg) return false
    return expandEnvArray(cfg.options.apiKey as string | string[]).some(Boolean)
  }

  /** Rotate key for provider on 429/401, return new key or null */
  rotateKey(providerKey: string): string | null {
    const ring = this.keyRings.get(providerKey)
    if (!ring) return null
    return ring.rotate()
  }

  /** Get current key for provider */
  getKey(providerKey: string): string {
    const ring = this.keyRings.get(providerKey)
    if (ring) return ring.current
    const cfg = this.providers.get(providerKey)
    if (!cfg) return ''
    return expandEnvArray(cfg.options.apiKey as string | string[])[0] ?? ''
  }

  /** Get all keys for provider */
  getAllKeys(providerKey: string): string[] {
    const ring = this.keyRings.get(providerKey)
    if (ring) return ring.all
    const cfg = this.providers.get(providerKey)
    if (!cfg) return []
    return expandEnvArray(cfg.options.apiKey as string | string[])
  }

  /** Update provider config (for runtime changes) */
  setProvider(key: string, cfg: ProviderConfig): void {
    this.providers.set(key, cfg)
    this.keyRings.set(key, new KeyRing(cfg.options.apiKey as string | string[]))
  }

  /** Get headers for provider (expanded) */
  getHeaders(providerKey: string): Record<string, string> {
    const cfg = this.providers.get(providerKey)
    if (!cfg) return {}
    return expandHeaders(cfg.options.headers)
  }

  /** Get baseURL for provider (expanded) */
  getBaseURL(providerKey: string): string {
    const cfg = this.providers.get(providerKey)
    if (!cfg) return ''
    return expandEnv(cfg.options.baseURL)
  }

  // ── Private helpers ────────────────────────────────────────────────────

  /**
   * Capabilities for a provider entry.
   *
   * The map KEY is looked up first, then `options.kind`. The `kind` fallback is
   * what makes the field functional: a user-defined key (`corp-gateway`,
   * `openrouter-mirror`, `my-nvidia`) matches no table entry, so capability and
   * cost routing silently ignored it. Declaring `options.kind: 'openrouter'`
   * now lets a custom key declare which known provider it behaves like.
   */
  private capabilitiesOf(key: string): Capability[] {
    const byKey = PROVIDER_CAPABILITIES[key]
    if (byKey) return byKey
    const kind = this.providers.get(key)?.options?.kind
    if (kind && PROVIDER_CAPABILITIES[kind]) return PROVIDER_CAPABILITIES[kind]
    return []
  }

  /** Test seam: capabilities the registry derives for a provider key. */
  capabilitiesOfPublic(key: string): Capability[] {
    return this.capabilitiesOf(key)
  }

  /** Find providers that support a given capability */
  private findCapableProviders(capability: Capability): string[] {
    return Object.keys(this.providers).filter((key) =>
      this.capabilitiesOf(key).includes(capability),
    )
  }

  /** Emit a trace event if onTrace callback is configured */
  private emitTrace(
    type: string,
    provider: string,
    model: string,
    latencyMs: number,
    costUSD: number,
    error?: string,
  ): void {
    if (this.onTrace) {
      this.onTrace({ type, provider, model, latencyMs, costUSD, error })
    }
  }
}
