/**
 * Gateway — Subgateway
 *
 * Isolated Gateway instance per lane (default, cheap, vision, local, compaction, agent:ask, etc.)
 * Own provider/model/fallback/rateLimit/costCap/retry/timeout/stats/circuitBreaker.
 * Implements fetch+SSE, retry, fallback chain, TokenBucket, SubgatewayStatsCollector, SubgatewayError, circuit breaker.
 */

import type { MiraConfig } from '../types/index.js'
import type { Gateway, GatewayChunk, GatewayMessage, StreamOptions, GatewayStats } from './types.js'
import { ProviderError } from './errors.js'
import { ProviderRegistry } from '../providers/registry.js'
import { KeyRing, classifyError } from '../providers/auth.js'
import { liveOpenAIStream } from './stream.js'
import { backoffWithJitter, parseRetryAfter } from './retry.js'
import { summarizeWithFallback, extractiveFallback } from './summarize.js'
import { listModels as listModelsWithCache } from './models.js'
import { buildRegistry } from './provider.js'
import { TokenBucket } from './rate-limiter.js'
import { SubgatewayStatsCollector } from './stats.js'
import { CircuitBreaker } from '../providers/circuit-breaker.js'
import { priceFor } from '../providers/pricing.js'

export class SubgatewayError extends ProviderError {
  lane: string
  constructor(opts: {
    message: string
    code?: string
    provider?: string
    status?: number
    lane: string
    remediation?: string
    retryable?: boolean
  }) {
    super({
      message: opts.message,
      code: opts.code as never,
      provider: opts.provider,
      status: opts.status,
      remediation: opts.remediation,
      retryable: opts.retryable,
    })
    this.name = 'SubgatewayError'
    this.lane = opts.lane
  }
}

export interface SubgatewayConfig {
  provider?: string
  model?: string
  fallback?: string[]
  rateLimit?: { rps?: number; burst?: number }
  costCap?: { perTask?: number; perSession?: number }
  retry?: { maxAttempts?: number; baseMs?: number; maxMs?: number }
  timeout?: number
  circuitBreaker?: { failureThreshold?: number; resetTimeoutMs?: number }
  enabled?: boolean
}

export interface SubgatewayOptions {
  lane: string
  config: SubgatewayConfig
  globalConfig: MiraConfig
  registry?: ProviderRegistry
}

type CircuitState = 'closed' | 'open' | 'half-open'

async function* trackedStream(
  iter: AsyncIterable<GatewayChunk>,
  onUsage: (u: { input: number; output: number }) => void,
): AsyncIterable<GatewayChunk> {
  for await (const chunk of iter) {
    const u =
      chunk?.type === 'finish'
        ? (chunk as { usage?: unknown }).usage
        : chunk?.type === 'usage-report'
          ? (chunk as { usage?: unknown }).usage
          : null
    if (u && typeof u === 'object') {
      const input =
        Number(
          (u as Record<string, unknown>).inputTokens ??
            (u as Record<string, unknown>).prompt_tokens ??
            (u as Record<string, unknown>).promptTokens ??
            0,
        ) || 0
      const output =
        Number(
          (u as Record<string, unknown>).outputTokens ??
            (u as Record<string, unknown>).completion_tokens ??
            (u as Record<string, unknown>).completionTokens ??
            0,
        ) || 0
      if (input || output) {
        if (chunk.type === 'finish')
          (chunk as { usage: unknown }).usage = { inputTokens: input, outputTokens: output }
        onUsage({ input, output })
      }
    }
    yield chunk
  }
}

export class Subgateway implements Gateway {
  readonly lane: string
  readonly statsCollector: SubgatewayStatsCollector
  readonly rateLimiter: TokenBucket
  private registry: ProviderRegistry
  private globalConfig: MiraConfig
  private subConfig: SubgatewayConfig

  // circuit breaker — per-lane isolation using shared CircuitBreaker class
  private breaker: CircuitBreaker

  // cost tracking per lane
  private costUSD = 0

  constructor(opts: SubgatewayOptions) {
    this.lane = opts.lane
    this.subConfig = opts.config
    this.globalConfig = opts.globalConfig
    this.registry = opts.registry ?? buildRegistry(opts.globalConfig)
    this.statsCollector = new SubgatewayStatsCollector(opts.lane)
    const rps = opts.config.rateLimit?.rps ?? 10
    const burst = opts.config.rateLimit?.burst ?? rps * 2
    this.rateLimiter = new TokenBucket({ rps, burst })
    this.breaker = new CircuitBreaker({
      failureThreshold: opts.config.circuitBreaker?.failureThreshold ?? 5,
      resetTimeoutMs: opts.config.circuitBreaker?.resetTimeoutMs ?? 30_000,
    })
  }

  /** Update config (called by Registry.syncFromConfig) */
  syncConfig(subConfig: SubgatewayConfig, globalConfig: MiraConfig): void {
    this.subConfig = subConfig
    this.globalConfig = globalConfig
    this.registry = buildRegistry(globalConfig)
    const rps = subConfig.rateLimit?.rps ?? 10
    const burst = subConfig.rateLimit?.burst ?? rps * 2
    if (rps !== this.rateLimiter.config.rps || burst !== this.rateLimiter.config.burst) {
      ;(this as unknown as { rateLimiter: TokenBucket }).rateLimiter = new TokenBucket({ rps, burst })
    }
    // recreate breaker if threshold changed
    const ft = subConfig.circuitBreaker?.failureThreshold ?? 5
    const rt = subConfig.circuitBreaker?.resetTimeoutMs ?? 30_000
    if (ft !== this.breaker.config.failureThreshold || rt !== this.breaker.config.resetTimeoutMs) {
      this.breaker = new CircuitBreaker({ failureThreshold: ft, resetTimeoutMs: rt })
    }
  }

  private checkCircuit(): void {
    if (!this.breaker.canAttempt()) {
      const waitMs = this.breaker.getTimeUntilReset()
      throw new SubgatewayError({
        message: `Circuit breaker open for lane "${this.lane}" — retry after ${Math.ceil(waitMs / 1000)}s`,
        code: 'CIRCUIT_OPEN',
        lane: this.lane,
        status: 503,
        retryable: true,
      })
    }
  }

  private recordSuccess(): void {
    this.breaker.recordSuccess()
  }

  private recordFailure(): void {
    this.breaker.recordFailure()
  }

  private checkRateLimit(): void {
    const res = this.rateLimiter.consumeOrDelay(1)
    if (!res.allowed) {
      throw new SubgatewayError({
        message: `Rate limited on lane "${this.lane}" — retry after ${res.retryAfterMs}ms`,
        code: 'RATE_LIMITED',
        lane: this.lane,
        status: 429,
        retryable: true,
      })
    }
  }

  private checkCostCap(estimatedInputTokens: number, estimatedOutputTokens: number, modelID?: string): void {
    const cap = this.subConfig.costCap ?? (this.globalConfig as unknown as { costCap?: { perTask?: number; perSession?: number } }).costCap
    if (!cap) return
    const current = this.statsCollector.snapshot().costUSD
    // Check already-over-cap
    if (cap.perTask !== undefined && current > cap.perTask) {
      throw new SubgatewayError({
        message: `Cost cap exceeded on lane "${this.lane}": $${current.toFixed(4)} > $${cap.perTask.toFixed(4)} per-task`,
        code: 'COST_CAP_EXCEEDED',
        lane: this.lane,
        status: 402,
      })
    }
    // Estimate cost for this request before making it
    if (modelID && estimatedInputTokens + estimatedOutputTokens > 0 && cap.perTask !== undefined) {
      const [inputPrice, outputPrice] = priceFor(modelID)
      const estimatedCost = (estimatedInputTokens * inputPrice + estimatedOutputTokens * outputPrice) / 1_000_000
      if (current + estimatedCost > cap.perTask) {
        throw new SubgatewayError({
          message: `Cost cap would be exceeded on lane "${this.lane}": $${current.toFixed(4)} + $${estimatedCost.toFixed(4)} > $${cap.perTask.toFixed(4)} per-task (model ${modelID})`,
          code: 'COST_CAP_EXCEEDED',
          lane: this.lane,
          status: 402,
        })
      }
    }
  }

  /** Estimate tokens from messages: ~4 chars per token heuristic */
  private estimateTokens(messages: GatewayMessage[], maxTokens?: number): { input: number; output: number } {
    let chars = 0
    for (const m of messages) {
      if (typeof m.content === 'string') chars += m.content.length
      else if (Array.isArray(m.content)) {
        for (const p of m.content as Array<{ text?: string }>) chars += p.text?.length ?? 0
      }
      chars += m.role.length
    }
    const input = Math.ceil(chars / 4)
    const output = maxTokens ?? 1024
    return { input, output }
  }

  private resolveModelID(requestedModel: string): string {
    if (!requestedModel) return this.subConfig.model ?? requestedModel
    // Lane model is fallback only when no explicit model requested
    // For dedicated lanes (compaction/vision/cheap), lane model takes precedence only if requested is empty
    return requestedModel || this.subConfig.model!
  }

  async stream(opts: StreamOptions): Promise<AsyncIterable<GatewayChunk>> {
    this.checkCircuit()
    this.checkRateLimit()
    const est = this.estimateTokens(opts.messages as GatewayMessage[], opts.maxTokens)
    // cost cap check with estimate before making the call
    const modelForCap = this.resolveModelID(opts.model)
    this.checkCostCap(est.input, est.output, modelForCap)

    const t0 = Date.now()
    const model = this.resolveModelID(opts.model)
    let candidates: ReturnType<ProviderRegistry['resolveWithFallbacks']>
    try {
      candidates = this.registry.resolveWithFallbacks(model)
    } catch (e) {
      if (e instanceof ProviderError)
        throw new SubgatewayError({
          message: e.message,
          code: e.code,
          provider: e.provider,
          lane: this.lane,
          status: e.status,
        })
      throw new SubgatewayError({
        message: String(e),
        code: 'PROVIDER_NOT_FOUND',
        lane: this.lane,
        provider: model,
      })
    }

    // Merge lane fallback with registry fallbacks
    if (this.subConfig.fallback?.length) {
      for (const fb of this.subConfig.fallback) {
        try {
          const r = this.registry.resolve(fb)
          const key = `${r.providerKey}:${r.modelID}`
          if (!candidates.some((c) => `${c.providerKey}:${c.modelID}` === key)) candidates.push(r)
        } catch {}
      }
    }

    const maxAttempts = this.subConfig.retry?.maxAttempts ?? 3
    const baseMs = this.subConfig.retry?.baseMs ?? 500
    const maxMs = this.subConfig.retry?.maxMs ?? 10_000
    const timeout = this.subConfig.timeout ?? candidates[0]?.timeout ?? 120_000

    let lastError: ProviderError | Error | null = null
    for (const cand of candidates) {
      const allKeys = this.registry.getAllKeys(cand.providerKey)
      const keysToTry = allKeys.length ? allKeys : [cand.apiKey]
      // Try each key with retries before moving to next candidate
      let candidateFailed = false
      for (const key of keysToTry) {
        if (!key) {
          lastError = new SubgatewayError({
            message: `No API key configured for provider "${cand.providerKey}" (model "${opts.model}") lane "${this.lane}"`,
            code: 'NO_API_KEY',
            provider: cand.providerKey,
            lane: this.lane,
          })
          candidateFailed = true
          continue
        }
        let keyExhausted = false
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          if (opts.signal?.aborted) {
            throw new SubgatewayError({
              message: 'Aborted',
              code: 'ABORTED',
              provider: cand.providerKey,
              lane: this.lane,
              status: 499,
            })
          }
          let timer: ReturnType<typeof setTimeout> | null = null
          try {
            const iter = await liveOpenAIStream({
              baseURL: cand.baseURL,
              apiKey: key,
              headers: cand.headers,
              timeout: cand.timeout ?? timeout,
              modelID: cand.modelID,
              opts,
            })
            this.recordSuccess()
            return trackedStream(iter, (usage) => {
              this.statsCollector.record(cand.modelID, usage.input, usage.output, Date.now() - t0)
              const cap = (this.subConfig.costCap ?? (this.globalConfig as unknown as { costCap?: { perTask?: number } }).costCap)
              if (cap?.perTask !== undefined) {
                const cur = this.statsCollector.snapshot().costUSD
                if (cur > cap.perTask) {
                  console.warn(`[subgateway:${this.lane}] cost cap exceeded $${cur.toFixed(4)} > $${cap.perTask.toFixed(4)}`)
                }
              }
            })
          } catch (e) {
            const err = e as ProviderError & { retryAfter?: string | null; headers?: Headers }
            const msg = err.message ?? String(e)
            const status = err.status ?? (() => { const m = msg.match(/\b(\d{3})\b/); return m ? Number(m[1]) : undefined })()
            const isRotatable = KeyRing.isRotatableError(status, msg)
            const cls = classifyError(status ?? 0, msg)
            const retryable = err.retryable ?? cls === 'retryable'

            // If rotatable and more keys available, try next key immediately
            if (isRotatable) {
              lastError = new SubgatewayError({
                message: msg,
                code: status === 429 ? 'RATE_LIMITED' : status === 401 ? 'UNAUTHORIZED' : 'PROVIDER_ERROR',
                provider: cand.providerKey,
                lane: this.lane,
                status,
              })
              keyExhausted = true
              break
            }

            if (!retryable || attempt === maxAttempts - 1) {
              lastError = e as Error
              keyExhausted = true
              break
            }
            const retryAfterHeader = (err as unknown as { retryAfter?: string }).retryAfter ?? err.headers?.get?.('retry-after') ?? null
            const parsed = parseRetryAfter(retryAfterHeader)
            const delay = parsed !== null ? parsed : backoffWithJitter(attempt, baseMs, maxMs)
            await new Promise<void>((resolve, reject) => {
              timer = setTimeout(resolve, delay)
              if (opts.signal) {
                const onAbort = () => {
                  if (timer) clearTimeout(timer)
                  reject(new SubgatewayError({ message: 'Aborted', code: 'ABORTED', provider: cand.providerKey, lane: this.lane, status: 499 }))
                }
                if (opts.signal!.aborted) {
                  if (timer) clearTimeout(timer)
                  reject(new SubgatewayError({ message: 'Aborted', code: 'ABORTED', provider: cand.providerKey, lane: this.lane, status: 499 }))
                  return
                }
                opts.signal!.addEventListener('abort', onAbort, { once: true })
              }
            }).catch((abortErr) => { throw abortErr }).finally(() => { if (timer) clearTimeout(timer) })
          } finally {
            if (timer) clearTimeout(timer)
          }
        }
        // If key was rotatable, continue to next key; otherwise break candidate
        if (keyExhausted && lastError instanceof ProviderError && (lastError.code === 'RATE_LIMITED' || lastError.code === 'UNAUTHORIZED')) {
          // Check if more keys remain
          const remaining = keysToTry.slice(keysToTry.indexOf(key) + 1)
          if (remaining.length > 0) continue
        }
        if (lastError) { candidateFailed = true; break }
      }
      if (candidateFailed && lastError) {
        // If last error was rotatable and we exhausted keys, try next candidate
        if (lastError instanceof ProviderError && (lastError.code === 'RATE_LIMITED' || lastError.code === 'UNAUTHORIZED')) {
          continue
        }
        break
      }
    }

    this.recordFailure()
    if (lastError instanceof ProviderError) {
      if (lastError instanceof SubgatewayError) throw lastError
      throw new SubgatewayError({
        message: lastError.message,
        code: lastError.code,
        provider: lastError.provider,
        lane: this.lane,
        status: lastError.status,
      })
    }
    if (lastError) {
      throw new SubgatewayError({
        message: `Gateway stream failed for ${opts.model} lane ${this.lane}: ${lastError.message}`,
        code: 'PROVIDER_ERROR',
        provider: candidates[0]?.providerKey,
        lane: this.lane,
        remediation: lastError.message,
      })
    }
    throw new SubgatewayError({
      message: `No provider available for model "${opts.model}" lane "${this.lane}" — no API key configured`,
      code: 'NO_API_KEY',
      provider: candidates[0]?.providerKey ?? 'openrouter',
      lane: this.lane,
    })
  }

  async complete(opts: {
    model: string
    system?: string
    prompt: string | import('./types.js').GatewayContentPart[]
    maxTokens?: number
  }): Promise<{ text: string; inputTokens?: number; outputTokens?: number }> {
    this.checkCircuit()
    this.checkRateLimit()
    const t0 = Date.now()
    const model = this.resolveModelID(opts.model)
    let resolved: ReturnType<ProviderRegistry['resolve']>
    try {
      resolved = this.registry.resolve(model)
    } catch (e) {
      if (e instanceof ProviderError)
        throw new SubgatewayError({
          message: e.message,
          code: e.code,
          provider: e.provider,
          lane: this.lane,
          status: e.status,
        })
      throw new SubgatewayError({
        message: String(e),
        code: 'PROVIDER_NOT_FOUND',
        provider: model,
        lane: this.lane,
      })
    }
    if (!resolved.apiKey) {
      throw new SubgatewayError({
        message: `No API key configured for provider "${resolved.providerKey}" lane "${this.lane}"`,
        code: 'NO_API_KEY',
        provider: resolved.providerKey,
        lane: this.lane,
      })
    }
    const allKeys = this.registry.getAllKeys(resolved.providerKey)
    const keysToTry = allKeys.length ? allKeys : [resolved.apiKey]
    const timeout = this.subConfig.timeout ?? resolved.timeout
    let lastErr: Error | null = null
    for (const key of keysToTry) {
      try {
        const res = await fetch(`${resolved.baseURL.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
            'HTTP-Referer': 'https://mira.ai',
            'X-Title': 'Mira',
            ...resolved.headers,
          },
          body: JSON.stringify({
            model: resolved.modelID,
            messages: [
              ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
              { role: 'user', content: opts.prompt },
            ],
            max_tokens: opts.maxTokens ?? 1024,
          }),
          signal: AbortSignal.timeout(timeout),
        })
        if (!res.ok) {
          const txt = (await res.text()).slice(0, 500)
          const status = res.status
          if (
            (status === 429 || status === 401) &&
            keysToTry.length > 1 &&
            key !== keysToTry[keysToTry.length - 1]
          ) {
            lastErr = new Error(`Gateway ${status}: ${txt}`)
            continue
          }
          throw new SubgatewayError({
            message: `complete() ${status}: ${txt}`,
            code:
              status === 429 ? 'RATE_LIMITED' : status === 401 ? 'UNAUTHORIZED' : 'PROVIDER_ERROR',
            provider: resolved.providerKey,
            lane: this.lane,
            status,
          })
        }
        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>
          usage?: { prompt_tokens?: number; completion_tokens?: number }
        }
        const text = data.choices?.[0]?.message?.content ?? ''
        this.statsCollector.record(
          resolved.modelID,
          data.usage?.prompt_tokens ?? 0,
          data.usage?.completion_tokens ?? 0,
          Date.now() - t0,
        )
        this.recordSuccess()
        return {
          text,
          inputTokens: data.usage?.prompt_tokens,
          outputTokens: data.usage?.completion_tokens,
        }
      } catch (e) {
        lastErr = e as Error
        if (
          KeyRing.isRotatableError(undefined, (e as Error).message) &&
          key !== keysToTry[keysToTry.length - 1]
        )
          continue
        if (e instanceof SubgatewayError) throw e
        if (e instanceof ProviderError)
          throw new SubgatewayError({
            message: e.message,
            code: e.code,
            provider: e.provider,
            lane: this.lane,
            status: e.status,
          })
        throw e
      }
    }
    this.recordFailure()
    throw (
      lastErr ??
      new SubgatewayError({
        message: 'complete() failed',
        code: 'PROVIDER_ERROR',
        provider: resolved.providerKey,
        lane: this.lane,
      })
    )
  }

  async summarize(messages: GatewayMessage[], smallModel?: string): Promise<string> {
    const model =
      smallModel ?? this.subConfig.model ?? this.globalConfig.smallModel ?? this.globalConfig.model
    let resolved: ReturnType<ProviderRegistry['resolve']>
    try {
      resolved = this.registry.resolve(model)
    } catch (e) {
      if (e instanceof ProviderError)
        throw new SubgatewayError({
          message: e.message,
          code: e.code,
          provider: e.provider,
          lane: this.lane,
          status: e.status,
        })
      throw new SubgatewayError({
        message: String(e),
        code: 'PROVIDER_NOT_FOUND',
        provider: model,
        lane: this.lane,
      })
    }
    if (!resolved.apiKey) {
      console.warn(
        `[subgateway:${this.lane}] summarize: no API key for ${resolved.providerKey}, using extractive fallback`,
      )
      return extractiveFallback(messages)
    }
    const allKeys = this.registry.getAllKeys(resolved.providerKey)
    try {
      const result = await summarizeWithFallback(
        messages,
        {
          baseURL: resolved.baseURL,
          apiKey: resolved.apiKey,
          headers: resolved.headers,
          timeout: resolved.timeout,
          modelID: resolved.modelID,
          providerKey: resolved.providerKey,
        },
        allKeys,
      )
      this.recordSuccess()
      return result
    } catch (e) {
      if (e instanceof ProviderError)
        throw new SubgatewayError({
          message: e.message,
          code: e.code,
          provider: e.provider,
          lane: this.lane,
          status: e.status,
        })
      console.warn(
        `[subgateway:${this.lane}] summarize failed, using extractive fallback:`,
        (e as Error).message,
      )
      return extractiveFallback(messages)
    }
  }

  async listModels(): Promise<Array<{ id: string; name: string; context: number }>> {
    let resolved: ReturnType<ProviderRegistry['resolve']>
    try {
      resolved = this.registry.resolve('openrouter/dummy')
    } catch (e) {
      if (e instanceof ProviderError)
        throw new SubgatewayError({
          message: e.message,
          code: e.code,
          provider: e.provider,
          lane: this.lane,
          status: e.status,
        })
      throw new SubgatewayError({
        message: String(e),
        code: 'PROVIDER_NOT_FOUND',
        provider: 'openrouter',
        lane: this.lane,
      })
    }
    if (!resolved.apiKey) {
      throw new SubgatewayError({
        message: 'No API key configured for provider "openrouter" — cannot list models',
        code: 'NO_API_KEY',
        provider: 'openrouter',
        lane: this.lane,
      })
    }
    return listModelsWithCache({
      baseURL: resolved.baseURL,
      apiKey: resolved.apiKey,
      headers: resolved.headers,
      providerKey: resolved.providerKey,
    })
  }

  stats(): GatewayStats {
    return this.statsCollector.snapshot()
  }

  health(): { lane: string; circuit: CircuitState; failureCount: number; stats: GatewayStats } {
    const state = this.breaker.getState()
    const circuit: CircuitState = state === 'CLOSED' ? 'closed' : state === 'OPEN' ? 'open' : 'half-open'
    return {
      lane: this.lane,
      circuit,
      failureCount: this.breaker.getFailureCount(),
      stats: this.stats(),
    }
  }

  /** For testing: force circuit open */
  _forceOpen(): void {
    // force open by recording failures up to threshold
    const needed = this.breaker.config.failureThreshold - this.breaker.getFailureCount()
    for (let i = 0; i < needed; i++) this.breaker.recordFailure()
    // ensure it's open
    if (this.breaker.getState() !== 'OPEN') {
      for (let i = 0; i < this.breaker.config.failureThreshold; i++) this.breaker.recordFailure()
    }
  }

  _resetCircuit(): void {
    this.breaker = new CircuitBreaker({
      failureThreshold: this.breaker.config.failureThreshold,
      resetTimeoutMs: this.breaker.config.resetTimeoutMs,
    })
  }
}
