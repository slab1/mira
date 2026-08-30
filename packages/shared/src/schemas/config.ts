/**
 * Mira Shared — 7-Layer Config Zod Schemas
 *
 * Layers (low → high priority, last wins):
 *   1. defaults   — hard-coded DEFAULT_CONFIG
 *   2. system     — /etc/mira/mira.json (machine-wide)
 *   3. global     — ~/.mira/mira.json (user-wide)
 *   4. project    — ./mira.json | ./mira.jsonc (repo)
 *   5. local      — ./.mira/local.json (gitignored, per-clone overrides)
 *   6. env        — MIRA_MODEL, OPENROUTER_API_KEY, etc. (process env)
 *   7. override   — CLI flags / runtime override (highest)
 *
 * Layered config + Mira specifics (model gateway, permission matrix).
 */
import { z } from "zod"

// ── Primitives ─────────────────────────────────────────────────────
export const permissionActionSchema = z.enum(["allow", "deny", "ask"])
export type PermissionAction = z.infer<typeof permissionActionSchema>

export const permissionValueSchema = z.union([
  permissionActionSchema,
  z.record(z.string(), permissionActionSchema),
])

export const mcpServerConfigSchema = z.object({
  type: z.enum(["local", "remote"]).describe("local=stdio, remote=http/sse"),
  command: z.array(z.string()).optional().describe("Command + args for local"),
  url: z.string().url().optional().describe("URL for remote"),
  enabled: z.boolean().default(true),
  env: z.record(z.string(), z.string()).optional(),
})
export type MCPServerConfig = z.infer<typeof mcpServerConfigSchema>

export const providerModelLimitSchema = z.object({
  context: z.number().int().positive(),
  output: z.number().int().positive(),
})

export const providerModelSchema = z.object({
  name: z.string(),
  limit: providerModelLimitSchema,
})

export const providerConfigSchema = z.object({
  npm: z.string().optional().describe("NPM package for provider SDK"),
  name: z.string().describe("Display name"),
  options: z.object({
    baseURL: z.string().describe("API base URL"),
    apiKey: z.string().describe("API key (may be empty → env fallback)"),
  }),
  models: z.record(z.string(), providerModelSchema).default({}),
})
export type ProviderConfig = z.infer<typeof providerConfigSchema>

export const loopConfigSchema = z.object({
  maxSteps: z.number().int().positive().optional(),
  contextLimit: z.number().int().positive().optional(),
  compactionThreshold: z.number().min(0).max(1).optional(),
  smallModel: z.string().optional(),
})
export type LoopConfig = z.infer<typeof loopConfigSchema>

export const agentDefinitionSchema = z.object({
  system: z.string(),
  description: z.string().optional(),
  tools: z.array(z.string()).optional(),
  permissions: z.enum(["readonly", "standard", "elevated"]).optional(),
  /** per-agent model override — enables Kilo-style cost routing (e.g. ask=flash, code=opus) */
  model: z.string().min(1).optional(),
})
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>

export const autoModelConfigSchema = z.object({
  enabled: z.boolean().optional(),
  tier: z.enum(["cheap", "balanced", "max"]).optional(),
})
export type AutoModelConfig = z.infer<typeof autoModelConfigSchema>

export const costCapConfigSchema = z.object({
  perTask: z.number().positive().optional(),
  perSession: z.number().positive().optional(),
})
export type CostCapConfig = z.infer<typeof costCapConfigSchema>

export const guardrailsConfigSchema = z.object({
  enforce: z.boolean().optional(),
  allowedRoots: z.array(z.string()).optional(),
  blockedPaths: z.array(z.string()).optional(),
  blockedCommands: z.array(z.string()).optional(),
  allowedCommands: z.array(z.string()).optional(),
  maxOutputBytes: z.number().int().positive().optional(),
  auditLogPath: z.string().optional(),
})
export type GuardrailsConfig = z.infer<typeof guardrailsConfigSchema>

// ── MiraConfig (layer payload) ─────────────────────────────────────
export const miraConfigSchema = z.object({
  /** Primary model ref: "provider/model-id" or "openrouter/anthropic/claude-sonnet-4" */
  model: z.string().min(1).default("openrouter/anthropic/claude-sonnet-4"),
  /** Cheap/fast model for subtasks */
  smallModel: z.string().optional(),
  /** Agentic loop limits */
  loop: loopConfigSchema.optional(),
  /** Permission matrix: tool → action | pattern → action (e.g. "bash:rm *": "deny") */
  permission: z.record(z.string(), permissionValueSchema).default({}),
  /** Guardrails */
  guardrails: guardrailsConfigSchema.optional(),
  /** MCP servers */
  mcp: z.record(z.string(), mcpServerConfigSchema).default({}),
  /** Provider registry (OpenRouter by default) */
  provider: z.record(z.string(), providerConfigSchema).default({}),
  /** Custom agent definitions */
  agents: z.record(z.string(), agentDefinitionSchema).optional(),
  /** Auto-model routing (Kilo K8: cheap/balanced/max) */
  autoModel: autoModelConfigSchema.optional(),
  /** Cost cap per task/session in USD (Kilo K8) */
  costCap: costCapConfigSchema.optional(),
  /** Optional: theme, debug, etc. */
  theme: z.enum(["dark", "light", "system"]).optional(),
  debug: z.boolean().optional(),
})
export type MiraConfig = z.infer<typeof miraConfigSchema>

// Partial version for layers that only override a subset
export const partialMiraConfigSchema = miraConfigSchema.partial()
export type PartialMiraConfig = z.infer<typeof partialMiraConfigSchema>

// ── 7 Layers ───────────────────────────────────────────────────────
export const configLayerNameSchema = z.enum([
  "defaults",
  "system",
  "global",
  "project",
  "local",
  "env",
  "override",
])
export type ConfigLayerName = z.infer<typeof configLayerNameSchema>

export const CONFIG_LAYERS: ConfigLayerName[] = [
  "defaults",
  "system",
  "global",
  "project",
  "local",
  "env",
  "override",
]

export const configLayerSchema = z.object({
  name: configLayerNameSchema,
  path: z.string().optional().describe("File path if file-backed"),
  config: partialMiraConfigSchema,
  priority: z.number().int().min(1).max(7),
})

export type ConfigLayer = z.infer<typeof configLayerSchema>

export const CONFIG_FILE_MAP: Record<ConfigLayerName, string | null> = {
  defaults: null,
  system: "/etc/mira/mira.json",
  global: "~/.mira/mira.json",
  project: "mira.json", // also tries mira.jsonc, .mira/config.json
  local: ".mira/local.json",
  env: null,
  override: null,
}

// ── Env mapping ────────────────────────────────────────────────────
export const envToConfigMap: Record<string, string> = {
  MIRA_MODEL: "model",
  MIRA_SMALL_MODEL: "smallModel",
  OPENROUTER_API_KEY: "provider.openrouter.options.apiKey",
  ANTHROPIC_API_KEY: "provider.anthropic.options.apiKey",
  OPENAI_API_KEY: "provider.openai.options.apiKey",
}

/** Parse env vars into a partial config (layer 6). Pure — no process access required if env passed. */
export function parseEnvConfig(env: Record<string, string | undefined> = {}): PartialMiraConfig {
  const out: PartialMiraConfig = {}
  // Direct mappings
  if (env.MIRA_MODEL) out.model = env.MIRA_MODEL
  if (env.MIRA_SMALL_MODEL) out.smallModel = env.MIRA_SMALL_MODEL
  // Provider keys → ensure provider record shape via zod safeParse later
  // Keep minimal: just apiKey injection; full provider is merged in applyLayers
  return out
}

// ── Merge ──────────────────────────────────────────────────────────
export function isPlainObject(v: PartialMiraConfig | MiraConfig | string | number | boolean | null): v is PartialMiraConfig {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** Deep merge: arrays replaced, objects merged, primitives last-wins. Used for layer stacking. */
export function mergeConfigs<T extends PartialMiraConfig>(base: T, patch: Partial<T>): T {
  const out: PartialMiraConfig = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    const prev = out[k as keyof PartialMiraConfig]
    if (isPlainObject(prev as PartialMiraConfig) && isPlainObject(v as PartialMiraConfig)) {
      out[k as keyof PartialMiraConfig] = mergeConfigs(prev as PartialMiraConfig, v as PartialMiraConfig) as never
    } else {
      out[k as keyof PartialMiraConfig] = v as never
    }
  }
  return out as T
}

/** Apply all 7 layers in order → final MiraConfig (validated). */
export function applyLayers(layers: PartialMiraConfig[]): MiraConfig {
  // Start from defaults (layer 1) parsed via zod for defaults
  let acc = miraConfigSchema.parse({}) as MiraConfig
  for (const layer of layers) {
    acc = mergeConfigs(acc, layer)
  }
  // Re-validate final
  return miraConfigSchema.parse(acc)
}

// ── Default config (layer 1) ───────────────────────────────────────
export const DEFAULT_CONFIG: MiraConfig = miraConfigSchema.parse({
  model: "openrouter/anthropic/claude-sonnet-4",
  smallModel: "openrouter/deepseek/deepseek-v3.2-exp",
  permission: {
    bash: "ask",
    read: "allow",
    glob: "allow",
    grep: "allow",
    write: "ask",
    edit: "ask",
    todowrite: "ask",
    webfetch: "allow",
    websearch: "allow",
  },
  mcp: {},
  provider: {
    openrouter: {
      npm: "@ai-sdk/openai-compatible",
      name: "OpenRouter",
      options: {
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: "",
      },
      models: {},
    },
  },
})
