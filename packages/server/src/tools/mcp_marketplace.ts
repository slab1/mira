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

type RegistryEntry = {
  name: string
  description: string
  type: "local" | "remote"
  command?: string[]
  url?: string
  env?: Record<string, string>
  stars?: number
  category: string
}

const REGISTRY: RegistryEntry[] = [
  {
    name: "filesystem",
    description: "File operations over a sandboxed root — list, read, write, search files",
    type: "local",
    command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    category: "file",
    stars: 2100,
  },
  {
    name: "postgres",
    description: "Postgres read/query — expose tables, run SELECTs",
    type: "local",
    command: ["npx", "-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"],
    env: { POSTGRES_CONNECTION_STRING: "{env:POSTGRES_CONNECTION_STRING}" },
    category: "database",
    stars: 1800,
  },
  {
    name: "github",
    description: "GitHub API — repos, PRs, issues, search",
    type: "local",
    command: ["npx", "-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "{env:GITHUB_PAT}" },
    category: "vcs",
    stars: 2400,
  },
  {
    name: "brave-search",
    description: "Web search via Brave API",
    type: "local",
    command: ["npx", "-y", "@brave/brave-search-mcp-server"],
    env: { BRAVE_API_KEY: "{env:BRAVE_API_KEY}" },
    category: "web",
    stars: 1200,
  },
  {
    name: "puppeteer",
    description: "Browser automation via Puppeteer (navigate, click, screenshot)",
    type: "local",
    command: ["npx", "-y", "@modelcontextprotocol/server-puppeteer"],
    category: "browser",
    stars: 1600,
  },
  {
    name: "slack",
    description: "Slack workspace — messages, channels, search",
    type: "local",
    command: ["npx", "-y", "@modelcontextprotocol/server-slack"],
    env: { SLACK_BOT_TOKEN: "{env:SLACK_BOT_TOKEN}", SLACK_TEAM_ID: "{env:SLACK_TEAM_ID}" },
    category: "collab",
    stars: 1100,
  },
  {
    name: "memory",
    description: "Knowledge graph memory — persistent entities/relations",
    type: "local",
    command: ["npx", "-y", "@modelcontextprotocol/server-memory"],
    category: "memory",
    stars: 1900,
  },
  {
    name: "fetch",
    description: "Fetch URL content (alternative to webfetch)",
    type: "local",
    command: ["npx", "-y", "@modelcontextprotocol/server-fetch"],
    category: "web",
    stars: 1400,
  },
  {
    name: "sequential-thinking",
    description: "Structured reasoning — step-by-step thought chaining",
    type: "local",
    command: ["npx", "-y", "@modelcontextprotocol/server-sequential-thinking"],
    category: "reasoning",
    stars: 1700,
  },
  {
    name: "firecrawl",
    description: "Firecrawl web scrape (already wired as example remote MCP)",
    type: "remote",
    url: "https://mcp.firecrawl.dev/mcp",
    category: "web",
    stars: 2500,
  },
]

const searchSchema = z.object({
  query: z.string().min(1).max(100).describe("Search term — e.g. postgres, github, browser, memory"),
  limit: z.number().int().min(1).max(20).optional().describe("Max results (default 5)"),
})

function score(entry: RegistryEntry, q: string): number {
  const qq = q.toLowerCase()
  let s = 0
  if (entry.name.toLowerCase().includes(qq)) s += 10
  if (entry.description.toLowerCase().includes(qq)) s += 5
  if (entry.category.toLowerCase().includes(qq)) s += 7
  // boost popular
  s += Math.log10((entry.stars ?? 100) + 1)
  return s
}

export const mcpMarketplaceTool = {
  name: "mcp_marketplace_search",
  description: "MCP Marketplace search (Kilo K5): discover MCP servers by keyword (postgres, github, browser, etc.) and get mira.json install snippets. After search, add the chosen entry to mira.json `mcp` via write/edit or PATCH /config, then check GET /mcp for connection status.",
  category: "other",
  schema: searchSchema,
  async execute({ query, limit = 5 }: { query: string; limit?: number }, _ctx: import("./registry.js").ToolContext) {
    const scored = REGISTRY.map(e => ({ e, s: score(e, query) }))
      .filter(x => x.s > 1) // filter weak matches
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map(({ e }) => ({
        name: e.name,
        description: e.description,
        type: e.type,
        command: e.command,
        url: e.url,
        env: e.env,
        category: e.category,
        install_snippet: e.type === "local"
          ? { mcp: { [e.name]: { type: "local", command: e.command, enabled: true, ...(e.env ? { env: e.env } : {}) } } }
          : { mcp: { [e.name]: { type: "remote", url: e.url, enabled: true } } },
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
