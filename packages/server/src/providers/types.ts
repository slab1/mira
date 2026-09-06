/**
 * Provider System — Types
 *
 * Real provider abstraction replacing gateway stubs.
 * Supports 6 providers: openrouter, anthropic, openai, google, deepseek, nvidia
 */

import { ProviderError } from '../gateway/errors.js'
export { ProviderError }

export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

export type ProviderKind =
  | 'openrouter'
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'deepseek'
  | 'nvidia'
  | (string & {})

export type Capability = 'coding' | 'reasoning' | 'vision' | 'speed' | 'cost_optimized'

export interface CachedResponse {
  text: string
  inputTokens: number
  outputTokens: number
  costUSD: number
  timestamp: number
  model: string
}

export interface ProviderHealth {
  providerKey: string
  /** Circuit breaker state */
  state: CircuitBreakerState
  /** Health check status */
  status: 'healthy' | 'degraded' | 'down'
  /** Latency of last health check in ms */
  latencyMs: number
  /** Timestamp of last health check */
  lastCheck: number | null
  /** Total failure count */
  failureCount: number
  /** Total success count */
  successCount: number
  /** Timestamp of last failure */
  lastFailureTime: number | null
  /** Timestamp of last success */
  lastSuccessTime: number | null
  /** Consecutive failures (for circuit breaker) */
  consecutiveFailures: number
  /** When circuit breaker cooldown expires */
  cooldownUntil: number | null
  /** Last error message if any */
  lastError?: string
}

export interface CacheStats {
  hits: number
  misses: number
  size: number
}

export interface RouteResult {
  provider: string
  model: string
  capability: Capability
  costUSD: number
  latencyMs: number
}

export interface ProviderOptions {
  baseURL: string
  apiKey: string | string[]
  headers?: Record<string, string>
  timeout?: number
  kind?: ProviderKind
}

export interface ProviderConfig {
  npm?: string
  name: string
  options: ProviderOptions
  models: Record<string, { name: string; limit: { context: number; output: number } }>
}

export interface ResolvedProvider {
  providerKey: string
  kind: ProviderKind
  baseURL: string
  apiKey: string
  headers: Record<string, string>
  timeout: number
  modelID: string
}

export interface Provider {
  key: string
  kind: ProviderKind
  name: string
  baseURL: string
  headers: Record<string, string>
  timeout: number
  models: Record<string, { name: string; limit: { context: number; output: number } }>
  /** Get current API key (after env expansion, before rotation) */
  getApiKey(): string
  /** Get all expanded keys for rotation */
  getAllKeys(): string[]
  /** Rotate to next key, return new key or null if exhausted */
  rotateKey(): string | null
  /** Current key index */
  currentKeyIndex: number
  /** Resolve headers with env expansion */
  getHeaders(): Record<string, string>
  /** Check if provider has a valid key */
  hasKey(): boolean
}
