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

    // Lane-specific defaults
    switch (lane) {
      case 'default':
        return {
          provider: 'openrouter',
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
          provider: 'openrouter',
          model: config.smallModel ?? 'openrouter/deepseek/deepseek-v3.2-exp',
          fallback: [],
          rateLimit: { rps: 20, burst: 40 },
          retry: { maxAttempts: 3, baseMs: 300, maxMs: 5_000 },
          timeout: 60_000,
          circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 15_000 },
        }
      case 'compaction':
        return {
          provider: 'openrouter',
          model:
            config.smallModel ?? config.loop?.smallModel ?? 'openrouter/deepseek/deepseek-v3.2-exp',
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
          provider: 'openrouter',
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
          // ask is cheap, others default
          if (agentName === 'ask') {
            return {
              provider: 'openrouter',
              model: 'openrouter/deepseek/deepseek-v3.2-exp',
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
              provider: agentDef.model.split('/')[0] ?? 'openrouter',
              model: agentDef.model,
              fallback: [],
              rateLimit: { rps: 10, burst: 20 },
              retry: { maxAttempts: 3 },
              timeout: 120_000,
            }
          }
          return {
            provider: 'openrouter',
            model: config.model,
            fallback: [],
            rateLimit: { rps: 10, burst: 20 },
            retry: { maxAttempts: 3 },
            timeout: 120_000,
          }
        }
        return {
          provider: 'openrouter',
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
    { lane: string; circuit: string; failureCount: number; stats: GatewayStats }
  > {
    const out: Record<
      string,
      { lane: string; circuit: string; failureCount: number; stats: GatewayStats }
    > = {}
    for (const [lane, gw] of this.gateways) {
      out[lane] = gw.health()
    }
    return out
  }

  /** For testing: clear all */
  clear(): void {
    this.gateways.clear()
  }
}
