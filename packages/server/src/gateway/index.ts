/**
 * Mira Model Gateway — Vercel AI SDK v5 → OpenRouter → 25+ providers
 *
 * Real provider system: no stubs, ProviderError with remediation, key rotation,
 * longest-prefix resolution, {env:VAR} expansion.
 *
 * Oracle Subgateway design: main gateway is facade + router over isolated
 * Subgateway instances per lane (default, cheap, vision, local, compaction, agent:ask, etc.)
 * Each lane owns provider/model/fallback/rateLimit/costCap/retry/timeout/stats/circuitBreaker.
 *
 * Split into modules per oracle design:
 * - types.ts, errors.ts, provider.ts, sse.ts, stream.ts, retry.ts, pricing.ts, summarize.ts, models.ts
 * - subgateway.ts, registry.ts, router.ts, rate-limiter.ts, stats.ts
 */

import type { MiraConfig } from '../types/index.js'
import { ProviderError } from './errors.js'
import { ProviderRegistry } from '../providers/registry.js'
import { buildRegistry } from './provider.js'
import { SubgatewayRegistry } from './registry.js'
import { GatewayRouter, createRoutingGateway } from './router.js'

// Re-export types for backward compat
export type {
  Gateway,
  GatewayChunk,
  GatewayMessage,
  GatewayContentPart,
  GatewayToolCall,
  ChunkUsage,
  StreamOptions,
  GatewayStats,
} from './types.js'
export { ProviderError } from './errors.js'
export { GatewayStatsStore } from './pricing.js'
export { createSSEParser, parseSSEText } from './sse.js'
export { backoffWithJitter, parseRetryAfter, withRetry, withFallbackChain } from './retry.js'
export { priceFor, PRICING_TABLE } from './pricing.js'
export {
  expandEnv,
  expandEnvArray,
  expandHeaders,
  buildRegistry,
  resolveModel,
} from './provider.js'
export { Subgateway, SubgatewayError } from './subgateway.js'
export { SubgatewayRegistry } from './registry.js'
export { GatewayRouter, createRoutingGateway } from './router.js'
export { TokenBucket } from './rate-limiter.js'
export { SubgatewayStatsCollector } from './stats.js'

import type { Gateway } from './types.js'

export function createGateway(
  config: MiraConfig,
  existingRegistry?: ProviderRegistry,
): Gateway & { registry: SubgatewayRegistry; router: GatewayRouter } {
  const registry = new SubgatewayRegistry(config, existingRegistry)
  const router = new GatewayRouter(registry, config)
  const gateway = createRoutingGateway(registry, router)

  // Attach sync helper for config hot-reload (used by server when config changes)
  ;(gateway as unknown as Record<string, unknown>).syncFromConfig = (newConfig: MiraConfig) => {
    registry.syncFromConfig(newConfig)
    router.syncConfig(newConfig)
  }

  return gateway as Gateway & { registry: SubgatewayRegistry; router: GatewayRouter }
}
