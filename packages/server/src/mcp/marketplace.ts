/**
 * MCP Marketplace registry — single source of truth for discovery.
 *
 * Backed by the curated list in `src/mcp/mcp-registry.json` (10 servers).
 * Both `GET /mcp/marketplace` (routes/mcp.ts) and the `mcp_marketplace_search`
 * tool (tools/mcp_marketplace.ts) search through this module so results stay
 * identical. Remote mcp.so fetch is a future extension — currently offline-only.
 */
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export type MarketplaceEntry = {
  name: string
  description: string
  type: "local" | "remote"
  command?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
  category: string
  stars?: number
}

export type MarketplaceResult = MarketplaceEntry & {
  /** mira.json `mcp` section snippet for one-click add */
  config: {
    type: "local" | "remote"
    command?: string[]
    url?: string
    enabled: boolean
    env?: Record<string, string>
    headers?: Record<string, string>
  }
  install_snippet: { mcp: Record<string, unknown> }
}

function fallbackRegistry(): MarketplaceEntry[] {
  return [
    { name: "filesystem", description: "File operations over a sandboxed root — list, read, write, search files", type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp"], category: "file", stars: 2100 },
    { name: "postgres", description: "Postgres read/query — expose tables, run SELECTs", type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"], env: { POSTGRES_CONNECTION_STRING: "{env:POSTGRES_CONNECTION_STRING}" }, category: "database", stars: 1800 },
    { name: "github", description: "GitHub API — repos, PRs, issues, search", type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "{env:GITHUB_PAT}" }, category: "vcs", stars: 2400 },
    { name: "brave-search", description: "Web search via Brave API", type: "local", command: ["npx", "-y", "@brave/brave-search-mcp-server"], env: { BRAVE_API_KEY: "{env:BRAVE_API_KEY}" }, category: "web", stars: 1200 },
    { name: "puppeteer", description: "Browser automation via Puppeteer (navigate, click, screenshot)", type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-puppeteer"], category: "browser", stars: 1600 },
    { name: "slack", description: "Slack workspace — messages, channels, search", type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-slack"], env: { SLACK_BOT_TOKEN: "{env:SLACK_BOT_TOKEN}", SLACK_TEAM_ID: "{env:SLACK_TEAM_ID}" }, category: "collab", stars: 1100 },
    { name: "memory", description: "Knowledge graph memory — persistent entities/relations", type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-memory"], category: "memory", stars: 1900 },
    { name: "fetch", description: "Fetch URL content (alternative to webfetch)", type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-fetch"], category: "web", stars: 1400 },
    { name: "sequential-thinking", description: "Structured reasoning — step-by-step thought chaining", type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-sequential-thinking"], category: "reasoning", stars: 1700 },
    { name: "firecrawl", description: "Firecrawl web scrape (already wired as example remote MCP)", type: "remote", url: "https://mcp.firecrawl.dev/mcp", category: "web", stars: 2500 },
  ]
}

let cache: MarketplaceEntry[] | null = null

export function loadMarketplaceRegistry(): MarketplaceEntry[] {
  if (cache) return cache
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    // Co-located curated list (committed) + legacy data-dir override (gitignored, runtime only)
    const candidates = [
      join(here, "mcp-registry.json"),
      join(here, "..", "..", "data", "mcp-registry.json"),
      join(process.cwd(), "packages", "server", "data", "mcp-registry.json"),
      join(process.cwd(), "data", "mcp-registry.json"),
    ]
    for (const p of candidates) {
      if (existsSync(p)) {
        const raw = JSON.parse(readFileSync(p, "utf-8")) as MarketplaceEntry[]
        if (Array.isArray(raw) && raw.length > 0) {
          cache = raw
          return cache
        }
      }
    }
  } catch {
    // fall through to embedded fallback
  }
  cache = fallbackRegistry()
  return cache
}

/** Clear the registry cache (tests). */
export function resetMarketplaceCache(): void {
  cache = null
}

function score(entry: MarketplaceEntry, q: string): number {
  const qq = q.toLowerCase()
  let s = 0
  if (entry.name.toLowerCase().includes(qq)) s += 10
  if (entry.description.toLowerCase().includes(qq)) s += 5
  if (entry.category.toLowerCase().includes(qq)) s += 7
  s += Math.log10((entry.stars ?? 100) + 1)
  return s
}

export function toMarketplaceResult(e: MarketplaceEntry): MarketplaceResult {
  const config: MarketplaceResult["config"] =
    e.type === "local"
      ? { type: "local", command: e.command, enabled: true, ...(e.env ? { env: e.env } : {}) }
      : { type: "remote", url: e.url, enabled: true, ...(e.headers ? { headers: e.headers } : {}) }
  return {
    ...e,
    config,
    install_snippet: { mcp: { [e.name]: config } },
  }
}

/** Search the curated registry. Empty query returns top entries by stars. */
export function searchMarketplace(query: string, limit = 5): MarketplaceResult[] {
  const entries = loadMarketplaceRegistry()
  const q = query.trim().toLowerCase()
  const capped = Math.min(Math.max(limit, 1), 20)
  if (!q) {
    return [...entries]
      .sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0))
      .slice(0, capped)
      .map(toMarketplaceResult)
  }
  return entries
    .map((e) => ({ e, s: score(e, q) }))
    .filter((x) => x.s > 1)
    .sort((a, b) => b.s - a.s)
    .slice(0, capped)
    .map(({ e }) => toMarketplaceResult(e))
}

/** Exact lookup by name (case-insensitive) for one-click add. */
export function getMarketplaceEntry(name: string): MarketplaceResult | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  const found = loadMarketplaceRegistry().find((e) => e.name.toLowerCase() === n)
  return found ? toMarketplaceResult(found) : null
}
