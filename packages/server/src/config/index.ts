/**
 * Mira Config — Loads mira.json / opencode.jsonc + env fallbacks
 * Injects AGENTS.md project instructions into the system prompt.
 * (Skills + todos injection happens per-turn in SessionPrompt.loadContext.)
 */
import type { MiraConfig } from "../types/index.js"

const DEFAULT_CONFIG: MiraConfig = {
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
        apiKey: process.env.OPENROUTER_API_KEY ?? "",
      },
      models: {},
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
      : {}),
  },
}

let cached: MiraConfig | null = null

export async function loadConfig(cwd = process.cwd()): Promise<MiraConfig> {
  if (cached) return cached
  // Try mira.json, opencode.jsonc, .mira/config.json
  const candidates = ["mira.json", "mira.jsonc", "opencode.jsonc", ".mira/config.json"]
  for (const name of candidates) {
    try {
      const file = Bun.file(`${cwd}/${name}`)
      if (await file.exists()) {
        const raw = await file.json() as Partial<MiraConfig>
        // Deep-merge object sections so a partial mira.json (e.g. {"permission":{"bash":"ask"}})
        // overrides only the keys it names — never wipes sibling defaults.
        const mergeSection = <T extends Record<string, unknown>>(base: T | undefined, override: unknown): T => {
          if (!override || typeof override !== "object" || Array.isArray(override)) return { ...(base ?? {}) as T }
          return { ...((base ?? {}) as T), ...(override as T) }
        }
        cached = {
          ...DEFAULT_CONFIG,
          ...raw,
          permission: mergeSection(DEFAULT_CONFIG.permission, raw.permission),
          mcp: mergeSection(DEFAULT_CONFIG.mcp, raw.mcp),
          provider: mergeSection(DEFAULT_CONFIG.provider, raw.provider),
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

function numFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * Loop limits for SessionPrompt.runLoop.
 * Precedence: env var > mira.json `loop` section > built-in defaults.
 */
export function getLoopLimits(): LoopLimits {
  const fileLoop = getConfig().loop ?? {}
  const numFromFile = (raw: number | undefined, fallback: number): number =>
    typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : fallback
  return {
    maxSteps: numFromEnv(process.env.MIRA_MAX_STEPS, numFromFile(fileLoop.maxSteps, DEFAULT_LOOP_LIMITS.maxSteps)),
    contextLimit: numFromEnv(process.env.MIRA_CONTEXT_LIMIT, numFromFile(fileLoop.contextLimit, DEFAULT_LOOP_LIMITS.contextLimit)),
    compactionThreshold: numFromEnv(process.env.MIRA_COMPACTION_THRESHOLD, numFromFile(fileLoop.compactionThreshold, DEFAULT_LOOP_LIMITS.compactionThreshold)),
    smallModel: process.env.MIRA_SMALL_MODEL ?? fileLoop.smallModel ?? getConfig().smallModel ?? DEFAULT_LOOP_LIMITS.smallModel,
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
