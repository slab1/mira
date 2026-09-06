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
import { KeyRing } from '../providers/auth.js'
import { liveOpenAIStream } from './stream.js'
import { backoffWithJitter, parseRetryAfter } from './retry.js'
import { summarizeWithFallback, extractiveFallback } from './summarize.js'
import { listModels as listModelsWithCache } from './models.js'
import { buildRegistry } from './provider.js'
import { TokenBucket } from './rate-limiter.js'
import { SubgatewayStatsCollector } from './stats.js'

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

  // circuit breaker
  private circuitState: CircuitState = 'closed'
  private failureCount = 0
  private lastFailureAt = 0
  private failureThreshold: number
  private resetTimeoutMs: number

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
    this.failureThreshold = opts.config.circuitBreaker?.failureThreshold ?? 5
    this.resetTimeoutMs = opts.config.circuitBreaker?.resetTimeoutMs ?? 30_000
  }

  /** Update config (called by Registry.syncFromConfig) */
  syncConfig(subConfig: SubgatewayConfig, globalConfig: MiraConfig): void {
    this.subConfig = subConfig
    this.globalConfig = globalConfig
    // rebuild registry if provider changed? For now rebuild
    this.registry = buildRegistry(globalConfig)
    // update rate limiter if changed — recreate if rps/burst differ
    const rps = subConfig.rateLimit?.rps ?? 10
    const burst = subConfig.rateLimit?.burst ?? rps * 2
    if (rps !== this.rateLimiter.config.rps || burst !== this.rateLimiter.config.burst) {
      // replace bucket
      ;(this as unknown as { rateLimiter: TokenBucket }).rateLimiter = new TokenBucket({
        rps,
        burst,
      })
    }
    this.failureThreshold = subConfig.circuitBreaker?.failureThreshold ?? 5
    this.resetTimeoutMs = subConfig.circuitBreaker?.resetTimeoutMs ?? 30_000
  }

  private checkCircuit(): void {
    if (this.circuitState === 'open') {
      const elapsed = Date.now() - this.lastFailureAt
      if (elapsed >= this.resetTimeoutMs) {
        this.circuitState = 'half-open'
      } else {
        throw new SubgatewayError({
          message: `Circuit breaker open for lane "${this.lane}" — too many failures (${this.failureCount}), retry after ${Math.ceil((this.resetTimeoutMs - elapsed) / 1000)}s`,
          code: 'CIRCUIT_OPEN',
          lane: this.lane,
          status: 503,
          retryable: true,
        })
      }
    }
  }

  private recordSuccess(): void {
    this.failureCount = 0
    if (this.circuitState === 'half-open') this.circuitState = 'closed'
  }

  private recordFailure(): void {
    this.failureCount++
    this.lastFailureAt = Date.now()
    if (this.failureCount >= this.failureThreshold) {
      this.circuitState = 'open'
    } else if (this.circuitState === 'half-open') {
      this.circuitState = 'open'
    }
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

  private checkCostCap(inputTokens: number, outputTokens: number): void {
    const cap = this.subConfig.costCap ?? this.globalConfig.costCap
    if (!cap) return
    // perTask check uses lane cost + current request estimate
    // We estimate cost for this request; if exceeds, throw
    // Use priceFor via statsCollector? approximate via default pricing
    // For simplicity, use lane's costUSD + estimated
    // Estimate via cheapest pricing fallback [1,2] if unknown
    // Better: use statsCollector's costUSD
    const current = this.statsCollector.snapshot().costUSD
    // We don't have token estimate before call, so check after record in stream/complete
    // Here we just check if already over cap
    if (cap.perTask !== undefined && current > cap.perTask) {
      throw new SubgatewayError({
        message: `Cost cap exceeded on lane "${this.lane}": $${current.toFixed(4)} > $${cap.perTask.toFixed(4)} per-task`,
        code: 'COST_CAP_EXCEEDED',
        lane: this.lane,
        status: 402,
      })
    }
  }

  private resolveModelID(requestedModel: string): string {
    // Lane model override takes precedence if lane has model and requested is generic
    // But if requestedModel is explicit, use it; otherwise use lane's model
    if (this.subConfig.model) {
      // If requestedModel is empty or lane is compaction/cheap, prefer lane model
      // For now, if lane model exists and requestedModel doesn't contain lane-specific hint, use lane model when lane is compaction/cheap/vision
      // Simpler: if lane != default and subConfig.model, use subConfig.model when requestedModel is default model
      // To keep backward compat, if requestedModel is provided, honor it; lane model is fallback for summarize etc.
      // We'll use requestedModel if given, else lane model
      return requestedModel || this.subConfig.model
    }
    return requestedModel
  }

  async stream(opts: StreamOptions): Promise<AsyncIterable<GatewayChunk>> {
    this.checkCircuit()
    this.checkRateLimit()
    this.checkCostCap(0, 0)

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
      for (let ki = 0; ki < keysToTry.length; ki++) {
        const key = keysToTry[ki]
        if (!key) {
          lastError = new SubgatewayError({
            message: `No API key configured for provider "${cand.providerKey}" (model "${opts.model}") lane "${this.lane}"`,
            code: 'NO_API_KEY',
            provider: cand.providerKey,
            lane: this.lane,
          })
          continue
        }
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
              // cost cap check after record
              const cap = this.subConfig.costCap ?? this.globalConfig.costCap
              if (cap?.perTask !== undefined) {
                const cur = this.statsCollector.snapshot().costUSD
                if (cur > cap.perTask) {
                  console.warn(
                    `[subgateway:${this.lane}] cost cap exceeded $${cur.toFixed(4)} > $${cap.perTask.toFixed(4)}`,
                  )
                }
              }
            })
          } catch (e) {
            const err = e as ProviderError & { retryAfter?: string | null; headers?: Headers }
            const msg = err.message ?? String(e)
            const status =
              err.status ??
              (() => {
                const m = msg.match(/\b(\d{3})\b/)
                return m ? Number(m[1]) : undefined
              })()
            const isRotatable =
              status === 429 || status === 401 || KeyRing.isRotatableError(status, msg)
            const retryable =
              err.retryable ??
              (/429|5\d\d|timeout|ECONN/i.test(msg) ||
                status === 429 ||
                (status !== undefined && status >= 500))

            if (isRotatable && ki + 1 < keysToTry.length) {
              lastError = new SubgatewayError({
                message: msg,
                code:
                  status === 429
                    ? 'RATE_LIMITED'
                    : status === 401
                      ? 'UNAUTHORIZED'
                      : 'PROVIDER_ERROR',
                provider: cand.providerKey,
                lane: this.lane,
                status,
              })
              break
            }

            if (!retryable || attempt === maxAttempts - 1) {
              lastError = e as Error
              break
            }
            let delay: number
            const retryAfterHeader =
              (err as unknown as { retryAfter?: string }).retryAfter ??
              err.headers?.get?.('retry-after') ??
              null
            const parsed = parseRetryAfter(retryAfterHeader)
            if (parsed !== null) delay = parsed
            else delay = backoffWithJitter(attempt, baseMs, maxMs)

            await new Promise<void>((resolve, reject) => {
              timer = setTimeout(resolve, delay)
              if (opts.signal) {
                const onAbort = () => {
                  if (timer) clearTimeout(timer)
                  reject(
                    new SubgatewayError({
                      message: 'Aborted',
                      code: 'ABORTED',
                      provider: cand.providerKey,
                      lane: this.lane,
                      status: 499,
                    }),
                  )
                }
                if (opts.signal!.aborted) {
                  if (timer) clearTimeout(timer)
                  reject(
                    new SubgatewayError({
                      message: 'Aborted',
                      code: 'ABORTED',
                      provider: cand.providerKey,
                      lane: this.lane,
                      status: 499,
                    }),
                  )
                  return
                }
                opts.signal!.addEventListener('abort', onAbort, { once: true })
              }
            })
              .catch((abortErr) => {
                throw abortErr
              })
              .finally(() => {
                if (timer) clearTimeout(timer)
              })
          } finally {
            if (timer) clearTimeout(timer)
          }
        }
        if (
          lastError instanceof ProviderError &&
          (lastError.code === 'RATE_LIMITED' || lastError.code === 'UNAUTHORIZED') &&
          ki + 1 < keysToTry.length
        ) {
          continue
        }
        if (lastError) break
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
    return {
      lane: this.lane,
      circuit: this.circuitState,
      failureCount: this.failureCount,
      stats: this.stats(),
    }
  }

  /** For testing: force circuit open */
  _forceOpen(): void {
    this.circuitState = 'open'
    this.lastFailureAt = Date.now()
    this.failureCount = this.failureThreshold
  }

  _resetCircuit(): void {
    this.circuitState = 'closed'
    this.failureCount = 0
    this.lastFailureAt = 0
  }
}
