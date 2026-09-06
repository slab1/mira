/**
 * Gateway — Model listing with cache
 *
 * OpenRouter + provider-native, TTL 5min.
 */

import { ProviderError } from './errors.js'

export interface ModelInfo {
  id: string
  name: string
  context: number
}

interface CacheEntry {
  models: ModelInfo[]
  expiresAt: number
}

const TTL_MS = 5 * 60 * 1000
const cache = new Map<string, CacheEntry>()

export function clearModelsCache() {
  cache.clear()
}

export async function listModels(opts: {
  baseURL: string
  apiKey: string
  headers: Record<string, string>
  providerKey: string
  modelID?: string
}): Promise<ModelInfo[]> {
  const cacheKey = `${opts.providerKey}:${opts.baseURL}`
  const cached = cache.get(cacheKey)
  if (cached && Date.now() < cached.expiresAt) return cached.models

  // Try OpenRouter /models first if provider is openrouter
  if (opts.providerKey === 'openrouter') {
    try {
      const res = await fetch(`${opts.baseURL.replace(/\/$/, '')}/models`, {
        headers: { Authorization: `Bearer ${opts.apiKey}`, ...opts.headers },
        signal: AbortSignal.timeout(15_000),
      })
      if (res.ok) {
        const data = (await res.json()) as {
          data?: Array<{ id?: string; name?: string; context_length?: number }>
        }
        const models = (data.data ?? []).slice(0, 100).map((m) => ({
          id: `openrouter/${m.id}`,
          name: m.name ?? m.id ?? '',
          context: m.context_length ?? 128_000,
        }))
        cache.set(cacheKey, { models, expiresAt: Date.now() + TTL_MS })
        return models
      }
    } catch {}
  }

  // Provider-native fallback: try /models on the provider's baseURL
  try {
    const res = await fetch(`${opts.baseURL.replace(/\/$/, '')}/models`, {
      headers: { Authorization: `Bearer ${opts.apiKey}`, ...opts.headers },
      signal: AbortSignal.timeout(15_000),
    })
    if (res.ok) {
      const data = (await res.json()) as {
        data?: Array<{
          id?: string
          name?: string
          context_length?: number
          contextLength?: number
        }>
      }
      const models = (data.data ?? []).slice(0, 100).map((m) => ({
        id: `${opts.providerKey}/${m.id}`,
        name: m.name ?? m.id ?? '',
        context: (m.context_length ??
          (m as { contextLength?: number }).contextLength ??
          128_000) as number,
      }))
      if (models.length) {
        cache.set(cacheKey, { models, expiresAt: Date.now() + TTL_MS })
        return models
      }
    }
  } catch {}

  // If cache had stale data, return it even if expired
  if (cached) return cached.models

  throw new ProviderError({
    message: `Failed to list models for provider "${opts.providerKey}"`,
    code: 'PROVIDER_ERROR',
    provider: opts.providerKey,
  })
}
