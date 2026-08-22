/**
 * Tools: websearch, webfetch — Web capabilities
 * Provider-agnostic: uses Firecrawl if available, else fetch
 */
import { z } from "zod"
import type { ToolDef } from "./registry.js"

export const websearchTool: ToolDef = {
  name: "websearch",
  description: "Search the web. Returns titles, URLs, snippets. Use webfetch to read full content of promising results.",
  category: "web",
  schema: z.object({
    query: z.string().describe("Search query"),
    count: z.number().optional().describe("Number of results (default 5, max 10)"),
  }),
  async execute({ query, count = 5 }, _ctx) {
    // In production: call Firecrawl / Tavily / Brave API
    // Minimal stub: use fetch to a search API if configured
    const apiKey = process.env.FIRECRAWL_API_KEY
    if (apiKey) {
      const res = await fetch("https://api.firecrawl.dev/v1/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ query, limit: count }),
      })
      if (res.ok) return res.json()
    }
    // Fallback: DuckDuckGo via fetch (no key) — placeholder
    return {
      query,
      results: [{ title: "(websearch stub — configure FIRECRAWL_API_KEY for real results)", url: "https://example.com", snippet: "Set FIRECRAWL_API_KEY in env." }],
      note: "Configure FIRECRAWL_API_KEY or TAVILY_API_KEY for live search.",
    }
  },
}

export const webfetchTool: ToolDef = {
  name: "webfetch",
  description: "Fetch a URL and extract main content as markdown. Handles redirects, 30s timeout.",
  category: "web",
  schema: z.object({
    url: z.string().url().describe("URL to fetch"),
    extract: z.enum(["markdown", "text", "html"]).optional().describe("Output format (default markdown)"),
    maxChars: z.number().optional().describe("Max chars (default 15000)"),
  }),
  async execute({ url, maxChars = 15000 }, _ctx) {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mira/0.1 (+https://mira.ai)" },
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText} for ${url}`)
    const html = await res.text()
    // Minimal markdown extraction (strip tags) — in prod use Turndown / Firecrawl scrape
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxChars)
    return { url, content: text, truncated: html.length > maxChars }
  },
}

export default websearchTool
export const tools = [websearchTool, webfetchTool]
export const tool = websearchTool
