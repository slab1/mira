/**
 * Provider System — Registry
 *
 * Longest-prefix model resolution for "openrouter/anthropic/claude-sonnet-4"
 * Alias expansion, fallback chains
 */

import {
  ProviderError,
  type ProviderKind,
  type ProviderConfig,
  type ResolvedProvider,
} from './types.js'
import { expandEnv, expandEnvArray, expandHeaders, KeyRing } from './auth.js'

export interface RegistryOptions {
  aliases?: Record<string, string>
  fallbacks?: string[]
  defaultProvider?: string
}

export class ProviderRegistry {
  private providers = new Map<string, ProviderConfig>()
  private keyRings = new Map<string, KeyRing>()
  private aliases: Record<string, string>
  private fallbacks: string[]
  private defaultProvider: string

  constructor(providerMap: Record<string, ProviderConfig>, opts?: RegistryOptions) {
    for (const [k, v] of Object.entries(providerMap)) {
      this.providers.set(k, v)
      this.keyRings.set(k, new KeyRing(v.options.apiKey as string | string[]))
    }
    this.aliases = opts?.aliases ?? {}
    this.fallbacks = opts?.fallbacks ?? []
    this.defaultProvider = opts?.defaultProvider ?? 'openrouter'
  }

  /** Expand alias: "sonnet" → "openrouter/anthropic/claude-sonnet-4" */
  expandAlias(model: string): string {
    if (this.aliases[model]) return this.aliases[model]
    return model
  }

  /** Longest-prefix resolution: "openrouter/anthropic/claude-sonnet-4" → provider openrouter, model "anthropic/claude-sonnet-4" */
  resolve(modelStr: string): ResolvedProvider {
    const expanded = this.expandAlias(modelStr)

    // Sort provider keys by length descending for longest-prefix match
    const sortedKeys = [...this.providers.keys()].sort((a, b) => b.length - a.length)

    let providerKey: string | null = null
    let modelID = expanded

    for (const key of sortedKeys) {
      if (expanded === key) {
        // Exact match: provider name alone — use default model? treat as provider with empty model
        providerKey = key
        modelID = expanded
        break
      }
      if (expanded.startsWith(key + '/')) {
        providerKey = key
        modelID = expanded.slice(key.length + 1)
        break
      }
    }

    // No prefix matched → use default provider
    if (!providerKey) {
      providerKey = this.defaultProvider
      // If default provider doesn't exist, try openrouter, then first available
      if (!this.providers.has(providerKey)) {
        if (this.providers.has('openrouter')) providerKey = 'openrouter'
        else providerKey = sortedKeys[0] ?? 'openrouter'
      }
      modelID = expanded
    }

    const cfg = this.providers.get(providerKey)
    if (!cfg) {
      throw new ProviderError({
        message: `Provider "${providerKey}" not found for model "${modelStr}"`,
        code: 'PROVIDER_NOT_FOUND',
        provider: providerKey,
      })
    }

    const baseURL = expandEnv(cfg.options.baseURL)
    const headers = expandHeaders(cfg.options.headers)
    const timeout = cfg.options.timeout ?? 120_000
    const kind = (cfg.options.kind ?? providerKey) as ProviderKind
    const ring = this.keyRings.get(providerKey)
    const apiKey = ring?.current ?? expandEnvArray(cfg.options.apiKey as string | string[])[0] ?? ''

    if (!apiKey) {
      throw new ProviderError({
        message: `No API key configured for provider "${providerKey}" (model "${modelStr}")`,
        code: 'NO_API_KEY',
        provider: providerKey,
      })
    }

    return {
      providerKey,
      kind,
      baseURL,
      apiKey,
      headers,
      timeout,
      modelID,
    }
  }

  /** Resolve with fallbacks: primary + routing fallbacks */
  resolveWithFallbacks(modelStr: string): ResolvedProvider[] {
    const results: ResolvedProvider[] = []
    const seen = new Set<string>()

    const tryAdd = (m: string) => {
      try {
        const r = this.resolve(m)
        const key = `${r.providerKey}:${r.modelID}`
        if (!seen.has(key)) {
          seen.add(key)
          results.push(r)
        }
      } catch (e) {
        // If NO_API_KEY, still propagate? For fallback chain, skip missing keys
        if (e instanceof ProviderError && e.code === 'NO_API_KEY') {
          // Don't add, but don't throw — fallback may have key
          return
        }
        throw e
      }
    }

    tryAdd(modelStr)
    for (const fb of this.fallbacks) {
      tryAdd(fb)
    }

    if (results.length === 0) {
      // All providers missing keys — throw for primary
      return [this.resolve(modelStr)]
    }

    return results
  }

  /** Get provider config by key */
  getProvider(key: string): ProviderConfig | undefined {
    return this.providers.get(key)
  }

  /** List all provider keys */
  keys(): string[] {
    return [...this.providers.keys()]
  }

  /** Check if provider has valid key */
  hasKey(providerKey: string): boolean {
    const ring = this.keyRings.get(providerKey)
    if (ring) return ring.hasKey
    const cfg = this.providers.get(providerKey)
    if (!cfg) return false
    return expandEnvArray(cfg.options.apiKey as string | string[]).some(Boolean)
  }

  /** Rotate key for provider on 429/401, return new key or null */
  rotateKey(providerKey: string): string | null {
    const ring = this.keyRings.get(providerKey)
    if (!ring) return null
    return ring.rotate()
  }

  /** Get current key for provider */
  getKey(providerKey: string): string {
    const ring = this.keyRings.get(providerKey)
    if (ring) return ring.current
    const cfg = this.providers.get(providerKey)
    if (!cfg) return ''
    return expandEnvArray(cfg.options.apiKey as string | string[])[0] ?? ''
  }

  /** Get all keys for provider */
  getAllKeys(providerKey: string): string[] {
    const ring = this.keyRings.get(providerKey)
    if (ring) return ring.all
    const cfg = this.providers.get(providerKey)
    if (!cfg) return []
    return expandEnvArray(cfg.options.apiKey as string | string[])
  }

  /** Update provider config (for runtime changes) */
  setProvider(key: string, cfg: ProviderConfig): void {
    this.providers.set(key, cfg)
    this.keyRings.set(key, new KeyRing(cfg.options.apiKey as string | string[]))
  }

  /** Get headers for provider (expanded) */
  getHeaders(providerKey: string): Record<string, string> {
    const cfg = this.providers.get(providerKey)
    if (!cfg) return {}
    return expandHeaders(cfg.options.headers)
  }

  /** Get baseURL for provider (expanded) */
  getBaseURL(providerKey: string): string {
    const cfg = this.providers.get(providerKey)
    if (!cfg) return ''
    return expandEnv(cfg.options.baseURL)
  }
}
