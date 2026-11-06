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

  const key = opts.providerKey.toLowerCase()
  const base = (opts.baseURL || 'https://api.openai.com/v1').replace(/\/$/, '')

  // 1. Anthropic: test or return known models if 200/models
  if (key === 'anthropic' || base.includes('anthropic.com')) {
    try {
      const res = await fetch(`${base}/v1/models`, {
        headers: {
          'x-api-key': opts.apiKey,
          'anthropic-version': '2023-06-01',
          ...opts.headers,
        },
        signal: AbortSignal.timeout(10_000),
      })
      if (res.ok) {
        const data = (await res.json()) as { data?: Array<{ id?: string; display_name?: string }> }
        const models = (data.data ?? []).map((m) => ({
          id: `anthropic/${m.id}`,
          name: m.display_name ?? m.id ?? '',
          context: 200_000,
        }))
        if (models.length) {
          cache.set(cacheKey, { models, expiresAt: Date.now() + TTL_MS })
          return models
        }
      } else if (res.status === 401 || res.status === 403) {
        throw new ProviderError({
          message: `Invalid API key for Anthropic (HTTP ${res.status})`,
          code: 'UNAUTHORIZED',
          provider: opts.providerKey,
        })
      }
    } catch (e) {
      if (e instanceof ProviderError) throw e
    }
    // Static fallback for Anthropic if models endpoint fails
    const staticModels = [
      { id: 'anthropic/claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', context: 200_000 },
      { id: 'anthropic/claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', context: 200_000 },
      { id: 'anthropic/claude-3-opus-20240229', name: 'Claude 3 Opus', context: 200_000 },
    ]
    cache.set(cacheKey, { models: staticModels, expiresAt: Date.now() + TTL_MS })
    return staticModels
  }

  // 2. Google Gemini: test or return models via v1beta/models?key=
  if (key === 'google' || base.includes('googleapis.com')) {
    try {
      const url = `${base.includes('v1beta') ? base : `${base}/v1beta`}/models?key=${opts.apiKey}`
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
      if (res.ok) {
        const data = (await res.json()) as { models?: Array<{ name?: string; displayName?: string; inputTokenLimit?: number }> }
        const models = (data.models ?? [])
          .filter((m) => m.name?.includes('gemini'))
          .map((m) => {
            const rawId = m.name?.replace(/^models\//, '') ?? ''
            return {
              id: `google/${rawId}`,
              name: m.displayName ?? rawId,
              context: m.inputTokenLimit ?? 1_000_000,
            }
          })
        if (models.length) {
          cache.set(cacheKey, { models, expiresAt: Date.now() + TTL_MS })
          return models
        }
      } else if (res.status === 400 || res.status === 401 || res.status === 403) {
        throw new ProviderError({
          message: `Invalid API key for Google Gemini (HTTP ${res.status})`,
          code: 'UNAUTHORIZED',
          provider: opts.providerKey,
        })
      }
    } catch (e) {
      if (e instanceof ProviderError) throw e
    }
  }

  // 3. OpenRouter & Standard OpenAI-Compatible Endpoints (/v1/models or /models)
  const endpoints = [`${base}/models`, base.endsWith('/v1') ? `${base.slice(0, -3)}/v1/models` : `${base}/v1/models`]
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${opts.apiKey}`, ...opts.headers },
        signal: AbortSignal.timeout(10_000),
      })
      if (res.ok) {
        const data = (await res.json()) as {
          data?: Array<{ id?: string; name?: string; context_length?: number; contextLength?: number }>
        }
        const rawList = data.data ?? (Array.isArray(data) ? data : [])
        const models = (rawList as Array<{ id?: string; name?: string; context_length?: number; contextLength?: number }>)
          .slice(0, 100)
          .map((m) => ({
            id: key === 'openrouter' ? `openrouter/${m.id}` : `${opts.providerKey}/${m.id ?? ''}`,
            name: m.name ?? m.id ?? '',
            context: (m.context_length ?? m.contextLength ?? 128_000) as number,
          }))
          .filter((m) => m.id && m.id !== `${opts.providerKey}/`)
        if (models.length) {
          cache.set(cacheKey, { models, expiresAt: Date.now() + TTL_MS })
          return models
        }
      } else if (res.status === 401 || res.status === 403) {
        throw new ProviderError({
          message: `Unauthorized for provider "${opts.providerKey}" (HTTP ${res.status}): Invalid API key`,
          code: 'UNAUTHORIZED',
          provider: opts.providerKey,
        })
      }
    } catch (e) {
      if (e instanceof ProviderError) throw e
    }
  }

  // If cache had stale data, return it
  if (cached) return cached.models

  throw new ProviderError({
    message: `Failed to list models for provider "${opts.providerKey}" — check API key and baseURL`,
    code: 'PROVIDER_ERROR',
    provider: opts.providerKey,
  })
}
