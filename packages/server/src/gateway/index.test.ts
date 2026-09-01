import { describe, test, expect } from "bun:test"
import type { MiraConfig } from "../types/index.js"
import { createGateway } from "./index.js"

function minimalConfig(provider: Record<string, { baseURL: string; apiKey: string }>): MiraConfig {
  const p: MiraConfig["provider"] = {}
  for (const [k, v] of Object.entries(provider)) {
    p[k] = { npm: "@ai-sdk/openai-compatible", name: k, options: v, models: {} }
  }
  return {
    model: "claude-sonnet-4",
    smallModel: "deepseek/deepseek-v3.2-exp",
    permission: {},
    mcp: {},
    provider: p,
  } as MiraConfig
}

describe("gateway provider routing (provider-neutral, NOT openrouter-default)", () => {
  test("providerStatus picks the FIRST provider with a key, not openrouter", () => {
    const g = createGateway(minimalConfig({
      anthropic: { baseURL: "https://api.anthropic.com", apiKey: "sk-ant-test" },
      openai: { baseURL: "https://api.openai.com", apiKey: "" },
    }))
    const st = g.providerStatus()
    expect(st.provider).toBe("anthropic")
    expect(st.hasKey).toBe(true)
    expect(st.hasOpenRouterKey).toBe(false)
  })

  test("openrouter still becomes active when it has the only key", () => {
    const g = createGateway(minimalConfig({
      openrouter: { baseURL: "https://openrouter.ai/api/v1", apiKey: "sk-or-test" },
    }))
    expect(g.providerStatus().provider).toBe("openrouter")
    expect(g.providerStatus().hasOpenRouterKey).toBe(true)
  })

  test("no keyed provider → hasKey false, provider is first configured", () => {
    const g = createGateway(minimalConfig({
      anthropic: { baseURL: "https://api.anthropic.com", apiKey: "" },
      nvidia: { baseURL: "https://integrate.api.nvidia.com/v1", apiKey: "" },
    }))
    const st = g.providerStatus()
    expect(st.hasKey).toBe(false)
    expect(st.provider).toBe("anthropic")
    expect(st.providerCount).toBe(2)
  })

  test("listModels with a keyed provider does not return an openrouter stub", async () => {
    // No live network: with an anthropic key but unreachable base, listModels must
    // return [] (honest), NOT a fabricated openrouter model.
    const g = createGateway(minimalConfig({
      anthropic: { baseURL: "https://invalid.invalid", apiKey: "sk-ant-test" },
    }))
    const models = await g.listModels()
    expect(Array.isArray(models)).toBe(true)
    expect(models.some(m => m.id.includes("openrouter") || m.id.includes("stub"))).toBe(false)
  })

  test("listModels with NO key returns empty (onboarding state), not a stub", async () => {
    const g = createGateway(minimalConfig({
      openrouter: { baseURL: "https://openrouter.ai/api/v1", apiKey: "" },
    }))
    const models = await g.listModels()
    expect(models).toEqual([])
  })

  test("expandEnv resolves {env:VAR} placeholders before key detection", () => {
    process.env.MIRA_TEST_KEY = "sk-env-expanded"
    const g = createGateway(minimalConfig({
      anthropic: { baseURL: "https://api.anthropic.com", apiKey: "{env:MIRA_TEST_KEY}" },
    }))
    expect(g.providerStatus().provider).toBe("anthropic")
    expect(g.providerStatus().hasKey).toBe(true)
    delete process.env.MIRA_TEST_KEY
  })
})
