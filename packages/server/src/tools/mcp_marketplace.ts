/**
 * Tool: mcp_marketplace_search — Kilo K5 MCP Marketplace (discovery)
 *
 * Searches a curated registry of MCP servers and returns install snippets
 * for mira.json `mcp` section. The agent can then call `write`/`edit` or
 * `POST /config` to add the server; `GET /mcp` shows connection status.
 *
 * This is an offline registry (no network) — mirrors Kilo's Marketplace discover
 * but without external fetch; can be extended to fetch from mcp.so later.
 */
import { z } from "zod"
import type { ToolDef } from "./registry.js"
import { searchMarketplace } from "../mcp/marketplace.js"

const searchSchema = z.object({
  query: z.string().min(1).max(100).describe("Search term — e.g. postgres, github, browser, memory"),
  limit: z.number().int().min(1).max(20).optional().describe("Max results (default 5)"),
})

export const mcpMarketplaceTool = {
  name: "mcp_marketplace_search",
  description: "MCP Marketplace search (Kilo K5): discover MCP servers by keyword (postgres, github, browser, etc.) and get mira.json install snippets. After search, add the chosen entry to mira.json `mcp` via write/edit or PATCH /config, then check GET /mcp for connection status.",
  category: "other",
  schema: searchSchema,
  async execute({ query, limit = 5 }: { query: string; limit?: number }, _ctx: import("./registry.js").ToolContext) {
    // Shared curated registry (same source as GET /mcp/marketplace)
    const scored = searchMarketplace(query, limit).map((e) => ({
      name: e.name,
      description: e.description,
      type: e.type,
      command: e.command,
      url: e.url,
      env: e.env,
      category: e.category,
      config: e.config,
      install_snippet: e.install_snippet,
      hint: `Add to mira.json: ${JSON.stringify(e.type === "local" ? { [e.name]: { type: "local", command: e.command } } : { [e.name]: { type: "remote", url: e.url } })}; then GET /mcp to verify connected`,
    }))
    if (scored.length === 0) {
      return { query, results: [], hint: "No match — try broader terms: file, database, web, browser, memory, github" } as import("../types/index.js").JsonValue
    }
    return { query, results: scored, count: scored.length } as import("../types/index.js").JsonValue
  },
} satisfies ToolDef<typeof searchSchema>

export default mcpMarketplaceTool
export const tools = [mcpMarketplaceTool]
export const tool = mcpMarketplaceTool
