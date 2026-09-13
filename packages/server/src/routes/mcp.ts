import type { Hono, Context } from "hono"
import { z } from "zod"
import { saveConfig, removeMcpFromConfig, getConfig } from "../config/index.js"
import { sanitizePath } from "../guardrails/index.js"
import { searchMarketplace, getMarketplaceEntry } from "../mcp/marketplace.js"
import type { MCPManager } from "../mcp/index.js"
import type { MiraConfig } from "../types/index.js"
import type { JsonValue } from "../types/index.js"

const mcpCreateSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(["local", "remote"]),
  command: z.array(z.string().min(1)).min(1).optional(),
  url: z.string().url().optional(),
  enabled: z.boolean().optional(),
  env: z.record(z.string(), z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
}).superRefine((v, ctx) => {
  if (v.type === "local" && !v.command?.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["command"], message: "local type requires command[]" })
  if (v.type === "remote" && !v.url) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "remote type requires url" })
})
const mcpToggleSchema = z.object({ enabled: z.boolean() })

export function mountMcpRoutes(app: Hono<{ Variables: { requestId: string } }>, mcp: MCPManager) {
  app.get("/mcp", (c: Context) => c.json(mcp.listServers()))
  // ── MCP Marketplace discovery (P1-3) — static routes before /mcp/:name ──
  app.get("/mcp/marketplace", (c: Context) => {
    const rawQ = c.req.query("q") ?? ""
    if (rawQ.length > 100) return c.json({ error: "q too long (max 100)" }, 400)
    if (rawQ.includes("\0")) return c.json({ error: "invalid q" }, 400)
    // Validate via sanitizePath (rejects traversal / encoded traversal)
    if (rawQ.trim()) {
      const check = sanitizePath(rawQ.trim())
      if (!check.ok) return c.json({ error: `invalid q: ${check.reason}` }, 400)
    }
    const rawLimit = c.req.query("limit")
    let limit = 5
    if (rawLimit !== undefined) {
      const n = Number.parseInt(rawLimit, 10)
      if (!Number.isFinite(n) || n < 1 || n > 20) return c.json({ error: "limit must be 1-20" }, 400)
      limit = n
    }
    const servers = searchMarketplace(rawQ, limit)
    return c.json({ query: rawQ, count: servers.length, servers })
  })
  app.post("/mcp/marketplace/:name", async (c: Context) => {
    const rawName = c.req.param("name")
    if (!rawName) return c.json({ error: "not found" }, 404)
    const entry = getMarketplaceEntry(rawName)
    if (!entry) return c.json({ error: `marketplace server not found: ${rawName}` }, 404)
    try {
      const cfg: MiraConfig["mcp"][string] = {
        type: entry.type,
        ...(entry.command ? { command: entry.command } : {}),
        ...(entry.url ? { url: entry.url } : {}),
        enabled: true,
        ...(entry.env ? { env: entry.env } : {}),
        ...(entry.headers ? { headers: entry.headers } : {}),
      }
      const created = await mcp.addServer(entry.name, cfg)
      const current = getConfig().mcp ?? {}
      await saveConfig({ mcp: { ...current, [entry.name]: cfg } }, "project")
      return c.json(created, 201)
    } catch (e) {
      return c.json({ error: String(e) }, 400)
    }
  })
  app.post("/mcp", async (c: Context) => {
    const parsed = mcpCreateSchema.safeParse(await c.req.json().catch(() => null) as JsonValue)
    if (!parsed.success) return c.json({ error: "invalid mcp", issues: parsed.error.issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`) }, 400)
    const body = parsed.data
    try {
      const cfg: MiraConfig["mcp"][string] = {
        type: body.type,
        command: body.command,
        url: body.url,
        enabled: body.enabled ?? true,
        ...(body.env ? { env: body.env } : {}),
        ...(body.headers ? { headers: body.headers } : {}),
      }
      const entry = await mcp.addServer(body.name.trim(), cfg)
      const current = getConfig().mcp ?? {}
      await saveConfig({ mcp: { ...current, [body.name.trim()]: cfg } }, "project")
      return c.json(entry, 201)
    } catch (e) {
      return c.json({ error: String(e) }, 400)
    }
  })
  app.delete("/mcp/:name", async (c: Context) => {
    const rawName = c.req.param("name")
    if (!rawName) return c.json({ error: "not found" }, 404)
    const name = rawName
    try { await mcp.removeServer(name); await removeMcpFromConfig(name); return c.json({ ok: true }) } catch (e) { return c.json({ error: String(e) }, 404) }
  })
  app.patch("/mcp/:name", async (c: Context) => {
    const rawName = c.req.param("name")
    if (!rawName) return c.json({ error: "not found" }, 404)
    const name = rawName
    const parsed = mcpToggleSchema.safeParse(await c.req.json().catch(() => null) as JsonValue)
    if (!parsed.success) return c.json({ error: "invalid mcp toggle", issues: parsed.error.issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`) }, 400)
    try {
      const entry = await mcp.toggleServer(name, parsed.data.enabled)
      const current = getConfig().mcp ?? {}
      const existing = current[name]
      if (existing) await saveConfig({ mcp: { ...current, [name]: { ...existing, enabled: parsed.data.enabled } } }, "project")
      return c.json(entry)
    } catch (e) { return c.json({ error: String(e) }, 404) }
  })
  app.post("/mcp/:name/test", async (c: Context) => {
    const rawName = c.req.param("name")
    if (!rawName) return c.json({ error: "not found" }, 404)
    const name = rawName
    const result = await mcp.testServer(name)
    if (!result.ok && result.error?.includes("not found")) return c.json(result, 404)
    return c.json(result)
  })
}
