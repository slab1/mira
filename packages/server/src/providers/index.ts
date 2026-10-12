/**
 * Provider System — Entry
 *
 * A barrel over the provider modules plus two convenience constructors.
 *
 * `createProviderRegistry` previously re-implemented the config→registry
 * mapping, and the copy had already drifted from the real builder in
 * `gateway/provider.ts`: it did not lowercase provider keys, did not merge
 * case-duplicate entries, and carried no rate limiter. That made it a trap —
 * two builders, subtly different results. It now DELEGATES to the canonical
 * `buildRegistry`, so there is exactly one mapping from config to registry.
 */

import type { MiraConfig } from '../types/index.js'
import type { ProviderRegistry } from './registry.js'
import { buildRegistry } from '../gateway/provider.js'
import { createGateway as createGatewayImpl } from '../gateway/index.js'
import type { Gateway } from '../gateway/index.js'

export * from './types.js'
export * from './auth.js'
export * from './pricing.js'
export * from './registry.js'
export * from './circuit-breaker.js'
export * from './rate-limiter.js'
export { SemanticCache, createSemanticCache } from './cache.js'
export type { CachedResponse as CacheResponse, CacheStats as CacheStatsFromCache } from './cache.js'
export * from './health.js'

/** Build a ProviderRegistry from config. Delegates to the canonical builder. */
export function createProviderRegistry(config: MiraConfig): ProviderRegistry {
  return buildRegistry(config)
}

/** Wrap an existing registry in a Gateway (backward-compatible entry point). */
export function createGatewayFromRegistry(registry: ProviderRegistry, config: MiraConfig): Gateway {
  return createGatewayImpl(config, registry)
}

// Re-export createGateway for backward compat
export { createGateway } from '../gateway/index.js'
