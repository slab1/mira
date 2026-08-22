/**
 * Mira Shared — 7-Layer Config Zod Schemas
 *
 * Layers (low → high priority, last wins):
 *   1. defaults   — hard-coded DEFAULT_CONFIG
 *   2. system     — /etc/mira/mira.json (machine-wide)
 *   3. global     — ~/.mira/mira.json (user-wide)
 *   4. project    — ./mira.json | ./mira.jsonc | ./opencode.jsonc (repo)
 *   5. local      — ./.mira/local.json (gitignored, per-clone overrides)
 *   6. env        — MIRA_MODEL, OPENROUTER_API_KEY, etc. (process env)
 *   7. override   — CLI flags / runtime override (highest)
 *
 * Mirrors opencode layered config + adds Mira specifics (model gateway, permission matrix).
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

// ── MiraConfig (layer payload) ─────────────────────────────────────
export const miraConfigSchema = z.object({
  /** Primary model ref: "provider/model-id" or "openrouter/anthropic/claude-sonnet-4" */
  model: z.string().min(1).default("openrouter/anthropic/claude-sonnet-4"),
  /** Cheap/fast model for subtasks */
  smallModel: z.string().optional(),
  /** Permission matrix: tool → action | pattern → action (e.g. "bash:rm *": "deny") */
  permission: z.record(z.string(), permissionValueSchema).default({}),
  /** MCP servers */
  mcp: z.record(z.string(), mcpServerConfigSchema).default({}),
  /** Provider registry (OpenRouter by default) */
  provider: z.record(z.string(), providerConfigSchema).default({}),
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
  project: "mira.json", // also tries mira.jsonc, opencode.jsonc, .mira/config.json
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
  const out: Record<string, unknown> = {}
  // Direct mappings
  if (env.MIRA_MODEL) out.model = env.MIRA_MODEL
  if (env.MIRA_SMALL_MODEL) out.smallModel = env.MIRA_SMALL_MODEL
  // Provider keys → ensure provider record shape via zod safeParse later
  // Keep minimal: just apiKey injection; full provider is merged in applyLayers
  return out as PartialMiraConfig
}

// ── Merge ──────────────────────────────────────────────────────────
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** Deep merge: arrays replaced, objects merged, primitives last-wins. Used for layer stacking. */
export function mergeConfigs<T extends Record<string, unknown>>(base: T, patch: Partial<T>): T {
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === undefined) continue
    const prev = out[k]
    if (isPlainObject(prev) && isPlainObject(v)) {
      out[k] = mergeConfigs(prev as Record<string, unknown>, v as Record<string, unknown>)
    } else {
      out[k] = v
    }
  }
  return out as T
}

/** Apply all 7 layers in order → final MiraConfig (validated). */
export function applyLayers(layers: PartialMiraConfig[]): MiraConfig {
  // Start from defaults (layer 1) parsed via zod for defaults
  let acc = miraConfigSchema.parse({}) as MiraConfig
  for (const layer of layers) {
    acc = mergeConfigs(acc as unknown as Record<string, unknown>, layer as Record<string, unknown>) as unknown as MiraConfig
  }
  // Re-validate final
  return miraConfigSchema.parse(acc)
}

// ── Default config (layer 1) ───────────────────────────────────────
export const DEFAULT_CONFIG: MiraConfig = miraConfigSchema.parse({
  model: "openrouter/anthropic/claude-sonnet-4",
  smallModel: "openrouter/deepseek/deepseek-v3.2-exp",
  permission: {
    bash: "allow",
    read: "allow",
    glob: "allow",
    grep: "allow",
    write: "allow",
    edit: "allow",
    todowrite: "allow",
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
