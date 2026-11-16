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

const NON_CHAT_MODEL_RE =
  /starcoder|embed|retriever|rerank|nvclip|nemoguard|safety[-_]?guard|content[-_]?safety|video[-_]?detector|ising-calibration|cosmos-reason2|whisper|\btts\b|-tts$|transcribe|robotics|computer-use|-image$|nano-banana|lyria|antigravity|deep-research|sdxl|flux|bria|gemma-3-(?:4b|12b)-it/i

const NVIDIA_PREFERRED_ORDER = [
  'nvidia/nvidia/nemotron-3.5-lightning-30b-a3b',
  'nvidia/nvidia/nemotron-3.5-bolt-e4b',
  'nvidia/nvidia/nemotron-3-ultra-550b-a55b',
  'nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b',
  'nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
  'nvidia/deepseek-ai/deepseek-v4.1-flash',
  'nvidia/mistralai/mistral-large-4-1t-a52b',
  'nvidia/meta/muse-glimmer-30b',
]

const GOOGLE_PREFERRED_ORDER = [
  'google/gemini-2.5-flash',
  'google/gemini-2.5-pro',
  'google/gemini-2.0-flash',
  'google/gemini-flash-latest',
  'google/gemini-pro-latest',
  'google/gemini-2.5-flash-lite',
]

function sortByPreference(models: ModelInfo[], preferred: string[]): ModelInfo[] {
  const rank = new Map(preferred.map((id, i) => [id.toLowerCase(), i]))
  return [...models].sort((a, b) => {
    const ai = rank.get(a.id.toLowerCase())
    const bi = rank.get(b.id.toLowerCase())
    if (ai !== undefined && bi !== undefined) return ai - bi
    if (ai !== undefined) return -1
    if (bi !== undefined) return 1
    return 0
  })
}

export function clearModelsCache(providerKey?: string) {
  if (!providerKey) {
    cache.clear()
    return
  }
  const prefix = `${providerKey}:`
  for (const k of cache.keys()) {
    if (k.startsWith(prefix)) cache.delete(k)
  }
}

export async function listModels(opts: {
  baseURL: string
  apiKey: string
  headers: Record<string, string>
  providerKey: string
  modelID?: string
  bypassCache?: boolean
}): Promise<ModelInfo[]> {
  const cacheKey = `${opts.providerKey}:${opts.baseURL}`
  const cached = cache.get(cacheKey)
  if (!opts.bypassCache && cached && Date.now() < cached.expiresAt) return cached.models

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
          id: m.id?.startsWith(`${opts.providerKey}/`) ? m.id : `anthropic/${m.id}`,
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
      { id: 'anthropic/claude-sonnet-4-20250514', name: 'Claude Sonnet 4', context: 200_000 },
      { id: 'anthropic/claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', context: 200_000 },
      { id: 'anthropic/claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', context: 200_000 },
    ]
    cache.set(cacheKey, { models: staticModels, expiresAt: Date.now() + TTL_MS })
    return staticModels
  }

  // 2. Google Gemini: test or return models via v1beta/models?key=
  if (key === 'google' || base.includes('googleapis.com')) {
    try {
      const modelsBase = base.replace(/\/openai$/i, '')
      const url = `${modelsBase.includes('v1beta') ? modelsBase : `${modelsBase}/v1beta`}/models?key=${opts.apiKey}`
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
      if (res.ok) {
        const data = (await res.json()) as {
          models?: Array<{
            name?: string
            displayName?: string
            inputTokenLimit?: number
            supportedGenerationMethods?: string[]
          }>
        }
        const rawModels = (data.models ?? [])
          .filter((m) => {
            if (!m.name?.includes('gemini')) return false
            if (
              Array.isArray(m.supportedGenerationMethods) &&
              !m.supportedGenerationMethods.includes('generateContent')
            ) {
              return false
            }
            const rawId = m.name.replace(/^models\//, '')
            return !NON_CHAT_MODEL_RE.test(rawId)
          })
          .map((m) => {
            const rawId = m.name?.replace(/^models\//, '') ?? ''
            return {
              id: `google/${rawId}`,
              name: m.displayName ?? rawId,
              context: m.inputTokenLimit ?? 1_000_000,
            }
          })
        if (rawModels.length) {
          const models = sortByPreference(rawModels, GOOGLE_PREFERRED_ORDER)
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
    const staticGemini = [
      { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', context: 1_000_000 },
      { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', context: 1_000_000 },
      { id: 'google/gemini-2.0-flash', name: 'Gemini 2.0 Flash', context: 1_000_000 },
    ]
    cache.set(cacheKey, { models: staticGemini, expiresAt: Date.now() + TTL_MS })
    return staticGemini
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
        const isNvidia = key === 'nvidia' || base.includes('nvidia.com')
        const mapped = (rawList as Array<{ id?: string; name?: string; context_length?: number; contextLength?: number }>)
          .map((m) => {
            const rawId = m.id ?? ''
            const id = !rawId
              ? ''
              : key === 'openrouter'
                ? (rawId.startsWith('openrouter/') ? rawId : `openrouter/${rawId}`)
                : isNvidia
                  ? (rawId.startsWith(`${opts.providerKey}/${opts.providerKey}/`)
                      ? rawId
                      : `${opts.providerKey}/${rawId}`)
                  : (rawId.startsWith(`${opts.providerKey}/`) ? rawId : `${opts.providerKey}/${rawId}`)
            return {
              id,
              name: m.name ?? rawId,
              context: (m.context_length ?? m.contextLength ?? 128_000) as number,
            }
          })
          .filter((m) => m.id && m.id !== `${opts.providerKey}/` && !NON_CHAT_MODEL_RE.test(m.id))
        const sorted = isNvidia ? sortByPreference(mapped, NVIDIA_PREFERRED_ORDER) : mapped
        const models = sorted.slice(0, 100)
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
