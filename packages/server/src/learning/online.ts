/**
 * Mira Online Learning — Web Search & Research
 *
 * Searches the web for new AI agent techniques, papers, tools, docs and
 * GitHub repos, then extracts structured insights. Designed as the "eyes"
 * of Mira's self-learning system.
 *
 * Tools used (in priority order):
 *   1. Firecrawl (FIRECRAWL_API_KEY) — highest quality scrape + search
 *   2. Tavily   (TAVILY_API_KEY)     — fallback search
 *   3. Native fetch + HTML→text     — always available
 *
 * Inspiration: Project Aether RCSI logic_evolve.py — online pillar is now
 * first-class instead of implicit.
 *
 * Usage:
 *   const learner = new OnlineLearner({ bus, db })
 *   const insights = await learner.learnOnce()
 *   // or scheduled: scheduler calls learner.learnOnce() hourly
 */

import type { Bus } from '../bus/index.js'
import type { MiraDB } from '../storage/db.js'
import type { Gateway } from '../gateway/index.js'
import type { UsageAnalysis } from './usage.js'
import { createHash } from 'node:crypto'

// ── Types ────────────────────────────────────────────────────────────

export interface SearchResult {
  title: string
  url: string
  snippet: string
  score?: number
  publishedAt?: string
}

export interface FetchedDoc {
  url: string
  title?: string
  markdown: string
  truncated: boolean
}

export interface Insight {
  id: string
  source: string // url
  sourceTitle: string
  category: InsightCategory
  summary: string // 1-2 sentence distillation
  pattern: string // reusable pattern / technique
  relevance: number // 0..1
  tags: string[]
  rawExcerpt: string // grounding excerpt (<=500 chars)
  createdAt: number
}

export type InsightCategory =
  | 'agent-technique'
  | 'research-paper'
  | 'tool'
  | 'documentation'
  | 'github-repo'
  | 'eval-method'
  | 'other'

export interface OnlineLearnerConfig {
  /** max search queries per cycle (default 6) */
  maxQueries?: number
  /** max docs to fetch per cycle (default 8) */
  maxDocs?: number
  /** max chars per fetched doc (default 12_000) */
  maxChars?: number
  /** reuse firecrawl_search / websearch tool shape if injected; category hints route to */
  searchFn?: (
    query: string,
    count: number,
    ctx?: { category?: InsightCategory },
  ) => Promise<SearchResult[]>
  fetchFn?: (url: string) => Promise<FetchedDoc | null>
}

export interface OnlineLearnerDeps {
  bus?: Bus
  db?: MiraDB
  /** When provided, extraction uses the LLM and falls back to the heuristic path on error. */
  gateway?: Gateway
}

// ── Default query bank (rotated each cycle) ────────────────────────

export const DEFAULT_TOPICS: Array<{ query: string; category: InsightCategory }> = [
  {
    query: 'AI agent orchestration framework 2026 Vercel AI SDK LangGraph',
    category: 'agent-technique',
  },
  { query: 'LLM agent tool use improvement technique 2026', category: 'agent-technique' },
  { query: 'arxiv AI agent reasoning memory benchmark', category: 'research-paper' },
  { query: 'MCP model context protocol new servers tools 2026', category: 'tool' },
  { query: 'agent evaluation harness Braintrust Langfuse 2026', category: 'eval-method' },
  { query: 'github awesome AI agents framework trending', category: 'github-repo' },
  { query: 'Claude Mira Cursor agent best practices 2026', category: 'documentation' },
  {
    query: 'agent memory architecture Mem0 Zep pgvector hybrid retrieval',
    category: 'agent-technique',
  },
]

// ── OnlineLearner ────────────────────────────────────────────────────

export class OnlineLearner {
  private config: Required<OnlineLearnerConfig>

  constructor(
    private deps: OnlineLearnerDeps = {},
    config: OnlineLearnerConfig = {},
  ) {
    this.config = {
      maxQueries: config.maxQueries ?? 6,
      maxDocs: config.maxDocs ?? 8,
      maxChars: config.maxChars ?? 12_000,
      searchFn: config.searchFn ?? createDefaultSearchFn(),
      fetchFn: config.fetchFn ?? createDefaultFetchFn(),
    } as Required<OnlineLearnerConfig>
  }

  // ── Privacy safeguards ─────────────────────────────────────────────
  private redactInsightText(text: string): string {
    return text
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
      .replace(/\+?\d{1,3}[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, '[REDACTED_PHONE]')
      .replace(
        /(api[_-]?key|token|secret|password)\s*[:=]\s*["']?([^\s"']+)["']?/gi,
        '$1=[REDACTED]',
      )
  }

  /**
   * One learning cycle: search → fetch → extract insights
   * Returns insights (also publishes `learning.online.insights` on the bus
   * and persists to episodic memory if db is available).
   */
  async learnOnce(topics = DEFAULT_TOPICS): Promise<Insight[]> {
    const picked = pickTopics(topics, this.config.maxQueries)
    this.log(`online: searching ${picked.length} topics...`)

    // 1. Search — category hints route to the best free provider (arXiv/GitHub/HN) below
    const allResults: Array<SearchResult & { category: InsightCategory }> = []
    for (const t of picked) {
      try {
        const results = await this.config.searchFn(t.query, 5, { category: t.category })
        for (const r of results.slice(0, 3)) allResults.push({ ...r, category: t.category })
      } catch (err) {
        this.log(`search failed for "${t.query}": ${String(err)}`)
      }
    }
    // Deduplicate by URL (within-run)
    const seen = new Set<string>()
    const deduped = allResults
      .filter((r) => {
        if (seen.has(r.url)) return false
        seen.add(r.url)
        return true
      })
      .slice(0, this.config.maxDocs)

    if (deduped.length === 0) {
      this.log('online: no search results — skipping fetch')
      return []
    }
    this.log(`online: ${deduped.length} unique URLs → fetching...`)

    // 2. Fetch (respect the >200-char noise floor)
    const docs: Array<FetchedDoc & { category: InsightCategory; snippet: string; title: string }> =
      []
    for (const r of deduped) {
      try {
        const doc = await this.config.fetchFn(r.url)
        if (doc && doc.markdown.length > 200) {
          docs.push({
            ...doc,
            category: r.category,
            snippet: r.snippet,
            title: r.title ?? doc.title ?? r.url,
          })
        }
      } catch (err) {
        this.log(`fetch failed ${r.url}: ${String(err)}`)
      }
    }
    this.log(`online: fetched ${docs.length}/${deduped.length} docs`)

    // 2b. Heading-aware chunking: split long docs into their best sections so
    // extraction sees substance rather than front-matter (intro/nav/TOC).
    const chunkedDocs = docs.flatMap((d) => chunkDocByHeading(d))

    // 3. Extract insights — LLM when a gateway is wired (and actually has a key), else heuristic
    let insights: Insight[]
    if (this.deps.gateway) {
      try {
        insights = await this.extractWithLLM(chunkedDocs, this.deps.gateway)
      } catch {
        insights = this.extractInsights(chunkedDocs)
      }
    } else {
      insights = this.extractInsights(chunkedDocs)
    }
    this.log(`online: extracted ${insights.length} insights`)

    // 4. Privacy safeguard: redact PII from insights before persistence
    const redactedInsights = insights.map((i) => ({
      ...i,
      summary: this.redactInsightText(i.summary),
      rawExcerpt: this.redactInsightText(i.rawExcerpt),
    }))

    // 5. Persist + publish (best-effort)
    if (this.deps.db) await this.persistInsights(redactedInsights).catch(() => {})
    this.deps.bus?.publish({
      type: 'learning.updated',
      payload: {
        kind: 'learning.online.insights',
        count: redactedInsights.length,
        insights: redactedInsights.slice(0, 5),
      },
      timestamp: Date.now(),
    })

    return redactedInsights
  }

  /**
   * Extract structured insights from fetched docs.
   * Heuristic (no LLM needed for the base layer): score by keyword
   * density + dedupe by pattern. When a gateway is available, callers
   * can override with LLM-based extraction via `extractWithLLM()`.
   */
  extractInsights(
    docs: Array<FetchedDoc & { category: InsightCategory; snippet?: string; title?: string }>,
  ): Insight[] {
    const insights: Insight[] = []
    for (const doc of docs) {
      const excerpt = doc.markdown.slice(0, 500).replace(/\s+/g, ' ').trim()
      const tags = extractTags(doc.markdown, doc.title ?? '')
      const relevance = scoreRelevance(doc.markdown, doc.category)
      // Skip low-signal docs
      if (relevance < 0.25) continue

      insights.push({
        // Deterministic ID: same (url + pattern) across runs collapses to the
        // same id → INSERT OR IGNORE in persistInsights() dedupes cross-cycle.
        id: `ins_${createHash('sha256')
          .update(`${doc.url}::${extractPattern(doc.markdown, doc.category)}`)
          .digest('hex')
          .slice(0, 12)}`,
        source: doc.url,
        sourceTitle: doc.title ?? doc.url,
        category: doc.category,
        summary: summarizeHeuristic(doc.markdown, doc.title),
        pattern: extractPattern(doc.markdown, doc.category),
        relevance,
        tags,
        rawExcerpt: excerpt,
        createdAt: Date.now(),
      })
    }
    // Sort by relevance desc, dedupe by pattern Jaccard similarity (≥55% token
    // overlap = same technique; stable on short extracted strings).
    insights.sort((a, b) => b.relevance - a.relevance)
    const kept: Insight[] = []
    for (const ins of insights) {
      const dup = kept.some(
        (k) => jaccardTokens(k.pattern, ins.pattern) >= PATTERN_SIMILARITY_FLOOR,
      )
      if (!dup) kept.push(ins)
    }
    return kept
  }

  /**
   * LLM-powered extraction via the real `Gateway.complete`.
   * Falls back to heuristic if LLM fails or is unavailable.
   */
  async extractWithLLM(
    docs: Array<FetchedDoc & { category: InsightCategory; title?: string }>,
    gateway: Gateway,
  ): Promise<Insight[]> {
    try {
      const prompt = `Extract 1-3 concrete, actionable AI agent improvement insights from each doc.
For each insight return JSON: { summary, pattern, tags: string[], relevance: 0..1 }.
Docs:\n${docs.map((d, i) => `## Doc ${i + 1}: ${d.title} (${d.url})\n${d.markdown.slice(0, 4000)}`).join('\n\n')}`
      const out = await gateway.complete({
        model: 'openrouter/deepseek/deepseek-v3.2-exp',
        prompt,
        maxTokens: 2000,
      })
      const parsed = JSON.parse(out.text.match(/\[[\s\S]*\]/)?.[0] ?? '[]') as Array<{
        summary?: string
        pattern?: string
        tags?: string[]
        relevance?: number
      }>
      if (Array.isArray(parsed) && parsed.length) {
        return parsed.slice(0, 8).map((p, i: number) => {
          const doc = docs[i % docs.length]
          const pattern = String(p.pattern ?? p.summary ?? '').slice(0, 300)
          return {
            // Same deterministic ID rule as the heuristic path → cross-run dedupe
            id: `ins_${createHash('sha256')
              .update(`${doc?.url ?? 'llm'}::${pattern}`)
              .digest('hex')
              .slice(0, 12)}`,
            source: doc?.url ?? 'llm',
            sourceTitle: doc?.title ?? 'LLM extraction',
            category: (doc?.category ?? 'other') as InsightCategory,
            summary: String(p.summary ?? '').slice(0, 300),
            pattern,
            relevance: Math.min(1, Math.max(0, Number(p.relevance ?? 0.7))),
            tags: Array.isArray(p.tags) ? p.tags.slice(0, 5) : [],
            rawExcerpt: doc?.markdown.slice(0, 500) ?? '',
            createdAt: Date.now(),
          }
        })
      }
    } catch (err) {
      this.log(`LLM extraction failed, falling back to heuristic: ${String(err)}`)
    }
    return this.extractInsights(docs)
  }

  private async persistInsights(insights: Insight[]): Promise<void> {
    // Best-effort: if `learnings` table exists, insert. Otherwise noop.
    // The KnowledgeBase handles durable storage; this is a lightweight mirror.
    try {
      const sqlite = this.deps.db?.sqlite
      if (!sqlite) return
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS online_learnings (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          category TEXT NOT NULL,
          summary TEXT NOT NULL,
          pattern TEXT NOT NULL,
          relevance REAL NOT NULL,
          tags TEXT,
          created_at INTEGER NOT NULL
        );
      `)
      const stmt = sqlite.prepare(
        `INSERT OR IGNORE INTO online_learnings (id, source, category, summary, pattern, relevance, tags, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const ins of insights) {
        stmt.run(
          ins.id,
          ins.source,
          ins.category,
          ins.summary,
          ins.pattern,
          ins.relevance,
          JSON.stringify(ins.tags),
          ins.createdAt,
        )
      }
    } catch (err) {
      this.log(`persistInsights failed: ${err}`)
    }
  }

  private log(msg: string) {
    console.log(`[learning:online] ${msg}`)
  }
}

// ── Default search/fetch (real APIs when keys present, else keyless fallbacks) ───

/** Hacker News via Algolia — completely keyless, high signal for dev-relevant topics. */
export async function searchHN(query: string, count: number): Promise<SearchResult[]> {
  try {
    const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${count}`
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return []
    const data = (await res.json()) as {
      hits?: Array<{ title?: string; url?: string; story_text?: string; points?: number }>
    }
    return (data.hits ?? [])
      .filter((h) => typeof h.url === 'string' && h.url)
      .map((h) => ({
        title: h.title ?? h.url ?? '',
        url: h.url as string,
        snippet: h.story_text?.slice(0, 200) ?? '',
        score: typeof h.points === 'number' ? h.points : undefined,
      }))
  } catch {
    return []
  }
}

/** arXiv Atom API — keyless, structured; used for the `research-paper` category. */
export async function searchArxiv(query: string, count: number): Promise<SearchResult[]> {
  try {
    const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${count}&sortBy=relevance&sortOrder=descending`
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) })
    if (!res.ok) return []
    const xml = await res.text()
    const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
    return entries.map((m) => {
      const body = m[1]
      const title = (/<title[^>]*>([\s\S]*?)<\/title>/.exec(body)?.[1] ?? '')
        .replace(/\s+/g, ' ')
        .trim()
      const link = /<link[^>]+href=["']([^"']+)["']/.exec(body)?.[1] ?? ''
      const summary = (/<summary[^>]*>([\s\S]*?)<\/summary>/.exec(body)?.[1] ?? '')
        .replace(/\s+/g, ' ')
        .trim()
      const published = /<published[^>]*>([^<]+)<\/published>/.exec(body)?.[1] ?? undefined
      return { title, url: link, snippet: summary.slice(0, 280), publishedAt: published }
    })
  } catch {
    return []
  }
}

/** GitHub repo search — keyless (60 req/hr rate limit), used for the `github-repo` category. */
export async function searchGitHubRepos(query: string, count: number): Promise<SearchResult[]> {
  try {
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${count}`
    const res = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Mira/0.1 (+https://mira.ai)',
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return []
    const data = (await res.json()) as {
      items?: Array<{
        full_name?: string
        html_url?: string
        description?: string
        stargazers_count?: number
      }>
    }
    return (data.items ?? [])
      .filter((r) => typeof r.html_url === 'string' && r.html_url)
      .map((r) => ({
        title: r.full_name ?? r.html_url ?? '',
        url: r.html_url as string,
        snippet: r.description?.slice(0, 240) ?? '',
        score: typeof r.stargazers_count === 'number' ? r.stargazers_count : undefined,
      }))
  } catch {
    return []
  }
}

/**
 * Chunk a fetched doc by markdown headings — keep each `## -h2` (and friends)
 * section as a separate doc so extraction weights substantive content over
 * boilerplate at the top of the page.
 */
function chunkDocByHeading(
  doc: FetchedDoc & { category: InsightCategory; snippet?: string; title?: string },
): Array<FetchedDoc & { category: InsightCategory; snippet?: string; title?: string }> {
  const text = doc.markdown
  if (text.length <= 3000) return [doc]
  const headings = [...text.matchAll(/^#{1,3}\s+(.+)$/gm)]
  if (headings.length < 2) return [doc]
  const chunks: Array<
    FetchedDoc & { category: InsightCategory; snippet?: string; title?: string }
  > = []
  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].index ?? 0
    const end = headings[i + 1]?.index ?? text.length
    const raw = text.slice(start, end).trim()
    if (raw.length < 220) continue
    chunks.push({
      url: doc.url,
      category: doc.category,
      snippet: doc.snippet,
      title: `${doc.title ?? doc.url} — ${headings[i][1].slice(0, 60)}`,
      markdown: raw.slice(0, 4000),
      truncated: raw.length > 4000,
    })
  }
  return chunks.length > 0 ? chunks.slice(0, 4) : [doc]
}

function createDefaultSearchFn(): OnlineLearnerConfig['searchFn'] {
  return async (
    query: string,
    count: number,
    ctx?: { category?: InsightCategory },
  ): Promise<SearchResult[]> => {
    const category = ctx?.category
    // 1. Firecrawl
    if (process.env.FIRECRAWL_API_KEY) {
      try {
        const res = await fetch('https://api.firecrawl.dev/v1/search', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`,
          },
          body: JSON.stringify({ query, limit: count }),
        })
        if (res.ok) {
          interface SearchHit {
            title?: string
            url?: string
            description?: string
            markdown?: string
          }
          const payload = (await res.json()) as { data?: SearchHit[]; results?: SearchHit[] }
          const results = payload.data ?? payload.results ?? []
          if (results.length)
            return results.map((r) => ({
              title: r.title ?? r.url ?? '',
              url: r.url ?? '',
              snippet: r.description ?? r.markdown?.slice(0, 200) ?? '',
            }))
        }
      } catch {}
    }
    // 2. Tavily
    if (process.env.TAVILY_API_KEY) {
      try {
        const res = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: process.env.TAVILY_API_KEY,
            query,
            max_results: count,
            include_answer: false,
          }),
        })
        if (res.ok) {
          interface TavilyHit {
            title?: string
            url?: string
            content?: string
            score?: number
          }
          const payload = (await res.json()) as { results?: TavilyHit[] }
          if (payload.results?.length)
            return payload.results.map((r) => ({
              title: r.title ?? '',
              url: r.url ?? '',
              snippet: r.content?.slice(0, 200) ?? '',
              score: r.score,
            }))
        }
      } catch {}
    }
    // 3. Keyless fallbacks, category-aware (arXiv for papers, GitHub for repos, HN for general)
    if (category === 'github-repo') {
      const rep = await searchGitHubRepos(query, count)
      if (rep.length) return rep
    }
    if (category === 'research-paper') {
      const ax = await searchArxiv(query, count)
      if (ax.length) return ax
    }
    // HN Algolia: free + keyless + very high signal for dev topics
    const hn = await searchHN(query, count)
    if (hn.length) return hn
    // Return [] rather than fabricate results
    return []
  }
}

function createDefaultFetchFn(): OnlineLearnerConfig['fetchFn'] {
  return async (url: string): Promise<FetchedDoc | null> => {
    // Prefer Firecrawl scrape when available (handles JS, markdown)
    if (process.env.FIRECRAWL_API_KEY) {
      try {
        const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`,
          },
          body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
        })
        if (res.ok) {
          interface ScrapeResponse {
            data?: { markdown?: string; metadata?: { title?: string } }
            markdown?: string
          }
          const payload = (await res.json()) as ScrapeResponse
          const md = payload.data?.markdown ?? payload.markdown ?? ''
          if (md.length > 100)
            return {
              url,
              title: payload.data?.metadata?.title,
              markdown: md.slice(0, 12_000),
              truncated: md.length > 12_000,
            }
        }
      } catch {}
    }
    // Native fetch → strip HTML
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mira/0.1 (+https://mira.ai)' },
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) return null
      const html = await res.text()
      const text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 12_000)
      const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim()
      return { url, title, markdown: text, truncated: html.length > 12_000 }
    } catch {
      return null
    }
  }
}

// ── Near-duplicate detection: Jaccard token-similarity ─────────────────────
// Jaccard is stable on short pattern strings (~1 sentence); simhash needed way
// more text to converge. Two patterns are duplicates when overlap ≥ 55%.

export function jaccardTokens(a: string, b: string): number {
  const toks = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 1),
    )
  const A = toks(a)
  const B = toks(b)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter++
  return inter / (A.size + B.size - inter)
}

/** Near-dup merge threshold: 55% token overlap = same insight. */
export const PATTERN_SIMILARITY_FLOOR = 0.55

/** Derive query topics from observed failure patterns so the learner searches for
 *  fixes to *real current problems*, not just the static pool. Falls back to empty
 *  list when usage has never collected a significant failure. */
export function buildDynamicTopicsFromAnalysis(
  analysis: UsageAnalysis,
): Array<{ query: string; category: InsightCategory }> {
  const out: Array<{ query: string; category: InsightCategory }> = []
  for (const f of analysis.failurePatterns) {
    if (f.errorRate < 0.3) continue // not a real waste cycle
    if (f.key.includes('doom-loop'))
      out.push({ query: 'agent tool call loop detection prevention', category: 'agent-technique' })
    else if (f.kind === 'tool')
      out.push({
        query: `${f.key} workaround agent coding tool failure ${f.errorRate.toFixed(0)}`,
        category: 'tool',
      })
    else if (f.kind === 'model')
      out.push({ query: `LLM failure mitigation model degradation`, category: 'agent-technique' })
    else out.push({ query: `agent workflow failure prevention`, category: 'agent-technique' })
  }
  for (const s of analysis.successPatterns.slice(0, 1)) {
    out.push({ query: `extend successful agent pattern ${s.key}`, category: 'agent-technique' })
  }
  return out.slice(0, 4)
}

function pickTopics(
  topics: Array<{ query: string; category: InsightCategory }>,
  n: number,
): Array<{ query: string; category: InsightCategory }> {
  // Rotate by hour so each cycle covers different ground
  const hour = new Date().getHours()
  const offset = hour % Math.max(1, topics.length)
  const rotated = [...topics.slice(offset), ...topics.slice(0, offset)]
  return rotated.slice(0, n)
}

function extractTags(markdown: string, title: string): string[] {
  const text = `${title} ${markdown}`.toLowerCase()
  const candidates = [
    'agent',
    'tool-use',
    'mcp',
    'memory',
    'rag',
    'eval',
    'benchmark',
    'reasoning',
    'planning',
    'orchestration',
    'langgraph',
    'vercel-ai-sdk',
    'openrouter',
    'firecrawl',
    'braintrust',
    'langfuse',
    'pgvector',
  ]
  return candidates.filter((k) => text.includes(k)).slice(0, 5)
}

function scoreRelevance(markdown: string, category: InsightCategory): number {
  const text = markdown.toLowerCase()
  const signals: Record<InsightCategory, string[]> = {
    'agent-technique': ['agent', 'tool', 'orchestr', 'memory', 'loop', 'planner'],
    'research-paper': ['arxiv', 'benchmark', 'evaluation', 'dataset', 'model'],
    tool: ['mcp', 'sdk', 'api', 'tool', 'integration'],
    documentation: ['guide', 'tutorial', 'example', 'how to'],
    'github-repo': ['github', 'stars', 'repo', 'open source'],
    'eval-method': ['eval', 'benchmark', 'metric', 'pass rate'],
    other: [],
  }
  const keywords = signals[category] ?? []
  let hits = keywords.filter((k) => text.includes(k)).length
  // Length signal: very short docs are less useful
  const lenScore = Math.min(1, markdown.length / 3000) * 0.2
  return Math.min(1, (hits / Math.max(1, keywords.length)) * 0.8 + lenScore)
}

function summarizeHeuristic(markdown: string, title?: string): string {
  // First meaningful sentence(s) up to ~180 chars
  const cleaned = markdown.replace(/\s+/g, ' ').trim()
  const sentence = cleaned.match(/[^.!?]{30,180}[.!?]/)?.[0]?.trim()
  const base = sentence ?? cleaned.slice(0, 180)
  return title ? `${title} — ${base}`.slice(0, 300) : base.slice(0, 300)
}

function extractPattern(markdown: string, category: InsightCategory): string {
  const text = markdown.slice(0, 3000)
  // Look for imperative / pattern-like lines
  const line = text
    .split('\n')
    .find((l) => /^(use|prefer|avoid|implement|add|enable|ensure|configure)\b/i.test(l.trim()))
  if (line) return line.trim().slice(0, 280)
  // Fallback: first 200 chars of summary
  return summarizeHeuristic(markdown).slice(0, 200)
}
