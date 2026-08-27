import type { Hono } from "hono"
import { z } from "zod"
import { saveConfig, removeMcpFromConfig, getConfig } from "../config/index.js"
import type { MCPManager } from "../mcp/index.js"

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

export function mountMcpRoutes(app: Hono<any>, mcp: MCPManager) {
  app.get("/mcp", c => c.json(mcp.listServers()))
  app.post("/mcp", async c => {
    const parsed = mcpCreateSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: "invalid mcp", issues: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`) }, 400)
    const body = parsed.data
    try {
      const cfg = { type: body.type, command: body.command, url: body.url, enabled: body.enabled ?? true, env: body.env, headers: body.headers } as any
      const entry = await mcp.addServer(body.name.trim(), cfg)
      const current: any = (getConfig() as any).mcp ?? {}
      await saveConfig({ mcp: { ...current, [body.name.trim()]: cfg } } as any, "project")
      return c.json(entry, 201)
    } catch (e) {
      return c.json({ error: String(e) }, 400)
    }
  })
  app.delete("/mcp/:name", async c => {
    const name = c.req.param("name")
    try { await mcp.removeServer(name); await removeMcpFromConfig(name); return c.json({ ok: true }) } catch (e) { return c.json({ error: String(e) }, 404) }
  })
  app.patch("/mcp/:name", async c => {
    const name = c.req.param("name")
    const parsed = mcpToggleSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: "invalid mcp toggle", issues: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`) }, 400)
    try {
      const entry = await mcp.toggleServer(name, parsed.data.enabled)
      const current: any = (getConfig() as any).mcp ?? {}
      const existing = current[name]
      if (existing) await saveConfig({ mcp: { ...current, [name]: { ...existing, enabled: parsed.data.enabled } } } as any, "project")
      return c.json(entry)
    } catch (e) { return c.json({ error: String(e) }, 404) }
  })
  app.post("/mcp/:name/test", async c => {
    const name = c.req.param("name")
    const result = await mcp.testServer(name)
    if (!result.ok && result.error?.includes("not found")) return c.json(result, 404)
    return c.json(result)
  })
}
