import type { Hono } from "hono"
import { getConfig, getConfigLayers, saveConfig, removeProviderFromConfig } from "../config/index.js"
import type { MiraConfig, JsonValue } from "../types/index.js"
import type { Context } from "hono"

function expandEnv(value: string): string {
  if (!value) return value
  return value.replace(/\{env:([^}]+)\}/g, (_, name: string) => process.env[name] ?? "")
}
function maskApiKey(key: string): string {
  if (!key) return ""
  if (key.length <= 4) return "***"
  return `${key.slice(0, 3)}***${key.slice(-4)}`
}
function redactConfig<T extends MiraConfig | import("../types/index.js").MiraConfig>(cfg: T): T {
  const out = JSON.parse(JSON.stringify(cfg)) as T
  const providers = (out as MiraConfig).provider as Record<string, { options?: { apiKey?: string } }> | undefined
  if (providers && typeof providers === "object") {
    for (const p of Object.values(providers)) {
      const opts = p.options
      if (opts && typeof opts.apiKey === "string" && opts.apiKey) opts.apiKey = "***"
    }
  }
  return out
}
function redactLayers(layers: Array<{ source: string; path: string | null; config: import("../types/index.js").MiraConfig }>) {
  return layers.map(l => ({ ...l, config: redactConfig(l.config as MiraConfig) }))
}

export function mountConfigRoutes(app: Hono<{ Variables: { requestId: string } }>) {
  app.get("/config", async (c: Context) => {
    const { merged, layers } = await getConfigLayers()
// @ts-ignore
    return c.json({ merged: redactConfig(merged), layers: redactLayers(layers as JsonValue as Array<{ source: string; path: string | null; config: MiraConfig }>) })
  })
  app.patch("/config", async (c: Context) => {
    const body = await c.req.json().catch(() => null) as JsonValue as Record<string, JsonValue>
    // Use shared schema validation via saveConfig
    try {
      const layer = (body as Record<string, JsonValue>)?.layer === "local" ? "local" : "project"
      const merged = await saveConfig((body as Record<string, JsonValue>).patch as Partial<MiraConfig>, layer)
      return c.json({ merged: redactConfig(merged) })
    } catch (e) {
      return c.json({ error: String(e) }, 400)
    }
  })
  app.get("/config/schema", async (c: Context) => {
    try {
      const mod = await import("zod-to-json-schema" as string).catch(() => null) as JsonValue as { zodToJsonSchema?: (s: JsonValue) => JsonValue } | null
      if (mod?.zodToJsonSchema) {
        const configModule = await import("../config/index.js").catch(() => ({ miraConfigSchema: null })) as JsonValue as { miraConfigSchema?: JsonValue }
        let schema = (configModule as Record<string, JsonValue>).miraConfigSchema ?? null
        if (!schema) {
          try {
// @ts-ignore
            const shared = await import("../../../shared/src/schemas/config.js") as JsonValue as Record<string, JsonValue>
            schema = (shared as Record<string, JsonValue>).miraConfigSchema ?? null
          } catch {}
        }
        if (schema) return c.json(mod.zodToJsonSchema(schema))
      }
    } catch {}
    return c.json({
      type: "object",
      properties: {
        model: { type: "string", description: "Primary model ref" },
        smallModel: { type: "string" },
        loop: { type: "object", properties: { maxSteps: { type: "number" }, contextLimit: { type: "number" }, compactionThreshold: { type: "number" }, smallModel: { type: "string" } } },
        permission: { type: "object", description: "Permission matrix" },
        guardrails: { type: "object" },
        mcp: { type: "object", description: "MCP servers" },
        provider: { type: "object", description: "Provider registry" },
        agents: { type: "object" },
        theme: { type: "string", enum: ["dark", "light", "system"] },
        debug: { type: "boolean" },
      },
    })
  })
  app.get("/providers", async (c: Context) => {
    const cfg = getConfig() as MiraConfig
    const providers = (cfg as MiraConfig).provider ?? {}
    const list = Object.entries(providers).map(([id, p]) => {
      const prov = p as MiraConfig["provider"][string]
      const rawKey = (prov as { options?: { apiKey?: string } }).options?.apiKey ?? ""
      const apiKey = expandEnv(rawKey)
      const rawBase = (prov as { options?: { baseURL?: string } }).options?.baseURL ?? ""
      return { id, name: (prov as { name?: string }).name ?? id, hasKey: !!apiKey, masked: apiKey ? maskApiKey(apiKey) : "", baseURL: expandEnv(rawBase), rawBaseURL: rawBase, modelCount: (prov as { models?: Record<string, JsonValue> }).models ? Object.keys((prov as { models: Record<string, JsonValue> }).models).length : 0 }
    })
    return c.json(list)
  })
  app.post("/providers/:id/test", async (c: Context) => {
    const id = c.req.param("id")
    const cfg = getConfig() as MiraConfig
// @ts-ignore
    const prov = (cfg as MiraConfig).provider?.[id] as MiraConfig["provider"][string] | undefined
    if (!prov) return c.json({ ok: false, error: "provider not found" }, 404)
    const apiKey = expandEnv((prov as { options?: { apiKey?: string } }).options?.apiKey ?? "")
    if (!apiKey) return c.json({ ok: false, error: "missing apiKey (check {env:VAR} + mira.env)" }, 400)
    const baseURL = expandEnv((prov as { options?: { baseURL?: string } }).options?.baseURL ?? "")
    if (baseURL) {
      try { const controller = new AbortController(); const t = setTimeout(() => controller.abort(), 3000); await fetch(baseURL, { method: "HEAD", signal: controller.signal }).catch(() => {}); clearTimeout(t) } catch {}
    }
    return c.json({ ok: true, hasKey: !!apiKey, baseURL, expanded: true })
  })
  app.post("/provider/:id/test", async (c: Context) => {
    const id = c.req.param("id")
    const cfg = getConfig() as MiraConfig
// @ts-ignore
    const prov = (cfg as MiraConfig).provider?.[id] as MiraConfig["provider"][string] | undefined
    if (!prov) return c.json({ ok: false, error: "provider not found" }, 404)
    const apiKey = expandEnv((prov as { options?: { apiKey?: string } }).options?.apiKey ?? "")
    if (!apiKey) return c.json({ ok: false, error: "missing apiKey (check {env:VAR} + mira.env)" }, 400)
    const baseURL = expandEnv((prov as { options?: { baseURL?: string } }).options?.baseURL ?? "")
    if (baseURL) {
      try { const controller = new AbortController(); const t = setTimeout(() => controller.abort(), 3000); await fetch(baseURL, { method: "HEAD", signal: controller.signal }).catch(() => {}); clearTimeout(t) } catch {}
    }
    return c.json({ ok: true, hasKey: !!apiKey, baseURL, expanded: true })
  })
  app.delete("/providers/:id", async (c: Context) => {
    const id = c.req.param("id")
    const cfg = getConfig() as MiraConfig
// @ts-ignore
    if (!(cfg as MiraConfig).provider?.[id]) return c.json({ error: "provider not found" }, 404)
// @ts-ignore
    await removeProviderFromConfig(id)
    return c.json({ ok: true })
  })
  app.delete("/provider/:id", async (c: Context) => {
    const id = c.req.param("id")
    const cfg = getConfig() as MiraConfig
// @ts-ignore
    if (!(cfg as MiraConfig).provider?.[id]) return c.json({ error: "provider not found" }, 404)
// @ts-ignore
    await removeProviderFromConfig(id)
    return c.json({ ok: true })
  })
}
