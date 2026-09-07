/**
 * Mira Config — Loads mira.json / mira.jsonc + env fallbacks
 * Injects AGENTS.md project instructions into the system prompt.
 * (Skills + todos injection happens per-turn in SessionPrompt.loadContext.)
 */
import type { MiraConfig, JsonValue } from '../types/index.js'
import { z } from 'zod'
import {
  DEFAULT_CONFIG as SHARED_DEFAULT,
  applyLayers as sharedApplyLayers,
} from '../../../shared/src/schemas/config.js'

type PartialMiraConfig = Partial<MiraConfig>

const DEFAULT_CONFIG: MiraConfig = {
  ...SHARED_DEFAULT,
  // Server adds richer defaults — MCP + provider registry (shared has minimal)
  mcp: {
    firecrawl: {
      type: 'remote' as const,
      url: 'https://mcp.firecrawl.dev/mcp',
      enabled: false,
      headers: { Authorization: 'Bearer {env:FIRECRAWL_API_KEY}' },
    },
    tavily: { type: 'remote' as const, url: 'https://mcp.tavily.com/mcp', enabled: false },
  },
  provider: {
    openrouter: {
      npm: '@ai-sdk/openai-compatible',
      name: 'OpenRouter',
      options: {
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: '{env:OPENROUTER_API_KEY}',
        headers: {},
        timeout: 120_000,
        kind: 'openrouter',
      },
      models: {},
    },
    anthropic: {
      npm: '@ai-sdk/anthropic',
      name: 'Anthropic Direct',
      options: {
        baseURL: 'https://api.anthropic.com/v1',
        apiKey: '{env:ANTHROPIC_API_KEY}',
        headers: {},
        timeout: 120_000,
        kind: 'anthropic',
      },
      models: {
        'claude-sonnet-4': { name: 'Claude Sonnet 4', limit: { context: 200000, output: 8192 } },
      },
    },
    openai: {
      npm: '@ai-sdk/openai',
      name: 'OpenAI',
      options: {
        baseURL: 'https://api.openai.com/v1',
        apiKey: '{env:OPENAI_API_KEY}',
        headers: {},
        timeout: 120_000,
        kind: 'openai',
      },
      models: { 'gpt-4o': { name: 'GPT-4o', limit: { context: 128000, output: 4096 } } },
    },
    google: {
      npm: '@ai-sdk/google',
      name: 'Google Generative AI',
      options: {
        baseURL: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: ['{env:GOOGLE_GENERATIVE_AI_API_KEY}', '{env:GOOGLE_API_KEY}'],
        headers: {},
        timeout: 120_000,
        kind: 'google',
      },
      models: {},
    },
    deepseek: {
      npm: '@ai-sdk/openai-compatible',
      name: 'DeepSeek',
      options: {
        baseURL: 'https://api.deepseek.com/v1',
        apiKey: '{env:DEEPSEEK_API_KEY}',
        headers: {},
        timeout: 120_000,
        kind: 'deepseek',
      },
      models: {},
    },
    nvidia: {
      npm: '@ai-sdk/openai-compatible',
      name: 'NVIDIA NIM',
      options: {
        baseURL: 'https://integrate.api.nvidia.com/v1',
        apiKey: '{env:NVIDIA_API_KEY}',
        headers: {},
        timeout: 120_000,
        kind: 'nvidia',
      },
      models: {},
    },
  },
  routing: {
    aliases: {},
    fallbacks: [],
    defaultProvider: 'openrouter',
  },
  subgateways: {
    default: {
      provider: 'openrouter',
      model: SHARED_DEFAULT.model,
      fallback: [],
      rateLimit: { rps: 10, burst: 20 },
      retry: { maxAttempts: 3, baseMs: 500, maxMs: 10_000 },
      timeout: 120_000,
      circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 30_000 },
      enabled: true,
    },
    cheap: {
      provider: 'openrouter',
      model: SHARED_DEFAULT.smallModel ?? 'openrouter/deepseek/deepseek-v3.2-exp',
      fallback: [],
      rateLimit: { rps: 20, burst: 40 },
      retry: { maxAttempts: 3, baseMs: 300, maxMs: 5_000 },
      timeout: 60_000,
      circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 15_000 },
      enabled: true,
    },
    vision: {
      provider: 'openai',
      model: 'openai/gpt-4o',
      fallback: [],
      rateLimit: { rps: 5, burst: 10 },
      retry: { maxAttempts: 3, baseMs: 500, maxMs: 10_000 },
      timeout: 120_000,
      circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 30_000 },
      enabled: true,
    },
    local: {
      provider: 'openrouter',
      model: SHARED_DEFAULT.model,
      fallback: [],
      rateLimit: { rps: 10, burst: 20 },
      retry: { maxAttempts: 2, baseMs: 500, maxMs: 5_000 },
      timeout: 30_000,
      circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 10_000 },
      enabled: true,
    },
    compaction: {
      provider: 'openrouter',
      model: SHARED_DEFAULT.smallModel ?? 'openrouter/deepseek/deepseek-v3.2-exp',
      fallback: [],
      rateLimit: { rps: 10, burst: 20 },
      retry: { maxAttempts: 2, baseMs: 300, maxMs: 5_000 },
      timeout: 45_000,
      circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 15_000 },
      enabled: true,
    },
    'agent:ask': {
      provider: 'openrouter',
      model: 'openrouter/deepseek/deepseek-v3.2-exp',
      fallback: [],
      rateLimit: { rps: 20, burst: 40 },
      retry: { maxAttempts: 3, baseMs: 300, maxMs: 5_000 },
      timeout: 60_000,
      circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 15_000 },
      enabled: true,
    },
  },
} as MiraConfig

let cached: MiraConfig | null = null

export async function loadConfig(cwd = process.cwd()): Promise<MiraConfig> {
  if (cached) return cached
  // Try mira.json, mira.jsonc, .mira/config.json
  const candidates = ['mira.json', 'mira.jsonc', '.mira/config.json']
  for (const name of candidates) {
    try {
      const file = Bun.file(`${cwd}/${name}`)
      if (await file.exists()) {
        const raw = (await file.json()) as Partial<MiraConfig>
        // Deep-merge object sections so a partial mira.json (e.g. {"permission":{"bash":"ask"}})
        // overrides only the keys it names — never wipes sibling defaults.
        function mergeSection<T>(base: T | undefined, override: T | undefined): T | undefined {
          if (override === undefined) return base
          if (base === undefined) return override
          if (typeof override !== 'object' || override === null || Array.isArray(override))
            return override
          if (typeof base !== 'object' || base === null || Array.isArray(base)) return override
          return { ...(base as object), ...(override as object) } as T
        }
        cached = {
          ...DEFAULT_CONFIG,
          ...raw,
          permission:
            mergeSection(DEFAULT_CONFIG.permission, raw.permission) ?? DEFAULT_CONFIG.permission,
          mcp: mergeSection(DEFAULT_CONFIG.mcp, raw.mcp) ?? DEFAULT_CONFIG.mcp,
          provider: mergeSection(DEFAULT_CONFIG.provider, raw.provider) ?? DEFAULT_CONFIG.provider,
          routing: mergeSection(
            DEFAULT_CONFIG.routing,
            (raw as Record<string, unknown>).routing as typeof DEFAULT_CONFIG.routing,
          ),
          subgateways: mergeSection(
            DEFAULT_CONFIG.subgateways,
            (raw as Record<string, unknown>).subgateways as typeof DEFAULT_CONFIG.subgateways,
          ),
          loop: mergeSection(DEFAULT_CONFIG.loop, raw.loop),
          agents: mergeSection(DEFAULT_CONFIG.agents, raw.agents),
          guardrails: mergeSection(DEFAULT_CONFIG.guardrails, raw.guardrails),
          features: mergeSection(DEFAULT_CONFIG.features, raw.features),
          tools: mergeSection(DEFAULT_CONFIG.tools, raw.tools),
        } as MiraConfig
        return cached
      }
    } catch {}
  }
  cached = DEFAULT_CONFIG
  return cached
}

export function getConfig(): MiraConfig {
  return cached ?? DEFAULT_CONFIG
}

// ── Layer helpers ────────────────────────────────────────────────────
function isPlainObject(
  v: PartialMiraConfig | MiraConfig | string | number | boolean | null,
): v is PartialMiraConfig {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function mergePartialMiraConfig(
  base: PartialMiraConfig,
  patch: PartialMiraConfig,
): PartialMiraConfig {
  const out: PartialMiraConfig = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    const prev = out[k as keyof PartialMiraConfig]
    if (isPlainObject(prev as PartialMiraConfig) && isPlainObject(v as PartialMiraConfig)) {
      out[k as keyof PartialMiraConfig] = mergePartialMiraConfig(
        prev as PartialMiraConfig,
        v as PartialMiraConfig,
      ) as never
    } else {
      out[k as keyof PartialMiraConfig] = v as never
    }
  }
  return out
}

// Zod schema for patch validation (mirrors shared/schemas/config.ts)
const miraConfigPatchSchema = z
  .object({
    model: z.string().min(1).optional(),
    smallModel: z.string().optional(),
    loop: z
      .object({
        maxSteps: z.number().int().positive().optional(),
        contextLimit: z.number().int().positive().optional(),
        compactionThreshold: z.number().min(0).max(1).optional(),
        smallModel: z.string().optional(),
      })
      .optional(),
    permission: z
      .record(
        z.string(),
        z.union([
          z.enum(['allow', 'deny', 'ask']),
          z.record(z.string(), z.enum(['allow', 'deny', 'ask'])),
        ]),
      )
      .optional(),
    guardrails: z
      .object({
        enforce: z.boolean().optional(),
        allowedRoots: z.array(z.string()).optional(),
        blockedPaths: z.array(z.string()).optional(),
        blockedCommands: z.array(z.string()).optional(),
        allowedCommands: z.array(z.string()).optional(),
        maxOutputBytes: z.number().int().positive().optional(),
        auditLogPath: z.string().optional(),
      })
      .optional(),
    mcp: z
      .record(
        z.string(),
        z.object({
          type: z.enum(['local', 'remote']),
          command: z.array(z.string()).optional(),
          args: z.array(z.string()).optional(),
          url: z.string().optional(),
          enabled: z.boolean().optional(),
          env: z.record(z.string(), z.string()).optional(),
          headers: z.record(z.string(), z.string()).optional(),
          timeoutMs: z.number().int().positive().optional(),
          reconnect: z
            .object({
              enabled: z.boolean().optional(),
              maxRetries: z.number().int().min(0).optional(),
              baseDelayMs: z.number().int().positive().optional(),
              maxDelayMs: z.number().int().positive().optional(),
            })
            .optional(),
        }),
      )
      .optional(),
    provider: z
      .record(
        z.string(),
        z.object({
          npm: z.string().optional(),
          name: z.string().optional(),
          options: z
            .object({
              baseURL: z.string().optional(),
              apiKey: z.union([z.string(), z.array(z.string())]).optional(),
              headers: z.record(z.string(), z.string()).optional(),
              timeout: z.number().int().positive().optional(),
              kind: z.string().optional(),
            })
            .optional(),
          models: z
            .record(
              z.string(),
              z.object({
                name: z.string(),
                limit: z.object({ context: z.number(), output: z.number() }),
              }),
            )
            .optional(),
        }),
      )
      .optional(),
    routing: z
      .object({
        aliases: z.record(z.string(), z.string()).optional(),
        fallbacks: z.array(z.string()).optional(),
        defaultProvider: z.string().optional(),
        lanes: z.record(z.string(), z.string()).optional(),
      })
      .optional(),
    subgateways: z
      .record(
        z.string(),
        z.object({
          provider: z.string().optional(),
          model: z.string().optional(),
          fallback: z.array(z.string()).optional(),
          rateLimit: z
            .object({
              rps: z.number().positive().optional(),
              burst: z.number().int().positive().optional(),
            })
            .optional(),
          costCap: z
            .object({
              perTask: z.number().positive().optional(),
              perSession: z.number().positive().optional(),
            })
            .optional(),
          retry: z
            .object({
              maxAttempts: z.number().int().positive().optional(),
              baseMs: z.number().int().positive().optional(),
              maxMs: z.number().int().positive().optional(),
            })
            .optional(),
          timeout: z.number().int().positive().optional(),
          circuitBreaker: z
            .object({
              failureThreshold: z.number().int().positive().optional(),
              resetTimeoutMs: z.number().int().positive().optional(),
            })
            .optional(),
          enabled: z.boolean().optional(),
        }),
      )
      .optional(),
    agents: z
      .record(
        z.string(),
        z.object({
          system: z.string(),
          description: z.string().optional(),
          tools: z.array(z.string()).optional(),
          permissions: z.enum(['readonly', 'standard', 'elevated']).optional(),
          model: z.string().min(1).optional(),
        }),
      )
      .optional(),
    autoModel: z
      .object({
        enabled: z.boolean().optional(),
        tier: z.enum(['cheap', 'balanced', 'max']).optional(),
      })
      .optional(),
    costCap: z
      .object({
        perTask: z.number().positive().optional(),
        perSession: z.number().positive().optional(),
      })
      .optional(),
    features: z
      .object({
        injectTodosIntoLoadContext: z.boolean().optional(),
        enforceLaneContracts: z.boolean().optional(),
        perAgentPermissionProfiles: z.boolean().optional(),
      })
      .optional(),
    tools: z
      .object({
        terminal: z
          .object({
            enabled: z.boolean().optional(),
            sandbox: z.boolean().optional(),
            allowedCommands: z.array(z.string()).optional(),
            timeoutMs: z.number().int().positive().optional(),
          })
          .optional(),
      })
      .optional(),
    theme: z.enum(['dark', 'light', 'system']).optional(),
    debug: z.boolean().optional(),
  })
  .passthrough()

/** Write patch to target layer file, deep-merge, invalidate cache. */
export async function saveConfig(
  patch: Partial<MiraConfig>,
  layer: 'project' | 'local' = 'project',
  cwd = process.cwd(),
): Promise<MiraConfig> {
  const parsed = miraConfigPatchSchema.partial().parse(patch) as Partial<MiraConfig>
  const targetPath = layer === 'local' ? `${cwd}/.mira/local.json` : `${cwd}/mira.json`
  // Ensure directory exists
  const dir = targetPath.slice(0, targetPath.lastIndexOf('/'))
  if (dir) {
    try {
      const { mkdir } = await import('node:fs/promises')
      await mkdir(dir, { recursive: true })
    } catch {}
  }
  let existing: PartialMiraConfig = {}
  try {
    const f = Bun.file(targetPath)
    if (await f.exists()) existing = (await f.json()) as PartialMiraConfig
  } catch {}
  const merged = mergePartialMiraConfig(existing, parsed)
  await Bun.write(targetPath, JSON.stringify(merged, null, 2) + '\n')
  cached = null
  return loadConfig(cwd)
}

/** Remove an MCP server from the project config file (for DELETE /mcp/:name). */
export async function removeMcpFromConfig(name: string, cwd = process.cwd()): Promise<void> {
  const targetPath = `${cwd}/mira.json`
  let existing: PartialMiraConfig = {}
  try {
    const f = Bun.file(targetPath)
    if (await f.exists()) existing = (await f.json()) as PartialMiraConfig
  } catch {}
  if (existing.mcp && existing.mcp[name]) {
    delete existing.mcp[name]
    await Bun.write(targetPath, JSON.stringify(existing, null, 2) + '\n')
    cached = null
    await loadConfig(cwd)
  }
}

/** Remove a provider from the project config file (for DELETE /provider/:name). */
export async function removeProviderFromConfig(name: string, cwd = process.cwd()): Promise<void> {
  const targetPath = `${cwd}/mira.json`
  let existing: PartialMiraConfig = {}
  try {
    const f = Bun.file(targetPath)
    if (await f.exists()) existing = (await f.json()) as PartialMiraConfig
  } catch {}
  if (existing.provider && existing.provider[name]) {
    delete existing.provider[name]
    await Bun.write(targetPath, JSON.stringify(existing, null, 2) + '\n')
    cached = null
    await loadConfig(cwd)
  }
}

/** Return merged config + per-layer breakdown for debugging. */
export async function getConfigLayers(cwd = process.cwd()): Promise<{
  merged: MiraConfig
  layers: Array<{ source: string; path: string | null; config: PartialMiraConfig }>
}> {
  const layers: Array<{ source: string; path: string | null; config: Partial<MiraConfig> }> = []
  // defaults
  layers.push({ source: 'defaults', path: null, config: DEFAULT_CONFIG as Partial<MiraConfig> })
  // system
  try {
    const f = Bun.file('/etc/mira/mira.json')
    if (await f.exists())
      layers.push({
        source: 'system',
        path: '/etc/mira/mira.json',
        config: (await f.json()) as Partial<MiraConfig>,
      })
  } catch {}
  // global
  try {
    const home = process.env.HOME ?? ''
    if (home) {
      const p = `${home}/.mira/mira.json`
      const f = Bun.file(p)
      if (await f.exists())
        layers.push({ source: 'global', path: p, config: (await f.json()) as Partial<MiraConfig> })
    }
  } catch {}
  // project candidates
  for (const name of ['mira.json', 'mira.jsonc', '.mira/config.json']) {
    try {
      const p = `${cwd}/${name}`
      const f = Bun.file(p)
      if (await f.exists()) {
        layers.push({ source: 'project', path: p, config: (await f.json()) as Partial<MiraConfig> })
        break
      }
    } catch {}
  }
  // local
  try {
    const p = `${cwd}/.mira/local.json`
    const f = Bun.file(p)
    if (await f.exists())
      layers.push({ source: 'local', path: p, config: (await f.json()) as Partial<MiraConfig> })
  } catch {}
  // env (synthetic)
  const envConfig: PartialMiraConfig = {}
  if (process.env.MIRA_MODEL) envConfig.model = process.env.MIRA_MODEL
  if (process.env.MIRA_SMALL_MODEL) envConfig.smallModel = process.env.MIRA_SMALL_MODEL
  if (Object.keys(envConfig).length) layers.push({ source: 'env', path: null, config: envConfig })
  const merged = await loadConfig(cwd)
  return { merged, layers }
}

// ── Loop limits — sensible defaults, overridable via env ───────────
// Env vars (MIRA_* convention): MIRA_MAX_STEPS, MIRA_CONTEXT_LIMIT,
// MIRA_COMPACTION_THRESHOLD, MIRA_SMALL_MODEL

export interface LoopLimits {
  /** max agentic steps (LLM turns) per user prompt (default 32) */
  maxSteps: number
  /** provider context window used for compaction math (default 128_000 tokens) */
  contextLimit: number
  /** fraction of contextLimit at which compaction triggers (default 0.8) */
  compactionThreshold: number
  /** small model used for compaction summaries */
  smallModel: string
}

const DEFAULT_LOOP_LIMITS: LoopLimits = {
  maxSteps: 32,
  contextLimit: 128_000,
  compactionThreshold: 0.8,
  smallModel: 'openrouter/deepseek/deepseek-v3.2-exp',
}

function parseContextLimitValue(raw: JsonValue | undefined): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw
  if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase()
    if (s.endsWith('k')) {
      const n = Number(s.slice(0, -1))
      if (Number.isFinite(n) && n > 0) return Math.round(n * 1000)
    }
    const n = Number(s)
    if (Number.isFinite(n) && n > 0) return n
  }
  return undefined
}

function numFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback
  const parsed = parseContextLimitValue(raw)
  return parsed ?? fallback
}

/**
 * Loop limits for SessionPrompt.runLoop.
 * Precedence: env var > mira.json `loop` section > built-in defaults.
 * Backward-compat: also reads legacy `loopLimits` key and string "128k" forms.
 */
export function getLoopLimits(): LoopLimits {
  const cfg = getConfig() as Record<string, JsonValue> &
    MiraConfig & { loopLimits?: Record<string, JsonValue> }
  const loopRaw = (cfg.loop ?? cfg.loopLimits ?? {}) as Record<string, JsonValue>
  const fileLoop = loopRaw as LoopLimits & Record<string, JsonValue>
  const numFromFile = (raw: JsonValue | undefined, fallback: number): number =>
    parseContextLimitValue(raw) ?? fallback
  const thresholdFromFile = (raw: JsonValue | undefined, fallback: number): number => {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0 && raw <= 1) return raw
    if (typeof raw === 'string') {
      const n = Number(raw)
      if (Number.isFinite(n) && n > 0 && n <= 1) return n
    }
    return fallback
  }
  return {
    maxSteps: numFromEnv(
      process.env.MIRA_MAX_STEPS,
      numFromFile(fileLoop.maxSteps, DEFAULT_LOOP_LIMITS.maxSteps),
    ),
    contextLimit: numFromEnv(
      process.env.MIRA_CONTEXT_LIMIT,
      numFromFile(fileLoop.contextLimit, DEFAULT_LOOP_LIMITS.contextLimit),
    ),
    compactionThreshold: numFromEnv(
      process.env.MIRA_COMPACTION_THRESHOLD,
      thresholdFromFile(fileLoop.compactionThreshold, DEFAULT_LOOP_LIMITS.compactionThreshold),
    ),
    smallModel:
      process.env.MIRA_SMALL_MODEL ??
      (fileLoop.smallModel as string | undefined) ??
      getConfig().smallModel ??
      DEFAULT_LOOP_LIMITS.smallModel,
  }
}

/** Build system prompt prefix: AGENTS.md + Skills + project context */
export async function buildSystemPrompt(cwd = process.cwd()): Promise<string> {
  const parts: string[] = [
    'You are Mira — a senior AI agent. Be concise, pragmatic, and thorough.',
    'Follow plan-first workflow: Explore → Plan → Implement → Verify.',
  ]
  for (const name of ['AGENTS.md', 'CLAUDE.md', '.mira/instructions.md']) {
    try {
      const f = Bun.file(`${cwd}/${name}`)
      if (await f.exists()) {
        const txt = await f.text()
        parts.push(`\n# Project Instructions (${name})\n${txt.slice(0, 8000)}`)
      }
    } catch {}
  }
  return parts.join('\n\n')
}
