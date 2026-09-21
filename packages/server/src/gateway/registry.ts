/**
 * Gateway — SubgatewayRegistry
 *
 * Manages isolated Subgateway instances per lane.
 * syncFromConfig, get, list, statsAll, health
 */

import type { MiraConfig } from '../types/index.js'
import { Subgateway, type SubgatewayConfig } from './subgateway.js'
import { ProviderRegistry } from '../providers/registry.js'
import { buildRegistry } from './provider.js'
import type { GatewayStats } from './types.js'

export class SubgatewayRegistry {
  private gateways = new Map<string, Subgateway>()
  private globalConfig: MiraConfig
  private baseRegistry: ProviderRegistry

  constructor(config: MiraConfig, existingRegistry?: ProviderRegistry) {
    this.globalConfig = config
    this.baseRegistry = existingRegistry ?? buildRegistry(config)
    this.syncFromConfig(config)
  }

  syncFromConfig(config: MiraConfig): void {
    this.globalConfig = config
    this.baseRegistry = buildRegistry(config)
    const subgateways =
      (config as MiraConfig & { subgateways?: Record<string, SubgatewayConfig> }).subgateways ?? {}

    // Ensure default lane exists
    const lanes = new Set<string>(['default', ...Object.keys(subgateways)])
    // Also ensure well-known lanes exist even if not in config (cheap, vision, local, compaction)
    for (const wellKnown of ['cheap', 'vision', 'local', 'compaction']) {
      lanes.add(wellKnown)
    }
    // Agent lanes: agent:ask etc. — add if agents exist
    const agents = (config as MiraConfig & { agents?: Record<string, unknown> }).agents ?? {}
    for (const agentName of Object.keys(agents)) {
      lanes.add(`agent:${agentName}`)
    }
    // Always add agent:ask if not present
    lanes.add('agent:ask')

    for (const lane of lanes) {
      const laneConfig: SubgatewayConfig = subgateways[lane] ?? this.defaultLaneConfig(lane, config)
      const existing = this.gateways.get(lane)
      if (existing) {
        existing.syncConfig(laneConfig, config)
      } else {
        const gw = new Subgateway({
          lane,
          config: laneConfig,
          globalConfig: config,
          registry: this.baseRegistry,
        })
        this.gateways.set(lane, gw)
      }
    }

    // Remove lanes that are no longer needed? Keep default/cheap/vision/local/compaction always
    // For custom lanes that were removed from config, keep them but they will use default config
  }

  private defaultLaneConfig(lane: string, config: MiraConfig): SubgatewayConfig {
    const subgateways =
      (config as MiraConfig & { subgateways?: Record<string, SubgatewayConfig> }).subgateways ?? {}
    if (subgateways[lane]) return subgateways[lane]

    // Lane-specific defaults — prefer env-backed providers (anthropic/nvidia) over opencode/openrouter free tier.
    // OpenRouter is kept as-model reference when user has OPENROUTER_API_KEY, but lanes themselves
    // default to anthropic so gateway works without any free-tier key.
    switch (lane) {
      case 'default':
        return {
          provider: 'anthropic',
          model: config.model,
          fallback:
            (config as MiraConfig & { routing?: { fallbacks?: string[] } }).routing?.fallbacks ??
            [],
          rateLimit: { rps: 10, burst: 20 },
          retry: { maxAttempts: 3, baseMs: 500, maxMs: 10_000 },
          timeout: 120_000,
          circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 30_000 },
        }
      case 'cheap':
        return {
          provider: 'anthropic',
          model: config.smallModel ?? 'claude-3.5-sonnet',
          fallback: [],
          rateLimit: { rps: 20, burst: 40 },
          retry: { maxAttempts: 3, baseMs: 300, maxMs: 5_000 },
          timeout: 60_000,
          circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 15_000 },
        }
      case 'compaction':
        return {
          provider: 'anthropic',
          model:
            config.smallModel ?? config.loop?.smallModel ?? 'claude-3.5-sonnet',
          fallback: [],
          rateLimit: { rps: 10, burst: 20 },
          retry: { maxAttempts: 2, baseMs: 300, maxMs: 5_000 },
          timeout: 45_000,
          circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 15_000 },
        }
      case 'vision':
        return {
          provider: 'openai',
          model: 'openai/gpt-4o',
          fallback: [],
          rateLimit: { rps: 5, burst: 10 },
          retry: { maxAttempts: 3, baseMs: 500, maxMs: 10_000 },
          timeout: 120_000,
          circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 30_000 },
        }
      case 'local':
        return {
          provider: 'anthropic',
          model: config.model,
          fallback: [],
          rateLimit: { rps: 10, burst: 20 },
          retry: { maxAttempts: 2, baseMs: 500, maxMs: 5_000 },
          timeout: 30_000,
          circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 10_000 },
        }
      default:
        if (lane.startsWith('agent:')) {
          const agentName = lane.slice(6)
          // ask is cheap, others default — both prefer anthropic over opencode free tier
          if (agentName === 'ask') {
            return {
              provider: 'anthropic',
              model: 'claude-3.5-sonnet',
              fallback: [],
              rateLimit: { rps: 20, burst: 40 },
              retry: { maxAttempts: 3 },
              timeout: 60_000,
              circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 15_000 },
            }
          }
          // Try to get agent model from config
          const agentDef = (config as MiraConfig & { agents?: Record<string, { model?: string }> })
            .agents?.[agentName]
          if (agentDef?.model) {
            return {
              provider: agentDef.model.split('/')[0] ?? 'anthropic',
              model: agentDef.model,
              fallback: [],
              rateLimit: { rps: 10, burst: 20 },
              retry: { maxAttempts: 3 },
              timeout: 120_000,
            }
          }
          return {
            provider: 'anthropic',
            model: config.model,
            fallback: [],
            rateLimit: { rps: 10, burst: 20 },
            retry: { maxAttempts: 3 },
            timeout: 120_000,
          }
        }
        return {
          provider: 'anthropic',
          model: config.model,
          fallback: [],
          rateLimit: { rps: 10, burst: 20 },
          retry: { maxAttempts: 3 },
          timeout: 120_000,
        }
    }
  }

  get(lane: string): Subgateway | undefined {
    return this.gateways.get(lane) ?? this.gateways.get('default')
  }

  /** Get or throw if not found (fallback to default) */
  getOrDefault(lane: string): Subgateway {
    return this.gateways.get(lane) ?? this.gateways.get('default')!
  }

  list(): Subgateway[] {
    return [...this.gateways.values()]
  }

  lanes(): string[] {
    return [...this.gateways.keys()]
  }

  statsAll(): Record<string, GatewayStats> {
    const out: Record<string, GatewayStats> = {}
    for (const [lane, gw] of this.gateways) {
      out[lane] = gw.stats()
    }
    return out
  }

  health(): Record<
    string,
    ReturnType<Subgateway['health']>
  > {
    const out: Record<string, ReturnType<Subgateway['health']>> = {}
    for (const [lane, gw] of this.gateways) {
      out[lane] = gw.health()
    }
    return out
  }

  /** Provider health — circuit-breaker + rate-limiter per provider (from ProviderRegistry) */
  providersHealth(): Record<string, import('../providers/types.js').ProviderHealth> {
    const map = this.baseRegistry.getAllHealth()
    const out: Record<string, import('../providers/types.js').ProviderHealth> = {}
    for (const [k, v] of map) out[k] = v
    return out
  }

  /** Lane stats aggregated (for /dev/health + /gateway/health) */
  laneStats(): Record<string, GatewayStats> {
    return this.statsAll()
  }

  /** Full health snapshot: lanes + providers — for GET /gateway/health and GET /provider/health */
  healthSnapshot(): {
    lanes: Record<string, ReturnType<Subgateway['health']>>
    providers: Record<string, import('../providers/types.js').ProviderHealth>
    stats: Record<string, GatewayStats>
    costCap?: { perTask?: number; perSession?: number }
  } {
    const lanes = this.health()
    const providers = this.providersHealth()
    const stats = this.statsAll()
    const cap = (this.globalConfig as MiraConfig & { costCap?: { perTask?: number; perSession?: number } })
      .costCap
    return { lanes, providers, stats, costCap: cap }
  }

  /** For testing: clear all */
  clear(): void {
    this.gateways.clear()
  }
}
