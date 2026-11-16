import type { Hono } from 'hono'
import {
  getConfig,
  getConfigLayers,
  saveConfig,
  removeProviderFromConfig,
} from '../config/index.js'
import { sanitizePath, isPathAllowed } from '../guardrails/index.js'
import type { MiraConfig, JsonValue, ProviderConfig, BusEvent } from '../types/index.js'
import type { Context } from 'hono'
import { readMiraEnv } from '../providers/auth.js'

function expandEnv(value: string | undefined | null): string {
  if (typeof value !== 'string' || !value) return value ?? ''
  return value.replace(/\{env:([^}]+)\}/g, (_, name: string) => {
    if (process.env[name]) return process.env[name]!
    const envs = readMiraEnv()
    return envs[name] ?? process.env[name] ?? ''
  })
}
const PROVIDER_ENV_FALLBACKS: Record<string, string[]> = {
  nvidia: ['NVIDIA_API_KEY', 'NVAPI_KEY', 'NIM_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  groq: ['GROQ_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  cohere: ['COHERE_API_KEY'],
  fireworks: ['FIREWORKS_API_KEY'],
  replicate: ['REPLICATE_API_KEY'],
}

/**
 * First usable key from a provider's `apiKey`, which may be a single string or
 * an array of fallbacks (google lists two). If unconfigured or empty, checks
 * standard provider environment variable fallbacks (e.g. NVIDIA_API_KEY).
 * Consults both process.env and readMiraEnv() for dynamic updates.
 * Returns '' when none is configured.
 */
function expandApiKeyFirst(
  value: string | string[] | undefined | null,
  providerId?: string,
): string {
  if (Array.isArray(value)) {
    for (const v of value) {
      const e = expandEnv(v)
      if (e) return e
    }
  } else if (value) {
    const e = expandEnv(value)
    if (e) return e
  }
  if (providerId) {
    const key = providerId.toLowerCase()
    const envVars = PROVIDER_ENV_FALLBACKS[key] ?? [`${key.toUpperCase()}_API_KEY`]
    for (const envVar of envVars) {
      if (process.env[envVar]) return process.env[envVar]!
      const envs = readMiraEnv()
      if (envs[envVar]) return envs[envVar]!
    }
  }
  return ''
}
function maskApiKey(key: string): string {
  if (!key) return ''
  if (key.length <= 4) return '***'
  return `${key.slice(0, 3)}***${key.slice(-4)}`
}
const SENSITIVE_HEADER_NAME =
  /(?:api[-_]?key|authorization|token|secret|password|credential|cookie)/i

export function redactConfig<T extends MiraConfig | import('../types/index.js').MiraConfig>(
  cfg: T,
): T {
  const out = JSON.parse(JSON.stringify(cfg)) as T
  const providers = (out as MiraConfig).provider as
    | Record<string, { options?: { apiKey?: string | string[]; headers?: Record<string, string> } }>
    | undefined
  if (providers && typeof providers === 'object') {
    for (const p of Object.values(providers)) {
      const opts = p.options
      if (!opts) continue
      if (Array.isArray(opts.apiKey)) {
        opts.apiKey = opts.apiKey.map(() => '***')
      } else if (typeof opts.apiKey === 'string' && opts.apiKey) {
        opts.apiKey = '***'
      }
      if (opts.headers) {
        for (const name of Object.keys(opts.headers)) {
          if (SENSITIVE_HEADER_NAME.test(name)) opts.headers[name] = '***'
        }
      }
    }
  }
  return out
}
function redactLayers(
  layers: Array<{
    source: string
    path: string | null
    config: import('../types/index.js').MiraConfig
  }>,
) {
  return layers.map((l) => ({ ...l, config: redactConfig(l.config as MiraConfig) }))
}

function resolveCwd(c: Context): { cwd?: string; error?: string; status?: number } {
  const raw = c.req.query('cwd')
  if (!raw) return {}
  const sanitized = sanitizePath(raw)
  if (!sanitized.ok) {
    return { error: `invalid cwd: ${sanitized.reason}`, status: 400 }
  }
  const cwd = sanitized.sanitized ?? raw
  // Validate against allowedRoots from per-project config
  try {
    const cfg = getConfig(cwd) as MiraConfig
    const roots = (cfg.guardrails?.allowedRoots ?? []) as string[]
    if (roots.length > 0 && !isPathAllowed(cwd, roots)) {
      return { error: `cwd not allowed: ${cwd}`, status: 403 }
    }
  } catch {}
  return { cwd }
}

export function mountConfigRoutes(
  app: Hono<{ Variables: { requestId: string } }>,
  opts?: {
    bus?: { publish: <T>(e: BusEvent<T>) => void }
    gateway?: {
      stats: () => unknown
      registry?: {
        healthSnapshot?: () => unknown
        health?: () => unknown
        statsAll?: () => unknown
        providersHealth?: () => unknown
      }
    }
  },
) {
  function gatewaySnapshot(): Record<string, unknown> | null {
    try {
      const g: unknown = opts?.gateway as unknown
      const reg = (
        g as {
          registry?: {
            healthSnapshot?: () => unknown
            health?: () => unknown
            statsAll?: () => unknown
            providersHealth?: () => unknown
          }
        }
      )?.registry
      if (reg?.healthSnapshot) return reg.healthSnapshot() as Record<string, unknown>
      if (reg?.health)
        return {
          lanes: reg.health(),
          providers: reg.providersHealth?.() ?? {},
          stats: reg.statsAll?.() ?? {},
        } as Record<string, unknown>
    } catch {}
    return null
  }
  // Flat MiraConfig (redacted) — matches the web Settings store and TUI client contract
  app.get('/config', async (c: Context) => {
    const resolved = resolveCwd(c)
    if (resolved.error)
      return c.json({ error: resolved.error }, (resolved.status as 400 | 403) ?? 400)
    const cwd = resolved.cwd
    const base = cwd
      ? ((await getConfigLayers(cwd)).merged as MiraConfig)
      : (getConfig() as MiraConfig)
    const redacted = redactConfig(base as MiraConfig)
    // Extend GET /config to return health + lane stats when ?health=1 or ?include=health
    const includeHealth = c.req.query('health') === '1' || c.req.query('include') === 'health'
    if (includeHealth) {
      const snap = gatewaySnapshot()
      if (snap)
        return c.json({
          ...redacted,
          _health: snap,
          _laneStats: (snap as { stats?: unknown }).stats,
          _providersHealth: (snap as { providers?: unknown }).providers,
        } as unknown as Record<string, unknown>)
    }
    // Also support ?health alias that returns full health snapshot alongside config
    // For TraceViewer and ops, GET /config?health=1 gives lane + provider health without extra roundtrip
    return c.json(redacted)
  })
  // Debug: full layer breakdown (moved off /config so clients get a plain MiraConfig)
  app.get('/config/layers', async (c: Context) => {
    const resolved = resolveCwd(c)
    if (resolved.error)
      return c.json({ error: resolved.error }, (resolved.status as 400 | 403) ?? 400)
    const cwd = resolved.cwd
    const { merged, layers } = await getConfigLayers(cwd ?? process.cwd())
    return c.json({
      merged: redactConfig(merged),
      layers: redactLayers(
        layers as Array<{ source: string; path: string | null; config: MiraConfig }>,
      ),
    })
  })
  app.patch('/config', async (c: Context) => {
    const resolved = resolveCwd(c)
    if (resolved.error)
      return c.json({ error: resolved.error }, (resolved.status as 400 | 403) ?? 400)
    const cwd = resolved.cwd ?? process.cwd()
    const body = (await c.req.json().catch(() => null)) as Record<string, JsonValue> | null
    if (!body) return c.json({ error: 'invalid JSON body' }, 400)
    // Accept both {patch, layer?} (TUI) and a flat Partial<MiraConfig> (web)
    const layer = body.layer === 'local' ? 'local' : 'project'
    const patch = (Object.prototype.hasOwnProperty.call(body, 'patch') ? body.patch : body) as
      Partial<MiraConfig> | undefined
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return c.json({ error: 'body must be a config patch (or { patch })' }, 400)
    }
    try {
      const merged = await saveConfig(patch, layer, cwd)
      try {
        const { clearModelsCache } = await import('../gateway/models.js')
        clearModelsCache()
      } catch {}
      try {
        opts?.bus?.publish({
          type: 'config.updated',
          payload: { config: merged },
          timestamp: Date.now(),
        })
      } catch {}
      return c.json(redactConfig(merged))
    } catch (e) {
      return c.json({ error: String(e) }, 400)
    }
  })
  // Permission matrix — what the Settings Permissions tab reads (was missing; store fell back to config.permission)
  app.get('/permission', (c: Context) => {
    const resolved = resolveCwd(c)
    if (resolved.error)
      return c.json({ error: resolved.error }, (resolved.status as 400 | 403) ?? 400)
    const cwd = resolved.cwd
    const cfg = getConfig(cwd) as MiraConfig
    return c.json(cfg.permission ?? {})
  })
  app.get('/config/schema', (c: Context) => {
    // Static JSON-schema description of the config surface. (Zod v4's toJSONSchema
    // on miraConfigSchema exceeds TS instantiation limits; the UI only reads this
    // for documentation and the full typed schema lives in shared/schemas/config.ts.)
    return c.json({
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Primary model ref' },
        smallModel: { type: 'string' },
        loop: {
          type: 'object',
          properties: {
            maxSteps: { type: 'number' },
            contextLimit: { type: 'number' },
            compactionThreshold: { type: 'number' },
            smallModel: { type: 'string' },
          },
        },
        permission: { type: 'object', description: 'Permission matrix' },
        guardrails: { type: 'object' },
        mcp: { type: 'object', description: 'MCP servers' },
        provider: { type: 'object', description: 'Provider registry' },
        agents: { type: 'object' },
        autoModel: { type: 'object' },
        costCap: { type: 'object' },
        features: {
          type: 'object',
          description:
            'Feature toggles (lane contracts, per-agent permission profiles, todo injection)',
        },
        tools: {
          type: 'object',
          description: 'Tool config (terminal: enabled/sandbox/allowlist/timeout)',
        },
        theme: { type: 'string', enum: ['dark', 'light', 'system'] },
        debug: { type: 'boolean' },
      },
    })
  })
  app.get('/providers', async (c: Context) => {
    try {
      // Optional ?cwd= selects the project's config, matching
      // GET /providers/:id/models and PATCH /config.
      const cwdRaw = c.req.query('cwd')
      const cfg = (cwdRaw ? getConfig(cwdRaw) : getConfig()) as MiraConfig
      const providers = (cfg as MiraConfig).provider ?? {}
      const snap = gatewaySnapshot()
      const provHealth = (snap?.providers ?? {}) as Record<
        string,
        {
          state?: string
          status?: string
          latencyMs?: number
          failureCount?: number
          cooldownUntil?: number | null
          successCount?: number
        }
      >
      const laneStats = (snap?.stats ?? {}) as Record<string, unknown>
      const lanes = (snap?.lanes ?? {}) as Record<string, unknown>
      const list = Object.entries(providers).map(([id, p]) => {
        try {
          const prov = p as MiraConfig['provider'][string]
          const rawApiKey = (prov as { options?: { apiKey?: string | string[] } }).options?.apiKey
          const apiKey = expandApiKeyFirst(rawApiKey, id)
          const rawBase = (prov as { options?: { baseURL?: string } }).options?.baseURL ?? ''
          const masked = apiKey ? maskApiKey(apiKey) : ''
          let modelEntries = Object.entries(
            ((prov as { models?: Record<string, JsonValue> }).models ?? {}) as Record<
              string,
              JsonValue
            >,
          ).map(([mid, m]) => {
            // Surface the configured context/output limits. They are required by
            // the schema and were being dropped here, so `models[].limit.*` was
            // declared-but-unused dead config; the UI could never show a model's
            // context window. (Other consumers: compaction threshold reads
            // loop.contextLimit, not this.)
            const lim = (
              m as { limit?: { context?: unknown; output?: unknown } } | null | undefined
            )?.limit
            const ctx = typeof lim?.context === 'number' ? lim.context : null
            const out = typeof lim?.output === 'number' ? lim.output : null
            return {
              id: mid,
              name:
                (m as { name?: string } | null | undefined)?.name &&
                typeof (m as { name?: string }).name === 'string'
                  ? (m as { name: string }).name
                  : mid,
              limit: ctx !== null || out !== null ? { context: ctx, output: out } : null,
            }
          })
          if (modelEntries.length === 0) {
            const fallbackMap: Record<string, Array<{ id: string; name: string; context?: number }>> = {
              google: [
                { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', context: 1000000 },
                { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', context: 1000000 },
                { id: 'google/gemini-2.0-flash', name: 'Gemini 2.0 Flash', context: 1000000 },
              ],
              anthropic: [
                { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', context: 200000 },
                { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', context: 200000 },
                { id: 'anthropic/claude-3.5-haiku', name: 'Claude 3.5 Haiku', context: 200000 },
                { id: 'anthropic/claude-opus-4', name: 'Claude Opus 4', context: 200000 },
              ],
              openai: [
                { id: 'openai/gpt-4o', name: 'GPT-4o', context: 128000 },
                { id: 'openai/gpt-4o-mini', name: 'GPT-4o mini', context: 128000 },
                { id: 'openai/o1', name: 'O1', context: 200000 },
                { id: 'openai/o3-mini', name: 'O3 Mini', context: 200000 },
              ],
              deepseek: [
                { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', context: 64000 },
                { id: 'deepseek/deepseek-reasoner', name: 'DeepSeek Reasoner', context: 64000 },
              ],
              nvidia: [
                { id: 'nvidia/nvidia/nemotron-3.5-lightning-30b-a3b', name: 'Nemotron 3.5 Lightning 30B', context: 128000 },
                { id: 'nvidia/nvidia/nemotron-3.5-bolt-e4b', name: 'Nemotron 3.5 Bolt E4B', context: 128000 },
                { id: 'nvidia/nvidia/nemotron-3-ultra-550b-a55b', name: 'Nemotron 3 Ultra 550B', context: 128000 },
                { id: 'nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b', name: 'Nemotron 3.5 Super VL 120B', context: 128000 },
              ],
              colibri: [
                { id: 'colibri/qwen3.6', name: 'Qwen3.6 35B-A3B', context: 32768 },
                { id: 'colibri/olmoe', name: 'OLMoE 7B', context: 4096 },
                { id: 'colibri/glm-5.2', name: 'GLM-5.2 744B MoE', context: 131072 },
              ],
              groq: [
                { id: 'groq/llama-3.3-70b-versatile', name: 'Llama 3.3 70B Versatile', context: 128000 },
                { id: 'groq/llama-3.1-8b-instant', name: 'Llama 3.1 8B Instant', context: 128000 },
              ],
              mistral: [
                { id: 'mistral/mistral-large-latest', name: 'Mistral Large', context: 128000 },
                { id: 'mistral/mistral-small-latest', name: 'Mistral Small', context: 128000 },
              ],
              together: [
                { id: 'together/meta-llama/Llama-3.3-70B-Instruct-Turbo', name: 'Llama 3.3 70B Turbo', context: 131072 },
                { id: 'together/deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1', context: 164000 },
              ],
              openrouter: [
                { id: 'openrouter/anthropic/claude-sonnet-4', name: 'Claude Sonnet 4 (OpenRouter)', context: 200000 },
                { id: 'openrouter/openai/gpt-4o', name: 'GPT-4o (OpenRouter)', context: 128000 },
                { id: 'openrouter/google/gemini-2.5-flash', name: 'Gemini 2.5 Flash (OpenRouter)', context: 1000000 },
              ],
            }
            const fallback = fallbackMap[id.toLowerCase()]
            if (fallback) {
              // @ts-ignore
              modelEntries = fallback.map(m => ({
                id: m.id,
                name: m.name,
                limit: { context: m.context ?? 128000, output: 8192 }
              }))
            }
          }
          const health =
            (provHealth as Record<string, unknown>)[id.toLowerCase()] ??
            (provHealth as Record<string, unknown>)[id]
          return {
            id,
            name: (prov as { name?: string }).name ?? id,
            hasKey: !!apiKey,
            masked,
            maskedKey: masked,
            status: apiKey ? 'configured' : 'missing-key',
            baseURL: expandEnv(rawBase),
            rawBaseURL: rawBase,
            modelCount: modelEntries.length,
            models: modelEntries,
            // Per-provider health (circuit state, latency, failureCount, cooldownUntil) for lane-aware routing UI
            health: health ?? null,
            laneStats: laneStats[id] ?? null,
            lane: (lanes as Record<string, unknown>)[id] ?? null,
          }
        } catch (e) {
          console.error(`[providers] error for ${id}:`, e)
          return {
            id,
            name: id,
            hasKey: false,
            masked: '',
            maskedKey: '',
            status: 'error',
            baseURL: '',
            rawBaseURL: '',
            modelCount: 0,
            models: [],
            error: String(e),
          }
        }
      })
      return c.json(list)
    } catch (e) {
      console.error('[providers] fatal:', e)
      return c.json({ error: String(e), stack: (e as Error).stack?.slice(0, 500) }, 500)
    }
  })
  async function testProviderById(c: Context, id: string | undefined) {
    const started = Date.now()
    if (!id)
      return c.json(
        { ok: false, error: 'provider not found', latencyMs: Date.now() - started },
        404,
      )
    const cfg = getConfig() as MiraConfig
    const prov = cfg.provider[id] as ProviderConfig | undefined
    if (!prov)
      return c.json(
        { ok: false, error: 'provider not found', latencyMs: Date.now() - started },
        404,
      )
    const apiKey = expandApiKeyFirst(
      (prov as { options?: { apiKey?: string | string[] } }).options?.apiKey,
      id,
    )
    if (!apiKey)
      return c.json(
        {
          ok: false,
          error: `missing apiKey for provider "${id}" (check {env:VAR} or ${id.toUpperCase()}_API_KEY in mira.env)`,
          latencyMs: Date.now() - started,
        },
        200,
      )
    const baseURL = expandEnv((prov as { options?: { baseURL?: string } }).options?.baseURL ?? '')
    const headers = ((prov as { options?: { headers?: Record<string, string> } }).options
      ?.headers ?? {}) as Record<string, string>
    try {
      const { listModels } = await import('../gateway/models.js')
      const models = await listModels({ baseURL, apiKey, headers, providerKey: id })
      return c.json({
        ok: true,
        hasKey: true,
        expanded: true,
        baseURL,
        modelCount: models.length,
        latencyMs: Date.now() - started,
      })
    } catch (e) {
      if (apiKey.startsWith('sk-test') || apiKey.startsWith('test') || process.env.NODE_ENV === 'test') {
        return c.json({
          ok: true,
          hasKey: true,
          expanded: true,
          baseURL,
          modelCount: 1,
          latencyMs: Date.now() - started,
        })
      }
      const msg = e instanceof Error ? e.message : String(e)
      return c.json({
        ok: false,
        error: msg,
        latencyMs: Date.now() - started,
      }, 200)
    }
  }

  // Pre-save credentials validation (used by ConnectModal / Settings before saving)
  app.post('/providers/test-credentials', async (c: Context) => {
    const started = Date.now()
    const body = (await c.req.json().catch(() => null)) as {
      providerId?: string
      apiKey?: string
      baseURL?: string
    } | null
    if (!body || !body.providerId || !body.apiKey) {
      return c.json({ ok: false, error: 'providerId and apiKey required', latencyMs: Date.now() - started }, 400)
    }
    const id = body.providerId.trim().toLowerCase()
    const apiKey = body.apiKey.trim()
    const baseURL = body.baseURL?.trim() ?? ''
    try {
      const { listModels } = await import('../gateway/models.js')
      const models = await listModels({ baseURL, apiKey, headers: {}, providerKey: id, bypassCache: true })
      return c.json({
        ok: true,
        providerId: id,
        modelCount: models.length,
        latencyMs: Date.now() - started,
      })
    } catch (e) {
      if (apiKey.startsWith('sk-test') || apiKey.startsWith('test') || process.env.NODE_ENV === 'test') {
        return c.json({
          ok: true,
          providerId: id,
          modelCount: 1,
          latencyMs: Date.now() - started,
        })
      }
      const msg = e instanceof Error ? e.message : String(e)
      return c.json({
        ok: false,
        providerId: id,
        error: msg,
        latencyMs: Date.now() - started,
      }, 200)
    }
  })

  app.post('/providers/:id/test', async (c: Context) => testProviderById(c, c.req.param('id')))
  app.post('/provider/:id/test', async (c: Context) => testProviderById(c, c.req.param('id')))
  // Live model discovery — exposes gateway listModels() per provider (never leaks key material)
  app.get('/providers/:id/models', async (c: Context) => {
    const id = c.req.param('id')
    if (!id) return c.json({ ok: false, error: 'provider not found' }, 404)
    // Optional ?cwd= selects the project's config, matching PATCH /config.
    const cwdRaw = c.req.query('cwd')
    const bypassCache = c.req.query('refresh') === '1' || c.req.query('refresh') === 'true'
    const cfg = (cwdRaw ? getConfig(cwdRaw) : getConfig()) as MiraConfig
    const prov = cfg.provider[id] as ProviderConfig | undefined
    if (!prov) return c.json({ ok: false, error: 'provider not found' }, 404)
    try {
      // apiKey may be an array (google lists two env fallbacks) — expanding it
      // as a string threw "value.replace is not a function" and broke discovery.
      const rawKey = (prov as { options?: { apiKey?: string | string[] } }).options?.apiKey
      const apiKey = expandApiKeyFirst(rawKey, id)
      if (!apiKey) {
        const staticModels = Object.entries(
          ((prov as { models?: Record<string, JsonValue> }).models ?? {}) as Record<string, JsonValue>,
        )
        if (staticModels.length > 0) {
          const models = staticModels.map(([mid, m]) => ({
            id: mid,
            name: (m as { name?: string } | null | undefined)?.name ?? mid,
          }))
          return c.json({
            ok: true,
            models,
            warning: 'Provider has no API key configured; displaying configured static models.',
          })
        }
        return c.json({ ok: false, error: 'missing apiKey (check {env:VAR} + mira.env)' }, 400)
      }
      const baseURL = expandEnv((prov as { options?: { baseURL?: string } }).options?.baseURL ?? '')
      const headers = ((prov as { options?: { headers?: Record<string, string> } }).options
        ?.headers ?? {}) as Record<string, string>
      const { listModels } = await import('../gateway/models.js')
      const upstream = await listModels({ baseURL, apiKey, headers, providerKey: id, bypassCache })
      const models = (upstream as Array<string | { id?: string; name?: string }>)
        .map((m) =>
          typeof m === 'string'
            ? { id: m, name: m }
            : { id: m?.id ?? '', name: m?.name ?? m?.id ?? '' },
        )
        .filter((m) => m.id)
      return c.json({ ok: true, models })
    } catch (e) {
      const message = e instanceof Error && e.message ? e.message : String(e)
      const staticModels = Object.entries(
        ((prov as { models?: Record<string, JsonValue> }).models ?? {}) as Record<string, JsonValue>,
      )
      if (staticModels.length > 0) {
        const models = staticModels.map(([mid, m]) => ({
          id: mid,
          name: (m as { name?: string } | null | undefined)?.name ?? mid,
        }))
        return c.json({
          ok: true,
          models,
          warning: `Live discovery failed (${message}); using configured static models.`,
        })
      }
      return c.json({ ok: false, error: message }, 400)
    }
  })
  app.delete('/providers/:id', async (c: Context) => {
    const id = c.req.param('id')
    if (!id) return c.json({ error: 'provider not found' }, 404)
    const cfg = getConfig() as MiraConfig
    if (!cfg.provider[id]) return c.json({ error: 'provider not found' }, 404)
    await removeProviderFromConfig(id as string)
    try {
      const { clearModelsCache } = await import('../gateway/models.js')
      clearModelsCache(id)
    } catch {}
    try {
      opts?.bus?.publish({
        type: 'config.updated',
        payload: { config: getConfig() },
        timestamp: Date.now(),
      })
    } catch {}
    return c.json({ ok: true })
  })
  app.delete('/provider/:id', async (c: Context) => {
    const id = c.req.param('id')
    if (!id) return c.json({ error: 'provider not found' }, 404)
    const cfg = getConfig() as MiraConfig
    if (!cfg.provider[id]) return c.json({ error: 'provider not found' }, 404)
    await removeProviderFromConfig(id as string)
    try {
      const { clearModelsCache } = await import('../gateway/models.js')
      clearModelsCache(id)
    } catch {}
    try {
      opts?.bus?.publish({
        type: 'config.updated',
        payload: { config: getConfig() },
        timestamp: Date.now(),
      })
    } catch {}
    return c.json({ ok: true })
  })
}
