/**
 * Tools: websearch, webfetch, deep_research — Live Web & Grounded Research Capabilities
 * Uses Firecrawl / Tavily / Gemini Google Search grounding (`gemini-4-hydrogen`)
 * / DuckDuckGo fallback, plus sanitized Markdown extraction.
 */
import { z } from 'zod'
import { GoogleGenAI } from '@google/genai'
import type { ToolDef } from './registry.js'
import { sanitizeResearchContent } from '../evolution/research.js'
import { readMiraEnv } from '../providers/auth.js'
import { getConfig } from '../config/index.js'

const websearchSchema = z.object({
  query: z.string().describe('Search query'),
  count: z.number().optional().describe('Number of results (default 5, max 10)'),
})

interface SearchRow {
  title?: string
  url?: string
  description?: string
  content?: string
  metadata?: { title?: string; description?: string }
}

const invalidGeminiKeys = new Set<string>()

function isUsableGeminiApiKey(value: string | undefined | null): boolean {
  if (!value || typeof value !== 'string') return false
  const t = value.trim()
  return Boolean(t && t !== '***' && !t.includes('{env:') && !t.startsWith('AQ.') && !invalidGeminiKeys.has(t))
}

function resolveGeminiSearchKey(): string {
  const envMap = readMiraEnv()
  const cands = [
    process.env.GEMINI_API_KEY,
    process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    process.env.GOOGLE_API_KEY,
    envMap.GEMINI_API_KEY,
    envMap.GOOGLE_GENERATIVE_AI_API_KEY,
    envMap.GOOGLE_API_KEY,
  ]
  for (const c of cands) {
    if (isUsableGeminiApiKey(c)) return c!.trim()
  }
  try {
    const raw = getConfig().provider?.google?.options?.apiKey
    const pick = Array.isArray(raw) ? raw.find(Boolean) : raw
    if (isUsableGeminiApiKey(pick)) return pick!.trim()
  } catch {}
  return ''
}

export const websearchTool = {
  name: 'websearch',
  description:
    'Search the live web using Firecrawl, Tavily, Gemini Google Search grounding, or DuckDuckGo. Returns titles, URLs, and sanitized snippets.',
  category: 'web',
  schema: websearchSchema,
  async execute({ query, count = 5 }, _ctx) {
    const count_ = Math.min(count, 10)
    // 1. Firecrawl
    const firecrawlKey = process.env.FIRECRAWL_API_KEY
    if (firecrawlKey) {
      try {
        const res = await fetch('https://api.firecrawl.dev/v1/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${firecrawlKey}` },
          body: JSON.stringify({ query, limit: count_ }),
          signal: AbortSignal.timeout(20_000),
        })
        if (res.ok) {
          const data = (await res.json()) as { data?: SearchRow[]; results?: SearchRow[] }
          const results = (data.data ?? data.results ?? []).map((r) => ({
            title: r.title ?? r.metadata?.title ?? r.url,
            url: r.url,
            snippet: sanitizeResearchContent(r.description ?? r.metadata?.description ?? ''),
          }))
          if (results.length) return { query, provider: 'firecrawl', results }
        }
      } catch {}
    }
    // 2. Tavily
    const tavilyKey = process.env.TAVILY_API_KEY
    if (tavilyKey) {
      try {
        const res = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: tavilyKey, query, max_results: count_ }),
          signal: AbortSignal.timeout(20_000),
        })
        if (res.ok) {
          const data = (await res.json()) as { results?: SearchRow[] }
          const results = (data.results ?? []).map((r) => ({
            title: r.title,
            url: r.url,
            snippet: sanitizeResearchContent(r.content ?? ''),
          }))
          if (results.length) return { query, provider: 'tavily', results }
        }
      } catch {}
    }
    // 3. Gemini Live Google Search Grounding (server-side)
    const geminiKey = resolveGeminiSearchKey()
    if (geminiKey) {
      try {
        const ai = new GoogleGenAI({
          apiKey: geminiKey,
          httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
        })
        const resp = await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: `Search the web and summarize key verifiable facts for: ${query}`,
          config: { tools: [{ googleSearch: {} }] },
        })
        const chunks = resp.candidates?.[0]?.groundingMetadata?.groundingChunks ?? []
        const results = chunks
          .filter((c) => Boolean(c?.web?.uri))
          .slice(0, count_)
          .map((c) => ({
            title: c.web?.title ?? c.web?.uri ?? 'Web Source',
            url: c.web?.uri ?? '',
            snippet: '',
          }))
        if (results.length || resp.text) {
          return {
            query,
            provider: 'gemini-google-search',
            summary: sanitizeResearchContent(resp.text ?? ''),
            results,
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (/API_KEY_INVALID|API key not valid|PERMISSION_DENIED|403|401/i.test(msg)) {
          invalidGeminiKeys.add(geminiKey)
        }
      }
    }
    // 4. Keyless fallback: DuckDuckGo HTML endpoint
    try {
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        headers: { 'User-Agent': 'Mira/0.1 (+https://mira.ai)' },
        signal: AbortSignal.timeout(15_000),
      })
      if (res.ok) {
        const html = await res.text()
        const results: Array<{ title: string; url: string; snippet: string }> = []
        const re =
          /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
        let m: RegExpExecArray | null
        while ((m = re.exec(html)) && results.length < count_) {
          const strip = (s: string) =>
            s
              .replace(/<[^>]+>/g, '')
              .replace(/&amp;/g, '&')
              .replace(/&#x27;/g, "'")
              .replace(/&quot;/g, '"')
              .trim()
          let url = m[1]
          const uddg = url.match(/uddg=([^&]+)/)
          if (uddg) url = decodeURIComponent(uddg[1])
          results.push({
            title: strip(m[2]),
            url,
            snippet: sanitizeResearchContent(strip(m[3])),
          })
        }
        if (results.length) return { query, provider: 'duckduckgo', results }
      }
    } catch {}
    return {
      query,
      results: [],
      note: 'No live search provider succeeded. Set GEMINI_API_KEY, FIRECRAWL_API_KEY, or TAVILY_API_KEY for reliable online search.',
    }
  },
} satisfies ToolDef<typeof websearchSchema>

const webfetchSchema = z.object({
  url: z.string().url().describe('URL to fetch'),
  extract: z.enum(['markdown', 'text', 'html']).optional().describe('Output format (default markdown)'),
  maxChars: z.number().optional().describe('Max chars (default 15000)'),
  sanitize: z.boolean().optional().describe('Strip untrusted injection patterns (default true)'),
})

function htmlToReadableMarkdown(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl, inner) => `\n${'#'.repeat(Number(lvl))} ${inner.replace(/<[^>]+>/g, '').trim()}\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) => `\n- ${inner.replace(/<[^>]+>/g, '').trim()}`)
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, inner) => `\n${inner.replace(/<[^>]+>/g, '').trim()}\n`)
    .replace(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => `[${label.replace(/<[^>]+>/g, '').trim()}](${href})`)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export const webfetchTool = {
  name: 'webfetch',
  description:
    'Fetch a URL and extract readable markdown/text content safely through the research trust boundary.',
  category: 'web',
  schema: webfetchSchema,
  async execute({ url, extract = 'markdown', maxChars = 15000, sanitize = true }, _ctx) {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mira/0.1 (+https://mira.ai)' },
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText} for ${url}`)
    const html = await res.text()
    let extracted =
      extract === 'html'
        ? html
        : extract === 'text'
          ? html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
          : htmlToReadableMarkdown(html)
    if (sanitize) extracted = sanitizeResearchContent(extracted)
    return {
      url,
      status: res.status,
      length: extracted.length,
      sanitized: sanitize,
      content: extracted.slice(0, maxChars),
    }
  },
} satisfies ToolDef<typeof webfetchSchema>

const deepResearchSchema = z.object({
  query: z.string().describe('Detailed research question or comparison goal'),
  queries: z.array(z.string()).optional().describe('Optional 2-4 sub-queries to investigate in parallel'),
})

export const deepResearchTool = {
  name: 'deep_research',
  description:
    'Run a multi-source online investigation with Google Search grounding / live websearch, sanitize findings through the trust boundary, and return a cited dossier.',
  category: 'web',
  schema: deepResearchSchema,
  async execute({ query, queries }, ctx) {
    const subQueries =
      queries && queries.length > 0
        ? queries.slice(0, 4)
        : [query, `${query} architecture tradeoffs 2026`, `${query} limitations pitfalls`]
    const outputs = await Promise.all(
      subQueries.map((q) => websearchTool.execute({ query: q, count: 5 }, ctx)),
    )
    const citations: Array<{ title: string; url: string; provider: string }> = []
    const seen = new Set<string>()
    const summaries: string[] = []
    for (const out of outputs) {
      const o = out as {
        query?: string
        provider?: string
        summary?: string
        results?: Array<{ title?: string; url?: string; snippet?: string }>
      }
      if (o.summary) summaries.push(`### ${o.query}\n${o.summary}`)
      for (const r of o.results ?? []) {
        if (r.url && !seen.has(r.url)) {
          seen.add(r.url)
          citations.push({ title: r.title ?? r.url, url: r.url, provider: o.provider ?? 'web' })
        }
        if (!o.summary && r.snippet) {
          summaries.push(`- **${r.title ?? r.url}** (${r.url}): ${r.snippet}`)
        }
      }
    }
    return {
      query,
      subQueries,
      citationCount: citations.length,
      citations,
      dossier: summaries.join('\n\n'),
    }
  },
} satisfies ToolDef<typeof deepResearchSchema>

export default websearchTool
export const tools = [websearchTool, webfetchTool, deepResearchTool]
export const tool = websearchTool
