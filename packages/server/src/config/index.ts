/**
 * Mira Config — Loads mira.json / mira.jsonc + env fallbacks
 * Injects AGENTS.md project instructions into the system prompt.
 * (Skills + todos injection happens per-turn in SessionPrompt.loadContext.)
 */
import type { MiraConfig, JsonValue } from "../types/index.js"
import { z } from "zod"
import { DEFAULT_CONFIG as SHARED_DEFAULT, applyLayers as sharedApplyLayers } from "../../../shared/src/schemas/config.js"

type PartialMiraConfig = Partial<MiraConfig>

const DEFAULT_CONFIG: MiraConfig = {
  ...SHARED_DEFAULT,
  // Server adds richer defaults — MCP + provider registry (shared has minimal)
  mcp: {
    firecrawl: {
      type: "remote" as const,
      url: "https://mcp.firecrawl.dev/mcp",
      enabled: false,
      headers: { Authorization: "Bearer {env:FIRECRAWL_API_KEY}" },
    },
    tavily: { type: "remote" as const, url: "https://mcp.tavily.com/mcp", enabled: false },
  },
  provider: {
    openrouter: {
      npm: "@ai-sdk/openai-compatible",
      name: "OpenRouter",
      options: {
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: process.env.OPENROUTER_API_KEY ?? "",
      },
      models: {},
    },
    anthropic: {
      npm: "@ai-sdk/anthropic",
      name: "Anthropic Direct",
      options: {
        baseURL: "https://api.anthropic.com/v1",
        apiKey: process.env.ANTHROPIC_API_KEY ?? "",
      },
      models: { "claude-sonnet-4": { name: "Claude Sonnet 4", limit: { context: 200000, output: 8192 } } },
    },
    openai: {
      npm: "@ai-sdk/openai",
      name: "OpenAI",
      options: {
        baseURL: "https://api.openai.com/v1",
        apiKey: process.env.OPENAI_API_KEY ?? "",
      },
      models: { "gpt-4o": { name: "GPT-4o", limit: { context: 128000, output: 4096 } } },
    },
    // NVIDIA NIM — OpenAI-compatible. Enabled when NVIDIA_API_KEY is set.
    ...(process.env.NVIDIA_API_KEY
      ? {
          nvidia: {
            npm: "@ai-sdk/openai-compatible",
            name: "NVIDIA NIM",
            options: {
              baseURL: "https://integrate.api.nvidia.com/v1",
              apiKey: process.env.NVIDIA_API_KEY,
            },
            models: {},
          },
        }
      : {
          nvidia: {
            npm: "@ai-sdk/openai-compatible",
            name: "NVIDIA NIM",
            options: {
              baseURL: "https://integrate.api.nvidia.com/v1",
              apiKey: process.env.NVIDIA_API_KEY ?? "",
            },
            models: {},
          },
        }),
  },
}

let cached: MiraConfig | null = null

export async function loadConfig(cwd = process.cwd()): Promise<MiraConfig> {
  if (cached) return cached
  // Try mira.json, mira.jsonc, .mira/config.json
  const candidates = ["mira.json", "mira.jsonc", ".mira/config.json"]
  for (const name of candidates) {
    try {
      const file = Bun.file(`${cwd}/${name}`)
      if (await file.exists()) {
        const raw = await file.json() as Partial<MiraConfig>
        // Deep-merge object sections so a partial mira.json (e.g. {"permission":{"bash":"ask"}})
        // overrides only the keys it names — never wipes sibling defaults.
        function mergeSection<T>(base: T | undefined, override: T | undefined): T | undefined {
          if (override === undefined) return base
          if (base === undefined) return override
          if (typeof override !== "object" || override === null || Array.isArray(override)) return override
          if (typeof base !== "object" || base === null || Array.isArray(base)) return override
          return { ...(base as object), ...(override as object) } as T
        }
        cached = {
          ...DEFAULT_CONFIG,
          ...raw,
          permission: mergeSection(DEFAULT_CONFIG.permission, raw.permission) ?? DEFAULT_CONFIG.permission,
          mcp: mergeSection(DEFAULT_CONFIG.mcp, raw.mcp) ?? DEFAULT_CONFIG.mcp,
          provider: mergeSection(DEFAULT_CONFIG.provider, raw.provider) ?? DEFAULT_CONFIG.provider,
          loop: mergeSection(DEFAULT_CONFIG.loop, raw.loop),
          agents: mergeSection(DEFAULT_CONFIG.agents, raw.agents),
          guardrails: mergeSection(DEFAULT_CONFIG.guardrails, raw.guardrails),
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
function isPlainObject(v: PartialMiraConfig | MiraConfig | string | number | boolean | null): v is PartialMiraConfig {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function mergePartialMiraConfig(base: PartialMiraConfig, patch: PartialMiraConfig): PartialMiraConfig {
  const out: PartialMiraConfig = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    const prev = out[k as keyof PartialMiraConfig]
    if (isPlainObject(prev as PartialMiraConfig) && isPlainObject(v as PartialMiraConfig)) {
      out[k as keyof PartialMiraConfig] = mergePartialMiraConfig(prev as PartialMiraConfig, v as PartialMiraConfig) as never
    } else {
      out[k as keyof PartialMiraConfig] = v as never
    }
  }
  return out
}

// Zod schema for patch validation (mirrors shared/schemas/config.ts)
const miraConfigPatchSchema = z.object({
  model: z.string().min(1).optional(),
  smallModel: z.string().optional(),
  loop: z.object({
    maxSteps: z.number().int().positive().optional(),
    contextLimit: z.number().int().positive().optional(),
    compactionThreshold: z.number().min(0).max(1).optional(),
    smallModel: z.string().optional(),
  }).optional(),
  permission: z.record(z.string(), z.union([z.enum(["allow", "deny", "ask"]), z.record(z.string(), z.enum(["allow", "deny", "ask"]))])).optional(),
  guardrails: z.object({
    enforce: z.boolean().optional(),
    allowedRoots: z.array(z.string()).optional(),
    blockedPaths: z.array(z.string()).optional(),
    blockedCommands: z.array(z.string()).optional(),
    allowedCommands: z.array(z.string()).optional(),
    maxOutputBytes: z.number().int().positive().optional(),
    auditLogPath: z.string().optional(),
  }).optional(),
  mcp: z.record(z.string(), z.object({
    type: z.enum(["local", "remote"]),
    command: z.array(z.string()).optional(),
    url: z.string().optional(),
    enabled: z.boolean().optional(),
    env: z.record(z.string(), z.string()).optional(),
  })).optional(),
  provider: z.record(z.string(), z.object({
    npm: z.string().optional(),
    name: z.string().optional(),
    options: z.object({
      baseURL: z.string().optional(),
      apiKey: z.string().optional(),
    }).optional(),
    models: z.record(z.string(), z.object({
      name: z.string(),
      limit: z.object({ context: z.number(), output: z.number() }),
    })).optional(),
  })).optional(),
  agents: z.record(z.string(), z.object({
    system: z.string(),
    description: z.string().optional(),
    tools: z.array(z.string()).optional(),
    permissions: z.enum(["readonly", "standard", "elevated"]).optional(),
  })).optional(),
  theme: z.enum(["dark", "light", "system"]).optional(),
  debug: z.boolean().optional(),
}).passthrough()

/** Write patch to target layer file, deep-merge, invalidate cache. */
export async function saveConfig(
  patch: Partial<MiraConfig>,
  layer: "project" | "local" = "project",
  cwd = process.cwd(),
): Promise<MiraConfig> {
  const parsed = miraConfigPatchSchema.partial().parse(patch) as Partial<MiraConfig>
  const targetPath = layer === "local" ? `${cwd}/.mira/local.json` : `${cwd}/mira.json`
  // Ensure directory exists
  const dir = targetPath.slice(0, targetPath.lastIndexOf("/"))
  if (dir) {
    try {
      const { mkdir } = await import("node:fs/promises")
      await mkdir(dir, { recursive: true })
    } catch {}
  }
  let existing: PartialMiraConfig = {}
  try {
    const f = Bun.file(targetPath)
    if (await f.exists()) existing = (await f.json()) as PartialMiraConfig
  } catch {}
  const merged = mergePartialMiraConfig(existing, parsed)
  await Bun.write(targetPath, JSON.stringify(merged, null, 2) + "\n")
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
    await Bun.write(targetPath, JSON.stringify(existing, null, 2) + "\n")
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
    await Bun.write(targetPath, JSON.stringify(existing, null, 2) + "\n")
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
  layers.push({ source: "defaults", path: null, config: DEFAULT_CONFIG as Partial<MiraConfig> })
  // system
  try {
    const f = Bun.file("/etc/mira/mira.json")
    if (await f.exists()) layers.push({ source: "system", path: "/etc/mira/mira.json", config: (await f.json()) as Partial<MiraConfig> })
  } catch {}
  // global
  try {
    const home = process.env.HOME ?? ""
    if (home) {
      const p = `${home}/.mira/mira.json`
      const f = Bun.file(p)
      if (await f.exists()) layers.push({ source: "global", path: p, config: (await f.json()) as Partial<MiraConfig> })
    }
  } catch {}
  // project candidates
  for (const name of ["mira.json", "mira.jsonc", ".mira/config.json"]) {
    try {
      const p = `${cwd}/${name}`
      const f = Bun.file(p)
      if (await f.exists()) {
        layers.push({ source: "project", path: p, config: (await f.json()) as Partial<MiraConfig> })
        break
      }
    } catch {}
  }
  // local
  try {
    const p = `${cwd}/.mira/local.json`
    const f = Bun.file(p)
    if (await f.exists()) layers.push({ source: "local", path: p, config: (await f.json()) as Partial<MiraConfig> })
  } catch {}
  // env (synthetic)
  const envConfig: PartialMiraConfig = {}
  if (process.env.MIRA_MODEL) envConfig.model = process.env.MIRA_MODEL
  if (process.env.MIRA_SMALL_MODEL) envConfig.smallModel = process.env.MIRA_SMALL_MODEL
  if (Object.keys(envConfig).length) layers.push({ source: "env", path: null, config: envConfig })
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
  smallModel: "openrouter/deepseek/deepseek-v3.2-exp",
}

function parseContextLimitValue(raw: JsonValue | undefined): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw
  if (typeof raw === "string") {
    const s = raw.trim().toLowerCase()
    if (s.endsWith("k")) {
      const n = Number(s.slice(0, -1))
      if (Number.isFinite(n) && n > 0) return Math.round(n * 1000)
    }
    const n = Number(s)
    if (Number.isFinite(n) && n > 0) return n
  }
  return undefined
}

function numFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback
  const parsed = parseContextLimitValue(raw)
  return parsed ?? fallback
}

/**
 * Loop limits for SessionPrompt.runLoop.
 * Precedence: env var > mira.json `loop` section > built-in defaults.
 * Backward-compat: also reads legacy `loopLimits` key and string "128k" forms.
 */
export function getLoopLimits(): LoopLimits {
  const cfg = getConfig() as Record<string, JsonValue> & MiraConfig & { loopLimits?: Record<string, JsonValue> }
  const loopRaw = (cfg.loop ?? cfg.loopLimits ?? {}) as Record<string, JsonValue>
  const fileLoop = loopRaw as LoopLimits & Record<string, JsonValue>
  const numFromFile = (raw: JsonValue | undefined, fallback: number): number =>
    parseContextLimitValue(raw) ?? fallback
  const thresholdFromFile = (raw: JsonValue | undefined, fallback: number): number => {
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0 && raw <= 1) return raw
    if (typeof raw === "string") { const n = Number(raw); if (Number.isFinite(n) && n > 0 && n <= 1) return n }
    return fallback
  }
  return {
    maxSteps: numFromEnv(process.env.MIRA_MAX_STEPS, numFromFile(fileLoop.maxSteps, DEFAULT_LOOP_LIMITS.maxSteps)),
    contextLimit: numFromEnv(process.env.MIRA_CONTEXT_LIMIT, numFromFile(fileLoop.contextLimit, DEFAULT_LOOP_LIMITS.contextLimit)),
    compactionThreshold: numFromEnv(process.env.MIRA_COMPACTION_THRESHOLD, thresholdFromFile(fileLoop.compactionThreshold, DEFAULT_LOOP_LIMITS.compactionThreshold)),
    smallModel: process.env.MIRA_SMALL_MODEL ?? (fileLoop.smallModel as string | undefined) ?? getConfig().smallModel ?? DEFAULT_LOOP_LIMITS.smallModel,
  }
}

/** Build system prompt prefix: AGENTS.md + Skills + project context */
export async function buildSystemPrompt(cwd = process.cwd()): Promise<string> {
  const parts: string[] = [
    "You are Mira — a senior AI agent. Be concise, pragmatic, and thorough.",
    "Follow plan-first workflow: Explore → Plan → Implement → Verify.",
  ]
  for (const name of ["AGENTS.md", "CLAUDE.md", ".mira/instructions.md"]) {
    try {
      const f = Bun.file(`${cwd}/${name}`)
      if (await f.exists()) {
        const txt = await f.text()
        parts.push(`\n# Project Instructions (${name})\n${txt.slice(0, 8000)}`)
      }
    } catch {}
  }
  return parts.join("\n\n")
}
