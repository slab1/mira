/**
 * Provider System — Health Checker
 *
 * Proactive health monitoring for providers.
 * Delegates circuit breaker state to ProviderRegistry (single source of truth).
 */

import type { ProviderRegistry } from './registry.js'
import type { ProviderHealth } from './types.js'

export interface ProviderHealthCheckerConfig {
  intervalMs?: number
  degradedThresholdMs?: number
  failureThreshold?: number
}

const DEFAULT_CONFIG: Required<ProviderHealthCheckerConfig> = {
  intervalMs: 30_000,
  degradedThresholdMs: 5_000,
  failureThreshold: 2,
}

export class ProviderHealthChecker {
  private registry: ProviderRegistry
  private intervalMs: number
  private degradedThresholdMs: number
  private failureThreshold: number
  private intervalId: ReturnType<typeof setInterval> | null = null

  constructor(registry: ProviderRegistry, config?: ProviderHealthCheckerConfig) {
    this.registry = registry
    const cfg = { ...DEFAULT_CONFIG, ...config }
    this.intervalMs = cfg.intervalMs
    this.degradedThresholdMs = cfg.degradedThresholdMs
    this.failureThreshold = cfg.failureThreshold
  }

  /** Begin periodic health checks across all registered providers */
  start(): void {
    if (this.intervalId !== null) return
    this.runChecks()
    this.intervalId = setInterval(() => this.runChecks(), this.intervalMs)
  }

  /** Stop periodic health checks */
  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
  }

  /**
   * Perform a health check on a single provider.
   * Uses the registry's circuit breaker as single source of truth.
   * Latency > degradedThresholdMs → degraded. Consecutive failures >= threshold → down.
   */
  async check(providerKey: string): Promise<ProviderHealth> {
    const startTime = Date.now()

    // Check if circuit breaker allows the call
    if (!this.registry.isHealthy(providerKey)) {
      const health = this.registry.getHealth(providerKey)
      return {
        ...health,
        latencyMs: Date.now() - startTime,
        lastCheck: Date.now(),
        lastError: 'Circuit breaker is OPEN',
      }
    }

    try {
      // Verify provider exists and has a valid key (lightweight check)
      const cfg = this.registry.getProvider(providerKey)
      if (!cfg) {
        throw new Error(`Provider "${providerKey}" not found in registry`)
      }
      if (!this.registry.hasKey(providerKey)) {
        throw new Error(`No API key configured for provider "${providerKey}"`)
      }

      const latency = Date.now() - startTime

      if (latency > this.degradedThresholdMs) {
        this.registry.recordFailure(providerKey)
        const health = this.registry.getHealth(providerKey)
        return {
          ...health,
          latencyMs: latency,
          lastCheck: Date.now(),
          lastError: `Latency ${latency}ms exceeds ${this.degradedThresholdMs}ms threshold`,
        }
      }

      // Healthy — record success
      this.registry.recordSuccess(providerKey)
      const health = this.registry.getHealth(providerKey)
      return {
        ...health,
        latencyMs: latency,
        lastCheck: Date.now(),
      }
    } catch (err) {
      const latency = Date.now() - startTime
      const errorMessage = err instanceof Error ? err.message : String(err)
      this.registry.recordFailure(providerKey)
      const health = this.registry.getHealth(providerKey)
      const status: 'healthy' | 'degraded' | 'down' =
        health.consecutiveFailures >= this.failureThreshold ? 'down' : 'degraded'
      return {
        ...health,
        status,
        latencyMs: latency,
        lastCheck: Date.now(),
        lastError: errorMessage,
      }
    }
  }

  /** Return health snapshot for all providers (delegates to registry) */
  getHealth(): Map<string, ProviderHealth> {
    return this.registry.getAllHealth()
  }

  /** Run health checks for all registered providers */
  private async runChecks(): Promise<void> {
    const keys = this.registry.keys()
    const checks = keys.map((key) => this.check(key))
    await Promise.allSettled(checks)
  }
}

/** Factory function to create a ProviderHealthChecker */
export function createHealthChecker(registry: ProviderRegistry): ProviderHealthChecker {
  return new ProviderHealthChecker(registry)
}
