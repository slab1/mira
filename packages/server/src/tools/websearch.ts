/**
 * Tools: websearch, webfetch — Web capabilities
 * Provider-agnostic: uses Firecrawl if available, else fetch
 */
import { z } from "zod"
import type { ToolDef } from "./registry.js"

const websearchSchema = z.object({
  query: z.string().describe("Search query"),
  count: z.number().optional().describe("Number of results (default 5, max 10)"),
})

/** Loose view of provider result rows (Firecrawl/Tavily) — typing only, fields optional as providers vary. */
interface SearchRow {
  title?: string
  url?: string
  description?: string
  content?: string
  metadata?: { title?: string; description?: string }
}

export const websearchTool = {
  name: "websearch",
  description: "Search the web. Returns titles, URLs, snippets. Use webfetch to read full content of promising results.",
  category: "web",
  schema: websearchSchema,
  async execute({ query, count = 5 }, _ctx) {
    const count_ = Math.min(count, 10)
    // 1. Firecrawl (best quality)
    const firecrawlKey = process.env.FIRECRAWL_API_KEY
    if (firecrawlKey) {
      try {
        const res = await fetch("https://api.firecrawl.dev/v1/search", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${firecrawlKey}` },
          body: JSON.stringify({ query, limit: count_ }),
          signal: AbortSignal.timeout(20_000),
        })
        if (res.ok) {
          const data = await res.json() as { data?: SearchRow[]; results?: SearchRow[] }
          const results = (data.data ?? data.results ?? []).map(r => ({
            title: r.title ?? r.metadata?.title ?? r.url, url: r.url, snippet: r.description ?? r.metadata?.description ?? "",
          }))
          if (results.length) return { query, provider: "firecrawl", results }
        }
      } catch {}
    }
    // 2. Tavily
    const tavilyKey = process.env.TAVILY_API_KEY
    if (tavilyKey) {
      try {
        const res = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ api_key: tavilyKey, query, max_results: count_ }),
          signal: AbortSignal.timeout(20_000),
        })
        if (res.ok) {
          const data = await res.json() as { results?: SearchRow[] }
          const results = (data.results ?? []).map(r => ({ title: r.title, url: r.url, snippet: r.content ?? "" }))
          if (results.length) return { query, provider: "tavily", results }
        }
      } catch {}
    }
    // 3. Keyless fallback: DuckDuckGo HTML endpoint
    try {
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        headers: { "User-Agent": "Mira/0.1 (+https://mira.ai)" },
        signal: AbortSignal.timeout(15_000),
      })
      if (res.ok) {
        const html = await res.text()
        const results: Array<{ title: string; url: string; snippet: string }> = []
        const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
        let m: RegExpExecArray | null
        while ((m = re.exec(html)) && results.length < count_) {
          const strip = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').trim()
          let url = m[1]
          const uddg = url.match(/uddg=([^&]+)/)
          if (uddg) url = decodeURIComponent(uddg[1])
          results.push({ title: strip(m[2]), url, snippet: strip(m[3]) })
        }
        if (results.length) return { query, provider: "duckduckgo", results }
      }
    } catch {}
    // 4. All providers failed — say so honestly
    return {
      query,
      results: [],
      note: "No search provider available. Set FIRECRAWL_API_KEY or TAVILY_API_KEY for live results; DuckDuckGo fallback may be rate-limited.",
    }
  },
} satisfies ToolDef<typeof websearchSchema>

const webfetchSchema = z.object({
  url: z.string().url().describe("URL to fetch"),
  extract: z.enum(["markdown", "text", "html"]).optional().describe("Output format (default markdown)"),
  maxChars: z.number().optional().describe("Max chars (default 15000)"),
})

export const webfetchTool = {
  name: "webfetch",
  description: "Fetch a URL and extract main content as markdown. Handles redirects, 30s timeout.",
  category: "web",
  schema: webfetchSchema,
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
} satisfies ToolDef<typeof webfetchSchema>

export default websearchTool
export const tools = [websearchTool, webfetchTool]
export const tool = websearchTool
