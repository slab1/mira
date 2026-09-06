/**
 * Gateway — Provider helpers
 *
 * Env expansion + model resolution via ProviderRegistry.
 */

import type { MiraConfig } from '../types/index.js'
import type { ProviderConfig } from '../providers/types.js'
import { ProviderRegistry } from '../providers/registry.js'

export function expandEnv(value: string): string {
  if (!value) return value
  return value.replace(/\{env:([^}]+)\}/g, (_, name: string) => process.env[name] ?? '')
}

export function expandEnvArray(value: string | string[] | undefined): string[] {
  if (!value) return []
  if (Array.isArray(value)) {
    const out: string[] = []
    for (const v of value) {
      const expanded = expandEnv(v)
      if (expanded.includes(',') && /^\{env:[^}]+\}$/.test(v.trim())) {
        for (const part of expanded.split(',')) {
          const t = part.trim()
          if (t) out.push(t)
        }
      } else if (expanded) {
        out.push(expanded)
      }
    }
    return out
  }
  const expanded = expandEnv(value)
  if (!expanded) return []
  if (expanded.includes(',') && /^\{env:[^}]+\}$/.test(value.trim())) {
    return expanded
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return [expanded]
}

export function expandHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) out[k] = expandEnv(v)
  return out
}

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
