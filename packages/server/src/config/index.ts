/**
 * Mira Config — Loads mira.json / opencode.jsonc + env fallbacks
 * Supports AGENTS.md / Skills injection into system prompt
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
        const raw = await file.json()
        cached = { ...DEFAULT_CONFIG, ...raw } as MiraConfig
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
