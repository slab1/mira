import type { Hono } from "hono"
import { getConfig, getConfigLayers, saveConfig, removeProviderFromConfig } from "../config/index.js"
import type { MiraConfig } from "../types/index.js"

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
  return layers.map(l => ({ ...l, config: redactConfig(l.config as any) }))
}

export function mountConfigRoutes(app: Hono<any>) {
  app.get("/config", async c => {
    const { merged, layers } = await getConfigLayers()
    return c.json({ merged: redactConfig(merged), layers: redactLayers(layers as any) })
  })
  app.patch("/config", async c => {
    const body = await c.req.json().catch(() => null) as any
    // Use shared schema validation via saveConfig
    try {
      const layer = body?.layer === "local" ? "local" : "project"
      const merged = await saveConfig(body.patch as any, layer)
      return c.json({ merged: redactConfig(merged) })
    } catch (e) {
      return c.json({ error: String(e) }, 400)
    }
  })
  app.get("/config/schema", async c => {
    try {
      const mod = await import("zod-to-json-schema" as string).catch(() => null) as any
      if (mod?.zodToJsonSchema) {
        const configModule = await import("../config/index.js").catch(() => ({ miraConfigSchema: null })) as any
        let schema = configModule.miraConfigSchema ?? null
        if (!schema) {
          try {
            const shared = await import("../../../shared/src/schemas/config.js") as any
            schema = shared.miraConfigSchema ?? null
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
  app.get("/providers", async c => {
    const cfg = getConfig()
    const providers = (cfg as any).provider ?? {}
    const list = Object.entries(providers).map(([id, p]: any) => {
      const rawKey = p.options?.apiKey ?? ""
      const apiKey = expandEnv(rawKey)
      const rawBase = p.options?.baseURL ?? ""
      return { id, name: p.name ?? id, hasKey: !!apiKey, masked: apiKey ? maskApiKey(apiKey) : "", baseURL: expandEnv(rawBase), rawBaseURL: rawBase, modelCount: p.models ? Object.keys(p.models).length : 0 }
    })
    return c.json(list)
  })
  app.post("/providers/:id/test", async c => {
    const id = c.req.param("id")
    const cfg: any = getConfig()
    const prov = cfg.provider?.[id] as any
    if (!prov) return c.json({ ok: false, error: "provider not found" }, 404)
    const apiKey = expandEnv(prov.options?.apiKey ?? "")
    if (!apiKey) return c.json({ ok: false, error: "missing apiKey (check {env:VAR} + mira.env)" }, 400)
    const baseURL = expandEnv(prov.options?.baseURL ?? "")
    if (baseURL) {
      try { const controller = new AbortController(); const t = setTimeout(() => controller.abort(), 3000); await fetch(baseURL, { method: "HEAD", signal: controller.signal }).catch(() => {}); clearTimeout(t) } catch {}
    }
    return c.json({ ok: true, hasKey: !!apiKey, baseURL, expanded: true })
  })
  app.post("/provider/:id/test", async c => {
    const id = c.req.param("id")
    const cfg: any = getConfig()
    const prov = cfg.provider?.[id] as any
    if (!prov) return c.json({ ok: false, error: "provider not found" }, 404)
    const apiKey = expandEnv(prov.options?.apiKey ?? "")
    if (!apiKey) return c.json({ ok: false, error: "missing apiKey (check {env:VAR} + mira.env)" }, 400)
    const baseURL = expandEnv(prov.options?.baseURL ?? "")
    if (baseURL) {
      try { const controller = new AbortController(); const t = setTimeout(() => controller.abort(), 3000); await fetch(baseURL, { method: "HEAD", signal: controller.signal }).catch(() => {}); clearTimeout(t) } catch {}
    }
    return c.json({ ok: true, hasKey: !!apiKey, baseURL, expanded: true })
  })
  app.delete("/providers/:id", async c => {
    const id = c.req.param("id")
    const cfg: any = getConfig()
    if (!cfg.provider?.[id]) return c.json({ error: "provider not found" }, 404)
    await removeProviderFromConfig(id)
    return c.json({ ok: true })
  })
  app.delete("/provider/:id", async c => {
    const id = c.req.param("id")
    const cfg: any = getConfig()
    if (!cfg.provider?.[id]) return c.json({ error: "provider not found" }, 404)
    await removeProviderFromConfig(id)
    return c.json({ ok: true })
  })
}
