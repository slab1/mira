import type { Hono } from "hono"
import { getConfig, getConfigLayers, saveConfig, removeProviderFromConfig, mergeModelCatalog } from "../config/index.js"
import type { MiraConfig, JsonValue, ProviderConfig } from "../types/index.js"
import type { Gateway } from "../gateway/index.js"
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

export function mountConfigRoutes(app: Hono<{ Variables: { requestId: string } }>, deps: { gateway?: Gateway } = {}) {
  /**
   * One-time curated-catalog import on connect: when a provider first gets a key and
   * its registry is still empty, pull the live catalog (~top-50) into config.
   * Curated defaults (anthropic/openai) are never overwritten. Never deletes.
   */
  async function maybeSeedCatalog(id: string): Promise<void> {
    try {
      const cfg = getConfig() as MiraConfig
      const prov = cfg.provider?.[id]
      if (!prov) return
      if (prov.models && Object.keys(prov.models).length > 0) return
      if (!deps.gateway?.listProviderModels) return
      // Bounded: never let a hung provider /models fetch stall a connect
      const live = await Promise.race([
        deps.gateway.listProviderModels(id),
        new Promise<null>(resolve => setTimeout(() => resolve(null), 2000)),
      ])
      if (!live || !live.length) return
      const incoming = live.map(m => ({
        // registry keys are BARE ids — strip the `provider/` prefix live fetches add
        id: m.id.startsWith(`${id}/`) ? m.id.slice(id.length + 1) : m.id,
        name: m.name,
        limit: m.context ? { context: m.context, output: 4096 } : undefined,
      }))
      const { models, result } = mergeModelCatalog(prov.models ?? {}, incoming)
      await saveConfig({ provider: { [id]: { models } } } as Partial<MiraConfig>, "project")
      console.log(`[config] auto-seed ${id}: added=${result.added.length} updated=${result.updated.length}`)
    } catch (e) {
      console.warn(`[config] auto-seed ${id} skipped:`, String(e))
    }
  }
  app.get("/config", async (c: Context) => {
    const { merged, layers } = await getConfigLayers()
    return c.json({ merged: redactConfig(merged), layers: redactLayers(layers as Array<{ source: string; path: string | null; config: MiraConfig }>) })
  })
  app.patch("/config", async (c: Context) => {
    const body = await c.req.json().catch(() => null) as Record<string, JsonValue>
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
      const mod = await import("zod-to-json-schema" as string).catch(() => null) as { zodToJsonSchema?: (s: JsonValue) => JsonValue } | null
        if (mod?.zodToJsonSchema) {
        const configModule = await import("../config/index.js").catch(() => ({ miraConfigSchema: null })) as { miraConfigSchema?: JsonValue }
        let schema = configModule.miraConfigSchema ?? null
        if (!schema) {
          try {
            // @ts-expect-error — Zod schema is not JsonValue; runtime shape is JSON-serializable
            const shared = await import("../../../shared/src/schemas/config.js") as { miraConfigSchema?: JsonValue }
            const maybeSchema = shared.miraConfigSchema as JsonValue | undefined
            schema = maybeSchema ?? null
          } catch {}
        }
        // @ts-expect-error — zodToJsonSchema expects ZodType, not JsonValue; runtime call is correct
        if (schema) return c.json((mod as { zodToJsonSchema: (s: JsonValue) => JsonValue }).zodToJsonSchema(schema))
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
      return { id, name: (prov as { name?: string }).name ?? id, hasKey: !!apiKey, masked: apiKey ? maskApiKey(apiKey) : "", baseURL: expandEnv(rawBase), rawBaseURL: rawBase, modelCount: (prov as ProviderConfig).models ? Object.keys((prov as ProviderConfig).models).length : 0 }
    })
    return c.json(list)
  })
  app.post("/providers/:id/test", async (c: Context) => {
    const id = c.req.param("id")
    if (!id) return c.json({ ok: false, error: "provider not found" }, 404)
    const cfg = getConfig() as MiraConfig
    const prov = cfg.provider[id] as ProviderConfig | undefined
    if (!prov) return c.json({ ok: false, error: "provider not found" }, 404)
    const apiKey = expandEnv((prov as { options?: { apiKey?: string } }).options?.apiKey ?? "")
    if (!apiKey) return c.json({ ok: false, error: "missing apiKey (check {env:VAR} + mira.env)" }, 400)
    const baseURL = expandEnv((prov as { options?: { baseURL?: string } }).options?.baseURL ?? "")
if (baseURL) {
    try { const controller = new AbortController(); const t = setTimeout(() => controller.abort(), 3000); await fetch(baseURL, { method: "HEAD", signal: controller.signal }).catch(() => {}); clearTimeout(t) } catch {}
  }
  // First connect with a key → import the curated catalog in the background
  // (bounded internally; never blocks or fails the connect response)
  void maybeSeedCatalog(id)
  return c.json({ ok: true, hasKey: !!apiKey, baseURL, expanded: true })
  })
  app.post("/provider/:id/test", async (c: Context) => {
    const id = c.req.param("id")
    if (!id) return c.json({ ok: false, error: "provider not found" }, 404)
    const cfg = getConfig() as MiraConfig
    const prov = cfg.provider[id] as ProviderConfig | undefined
    if (!prov) return c.json({ ok: false, error: "provider not found" }, 404)
    const apiKey = expandEnv((prov as { options?: { apiKey?: string } }).options?.apiKey ?? "")
    if (!apiKey) return c.json({ ok: false, error: "missing apiKey (check {env:VAR} + mira.env)" }, 400)
    const baseURL = expandEnv((prov as { options?: { baseURL?: string } }).options?.baseURL ?? "")
if (baseURL) {
    try { const controller = new AbortController(); const t = setTimeout(() => controller.abort(), 3000); await fetch(baseURL, { method: "HEAD", signal: controller.signal }).catch(() => {}); clearTimeout(t) } catch {}
  }
  // First connect with a key → import the curated catalog in the background
  // (bounded internally; never blocks or fails the connect response)
  void maybeSeedCatalog(id)
  return c.json({ ok: true, hasKey: !!apiKey, baseURL, expanded: true })
  })
  app.delete("/providers/:id", async (c: Context) => {
    const id = c.req.param("id")
    if (!id) return c.json({ error: "provider not found" }, 404)
    const cfg = getConfig() as MiraConfig
    if (!(cfg.provider[id])) return c.json({ error: "provider not found" }, 404)
    await removeProviderFromConfig(id as string)
    return c.json({ ok: true })
  })
  app.delete("/provider/:id", async (c: Context) => {
    const id = c.req.param("id")
    if (!id) return c.json({ error: "provider not found" }, 404)
    const cfg = getConfig() as MiraConfig
    if (!(cfg.provider[id])) return c.json({ error: "provider not found" }, 404)
    await removeProviderFromConfig(id as string)
    return c.json({ ok: true })
  })
}
