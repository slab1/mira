/**
 * Provider System — Entry
 *
 * createProviderRegistry + createGatewayFromRegistry
 * Keeps Gateway interface backward compatible
 */

import type { MiraConfig } from '../types/index.js'
import { ProviderRegistry } from './registry.js'
import type { ProviderConfig } from './types.js'
import { createGateway as createGatewayImpl } from '../gateway/index.js'
import type { Gateway } from '../gateway/index.js'

export * from './types.js'
export * from './auth.js'
export * from './pricing.js'
export * from './registry.js'
export * from './circuit-breaker.js'
export * from './rate-limiter.js'
export * from './cache.js'
export * from './health.js'

export function createProviderRegistry(config: MiraConfig): ProviderRegistry {
  const providerMap: Record<string, ProviderConfig> = {}
  for (const [k, v] of Object.entries(config.provider ?? {})) {
    providerMap[k] = {
      npm: v.npm,
      name: v.name,
      options: {
        baseURL: v.options.baseURL,
        apiKey: v.options.apiKey as string | string[],
        headers: (v.options as { headers?: Record<string, string> }).headers,
        timeout: (v.options as { timeout?: number }).timeout,
        kind: (v.options as { kind?: string }).kind,
      },
      models: v.models ?? {},
    }
  }
  const routing = (
    config as MiraConfig & {
      routing?: { aliases?: Record<string, string>; fallbacks?: string[]; defaultProvider?: string }
    }
  ).routing
  return new ProviderRegistry(providerMap, {
    aliases: routing?.aliases,
    fallbacks: routing?.fallbacks,
    defaultProvider: routing?.defaultProvider,
  })
}

export function createGatewayFromRegistry(registry: ProviderRegistry, config: MiraConfig): Gateway {
  // Delegate to gateway impl that now uses registry internally
  // For backward compat, we pass config but gateway will use registry if available
  return createGatewayImpl(config, registry)
}

// Re-export createGateway for backward compat
export { createGateway } from '../gateway/index.js'
