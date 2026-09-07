/**
 * Gateway — Provider helpers
 *
 * Env expansion + model resolution via ProviderRegistry.
 */

import type { MiraConfig } from '../types/index.js'
import type { ProviderConfig } from '../providers/types.js'
import { ProviderRegistry } from '../providers/registry.js'

// Re-export from providers/auth.ts — single source of truth for env expansion
export { expandEnv, expandEnvArray, expandHeaders } from '../providers/auth.js'

/**
 * Build a ProviderRegistry from MiraConfig.
 * Mirrors the logic previously in gateway/index.ts buildRegistry.
 */
export function buildRegistry(config: MiraConfig): ProviderRegistry {
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

/**
 * Resolve a model string to a provider candidate.
 * Thin wrapper over registry.resolve for gateway consumers.
 */
export function resolveModel(registry: ProviderRegistry, model: string) {
  return registry.resolve(model)
}

export function resolveWithFallbacks(registry: ProviderRegistry, model: string) {
  return registry.resolveWithFallbacks(model)
}
