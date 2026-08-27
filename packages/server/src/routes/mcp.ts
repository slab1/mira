import type { Hono, Context } from "hono"
import { z } from "zod"
import { saveConfig, removeMcpFromConfig, getConfig } from "../config/index.js"
import type { MCPManager } from "../mcp/index.js"
import type { JsonValue, MiraConfig } from "../types/index.js"

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
  app.get("/mcp", (c: Context) => c.json(mcp.listServers() as JsonValue))
  app.post("/mcp", async (c: Context) => {
    const parsed = mcpCreateSchema.safeParse(await c.req.json().catch(() => null) as JsonValue)
// @ts-ignore
    if (!parsed.success) return c.json({ error: "invalid mcp", issues: parsed.error.issues.map((i: { path: (string|number)[]; message: string }) => `${i.path.join(".")}: ${i.message}`) }, 400)
    const body = parsed.data
    try {
// @ts-ignore
      const cfg = { type: body.type, command: body.command, url: body.url, enabled: body.enabled ?? true, env: body.env, headers: body.headers } as JsonValue as MiraConfig["mcp"][string]
      const entry = await mcp.addServer(body.name.trim(), cfg)
// @ts-ignore
      const current = (getConfig() as JsonValue as MiraConfig).mcp ?? {}
// @ts-ignore
      await saveConfig({ mcp: { ...current, [body.name.trim()]: cfg } } as JsonValue as Partial<MiraConfig>, "project")
// @ts-ignore
      return c.json(entry as JsonValue, 201)
    } catch (e) {
      return c.json({ error: String(e) }, 400)
    }
  })
  app.delete("/mcp/:name", async (c: Context) => {
    const name = c.req.param("name")
// @ts-ignore
    try { await mcp.removeServer(name); await removeMcpFromConfig(name); return c.json({ ok: true }) } catch (e) { return c.json({ error: String(e) }, 404) }
  })
  app.patch("/mcp/:name", async (c: Context) => {
    const name = c.req.param("name")
    const parsed = mcpToggleSchema.safeParse(await c.req.json().catch(() => null) as JsonValue)
// @ts-ignore
    if (!parsed.success) return c.json({ error: "invalid mcp toggle", issues: parsed.error.issues.map((i: { path: (string|number)[]; message: string }) => `${i.path.join(".")}: ${i.message}`) }, 400)
    try {
// @ts-ignore
      const entry = await mcp.toggleServer(name, parsed.data.enabled)
// @ts-ignore
      const current = (getConfig() as JsonValue as MiraConfig).mcp ?? {}
// @ts-ignore
      const existing = (current as Record<string, JsonValue>)[name] as JsonValue as MiraConfig["mcp"][string] | undefined
// @ts-ignore
      if (existing) await saveConfig({ mcp: { ...current, [name]: { ...existing as object, enabled: parsed.data.enabled } } } as JsonValue as Partial<MiraConfig>, "project")
// @ts-ignore
      return c.json(entry as JsonValue)
    } catch (e) { return c.json({ error: String(e) }, 404) }
  })
  app.post("/mcp/:name/test", async (c: Context) => {
    const name = c.req.param("name")
// @ts-ignore
    const result = await mcp.testServer(name)
    if (!result.ok && result.error?.includes("not found")) return c.json(result as JsonValue, 404)
    return c.json(result as JsonValue)
  })
}
