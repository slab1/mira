/**
 * Provider System — Circuit Breaker
 *
 * Per-provider isolated circuit breaker with CLOSED → OPEN → HALF_OPEN states.
 * Prevents cascading failures when a provider is unhealthy.
 */

import type { CircuitBreakerState } from './types.js'

export interface CircuitBreakerConfig {
  failureThreshold: number
  resetTimeoutMs: number
  halfOpenMaxCalls: number
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  halfOpenMaxCalls: 3,
}

export class CircuitBreaker {
  private _state: CircuitBreakerState = 'CLOSED'
  private failureCount = 0
  private successCount = 0
  private lastFailureTime: number | null = null
  private halfOpenCalls = 0
  private readonly config: CircuitBreakerConfig

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /** Record a successful call — moves CLOSED stays CLOSED, HALF_OPEN → CLOSED */
  recordSuccess(): void {
    if (this._state === 'HALF_OPEN') {
      this.successCount++
      this.halfOpenCalls++
      if (this.successCount >= this.config.halfOpenMaxCalls) {
        this._state = 'CLOSED'
        this.failureCount = 0
        this.successCount = 0
        this.halfOpenCalls = 0
      }
    } else if (this._state === 'CLOSED') {
      this.failureCount = 0
    }
  }

  /** Record a failed call — CLOSED → OPEN if threshold reached, HALF_OPEN → OPEN */
  recordFailure(): void {
    this.lastFailureTime = Date.now()

    if (this._state === 'HALF_OPEN') {
      this._state = 'OPEN'
      this.halfOpenCalls = 0
      this.successCount = 0
      return
    }

    if (this._state === 'CLOSED') {
      this.failureCount++
      if (this.failureCount >= this.config.failureThreshold) {
        this._state = 'OPEN'
      }
    }
  }

  /** Current circuit breaker state */
  getState(): CircuitBreakerState {
    if (this._state === 'OPEN') {
      const elapsed = Date.now() - (this.lastFailureTime ?? 0)
      if (elapsed >= this.config.resetTimeoutMs) {
        this._state = 'HALF_OPEN'
        this.halfOpenCalls = 0
        this.successCount = 0
      }
    }
    return this._state
  }

  /** Whether a new call is allowed through the circuit */
  canAttempt(): boolean {
    const currentState = this.getState()
    if (currentState === 'CLOSED') return true
    if (currentState === 'HALF_OPEN') return this.halfOpenCalls < this.config.halfOpenMaxCalls
    return false // OPEN
  }

  /** Get the number of consecutive failures */
  getFailureCount(): number {
    return this.failureCount
  }

  /** Get the number of successes in HALF_OPEN */
  getSuccessCount(): number {
    return this.successCount
  }

  /** Get milliseconds until next allowed attempt when OPEN */
  getTimeUntilReset(): number {
    if (this._state === 'CLOSED') return 0
    const elapsed = Date.now() - (this.lastFailureTime ?? 0)
    return Math.max(0, this.config.resetTimeoutMs - elapsed)
  }
}

/** Per-provider circuit breaker registry */
const breakerRegistry = new Map<string, CircuitBreaker>()

/**
 * Factory: get or create a CircuitBreaker for a given provider key.
 * Each provider key gets its own isolated instance.
 */
export function createCircuitBreaker(providerKey: string, config?: Partial<CircuitBreakerConfig>): CircuitBreaker {
  if (!breakerRegistry.has(providerKey)) {
    breakerRegistry.set(providerKey, new CircuitBreaker(config))
  }
  return breakerRegistry.get(providerKey)!
}

/** Clear all breakers (useful for testing) */
export function clearBreakerRegistry(): void {
  breakerRegistry.clear()
}
