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

import type { Bus } from "../bus/index.js"

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
  source: string          // url
  sourceTitle: string
  category: InsightCategory
  summary: string         // 1-2 sentence distillation
  pattern: string         // reusable pattern / technique
  relevance: number       // 0..1
  tags: string[]
  rawExcerpt: string      // grounding excerpt (<=500 chars)
  createdAt: number
}

export type InsightCategory =
  | "agent-technique"
  | "research-paper"
  | "tool"
  | "documentation"
  | "github-repo"
  | "eval-method"
  | "other"

export interface OnlineLearnerConfig {
  /** max search queries per cycle (default 6) */
  maxQueries?: number
  /** max docs to fetch per cycle (default 8) */
  maxDocs?: number
  /** max chars per fetched doc (default 12_000) */
  maxChars?: number
  /** reuse firecrawl_search / websearch tool shape if injected */
  searchFn?: (query: string, count: number) => Promise<SearchResult[]>
  fetchFn?: (url: string) => Promise<FetchedDoc | null>
}

export interface OnlineLearnerDeps {
  bus?: Bus
  db?: any
}

// ── Default query bank (rotated each cycle) ────────────────────────

export const DEFAULT_TOPICS: Array<{ query: string; category: InsightCategory }> = [
  { query: "AI agent orchestration framework 2026 Vercel AI SDK LangGraph", category: "agent-technique" },
  { query: "LLM agent tool use improvement technique 2026", category: "agent-technique" },
  { query: "arxiv AI agent reasoning memory benchmark", category: "research-paper" },
  { query: "MCP model context protocol new servers tools 2026", category: "tool" },
  { query: "agent evaluation harness Braintrust Langfuse 2026", category: "eval-method" },
  { query: "github awesome AI agents framework trending", category: "github-repo" },
  { query: "Claude OpenCode Cursor agent best practices 2026", category: "documentation" },
  { query: "agent memory architecture Mem0 Zep pgvector hybrid retrieval", category: "agent-technique" },
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
    }
  }

  /**
   * One learning cycle: search → fetch → extract insights
   * Returns insights (also publishes `learning.online.insights` on the bus
   * and persists to episodic memory if db is available).
   */
  async learnOnce(topics = DEFAULT_TOPICS): Promise<Insight[]> {
    const picked = pickTopics(topics, this.config.maxQueries)
    this.log(`online: searching ${picked.length} topics...`)

    // 1. Search
    const allResults: Array<SearchResult & { category: InsightCategory }> = []
    for (const t of picked) {
      try {
        const results = await this.config.searchFn(t.query, 5)
        for (const r of results.slice(0, 3)) allResults.push({ ...r, category: t.category })
      } catch (err) {
        this.log(`search failed for "${t.query}": ${String(err)}`)
      }
    }
    // Deduplicate by URL
    const seen = new Set<string>()
    const deduped = allResults.filter(r => {
      if (seen.has(r.url)) return false
      seen.add(r.url)
      return true
    }).slice(0, this.config.maxDocs)

    if (deduped.length === 0) {
      this.log("online: no search results — skipping fetch")
      return []
    }
    this.log(`online: ${deduped.length} unique URLs → fetching...`)

    // 2. Fetch
    const docs: Array<FetchedDoc & { category: InsightCategory; snippet: string; title: string }> = []
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

    // 3. Extract insights
    const insights = this.extractInsights(docs)
    this.log(`online: extracted ${insights.length} insights`)

    // 4. Persist + publish (best-effort)
    if (this.deps.db) await this.persistInsights(insights).catch(() => {})
    this.deps.bus?.publish({
      type: "server.heartbeat" as any,
      payload: { kind: "learning.online.insights", count: insights.length, insights: insights.slice(0, 5) },
      timestamp: Date.now(),
    } as any)

    return insights
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
      const excerpt = doc.markdown.slice(0, 500).replace(/\s+/g, " ").trim()
      const tags = extractTags(doc.markdown, doc.title ?? "")
      const relevance = scoreRelevance(doc.markdown, doc.category)
      // Skip low-signal docs
      if (relevance < 0.25) continue

      insights.push({
        id: `ins_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
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
    // Sort by relevance desc, dedupe by pattern
    insights.sort((a, b) => b.relevance - a.relevance)
    const byPattern = new Map<string, Insight>()
    for (const ins of insights) {
      const key = ins.pattern.toLowerCase().slice(0, 80)
      if (!byPattern.has(key)) byPattern.set(key, ins)
    }
    return [...byPattern.values()]
  }

  /**
   * Optional LLM-powered extraction (call when gateway is available).
   * Falls back to heuristic if LLM fails.
   */
  async extractWithLLM(
    docs: Array<FetchedDoc & { category: InsightCategory; title?: string }>,
    gateway?: { generate: (opts: any) => Promise<{ text: string }> },
  ): Promise<Insight[]> {
    if (!gateway) return this.extractInsights(docs as any)
    try {
      const prompt = `Extract 1-3 concrete, actionable AI agent improvement insights from each doc.
For each insight return JSON: { summary, pattern, tags: string[], relevance: 0..1 }.
Docs:\n${docs.map((d, i) => `## Doc ${i + 1}: ${d.title} (${d.url})\n${d.markdown.slice(0, 4000)}`).join("\n\n")}`
      const { text } = await gateway.generate({ prompt, model: "openrouter/deepseek/deepseek-v3.2-exp" })
      const parsed = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] ?? "[]")
      if (Array.isArray(parsed) && parsed.length) {
        return parsed.slice(0, 8).map((p: any, i: number) => ({
          id: `ins_llm_${Date.now().toString(36)}_${i}`,
          source: docs[i % docs.length]?.url ?? "llm",
          sourceTitle: docs[i % docs.length]?.title ?? "LLM extraction",
          category: (docs[i % docs.length]?.category ?? "other") as InsightCategory,
          summary: String(p.summary ?? "").slice(0, 300),
          pattern: String(p.pattern ?? p.summary ?? "").slice(0, 300),
          relevance: Math.min(1, Math.max(0, Number(p.relevance ?? 0.7))),
          tags: Array.isArray(p.tags) ? p.tags.slice(0, 5) : [],
          rawExcerpt: docs[i % docs.length]?.markdown.slice(0, 500) ?? "",
          createdAt: Date.now(),
        }))
      }
    } catch (err) {
      this.log(`LLM extraction failed, falling back to heuristic: ${String(err)}`)
    }
    return this.extractInsights(docs as any)
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
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      for (const ins of insights) {
        stmt.run(ins.id, ins.source, ins.category, ins.summary, ins.pattern, ins.relevance, JSON.stringify(ins.tags), ins.createdAt)
      }
    } catch {}
  }

  private log(msg: string) {
    console.log(`[learning:online] ${msg}`)
  }
}

// ── Default search/fetch (real APIs when keys present, else stub) ───

function createDefaultSearchFn(): OnlineLearnerConfig["searchFn"] {
  return async (query: string, count: number): Promise<SearchResult[]> => {
    // 1. Firecrawl
    if (process.env.FIRECRAWL_API_KEY) {
      try {
        const res = await fetch("https://api.firecrawl.dev/v1/search", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}` },
          body: JSON.stringify({ query, limit: count }),
        })
        if (res.ok) {
          const data: any = await res.json()
          const results = data.data ?? data.results ?? []
          if (results.length) return results.map((r: any) => ({
            title: r.title ?? r.url,
            url: r.url,
            snippet: r.description ?? r.markdown?.slice(0, 200) ?? "",
          }))
        }
      } catch {}
    }
    // 2. Tavily
    if (process.env.TAVILY_API_KEY) {
      try {
        const res = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query, max_results: count, include_answer: false }),
        })
        if (res.ok) {
          const data: any = await res.json()
          if (data.results?.length) return data.results.map((r: any) => ({
            title: r.title, url: r.url, snippet: r.content?.slice(0, 200) ?? "", score: r.score,
          }))
        }
      } catch {}
    }
    // 3. Stub — caller can inject real searchFn; this keeps the system functional offline
    return [
      { title: `(stub) No search key — configure FIRECRAWL_API_KEY or inject searchFn`, url: `https://example.com/search?q=${encodeURIComponent(query)}`, snippet: `Stub result for "${query}". Set FIRECRAWL_API_KEY for live results.` },
    ]
  }
}

function createDefaultFetchFn(): OnlineLearnerConfig["fetchFn"] {
  return async (url: string): Promise<FetchedDoc | null> => {
    // Prefer Firecrawl scrape when available (handles JS, markdown)
    if (process.env.FIRECRAWL_API_KEY) {
      try {
        const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}` },
          body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
        })
        if (res.ok) {
          const data: any = await res.json()
          const md = data.data?.markdown ?? data.markdown ?? ""
          if (md.length > 100) return { url, title: data.data?.metadata?.title, markdown: md.slice(0, 12_000), truncated: md.length > 12_000 }
        }
      } catch {}
    }
    // Native fetch → strip HTML
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mira/0.1 (+https://mira.ai)" },
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) return null
      const html = await res.text()
      const text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 12_000)
      const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim()
      return { url, title, markdown: text, truncated: html.length > 12_000 }
    } catch { return null }
  }
}

// ── Heuristics ───────────────────────────────────────────────────────

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
    "agent", "tool-use", "mcp", "memory", "rag", "eval", "benchmark",
    "reasoning", "planning", "orchestration", "langgraph", "vercel-ai-sdk",
    "openrouter", "firecrawl", "braintrust", "langfuse", "pgvector",
  ]
  return candidates.filter(k => text.includes(k)).slice(0, 5)
}

function scoreRelevance(markdown: string, category: InsightCategory): number {
  const text = markdown.toLowerCase()
  const signals: Record<InsightCategory, string[]> = {
    "agent-technique": ["agent", "tool", "orchestr", "memory", "loop", "planner"],
    "research-paper": ["arxiv", "benchmark", "evaluation", "dataset", "model"],
    "tool": ["mcp", "sdk", "api", "tool", "integration"],
    "documentation": ["guide", "tutorial", "example", "how to"],
    "github-repo": ["github", "stars", "repo", "open source"],
    "eval-method": ["eval", "benchmark", "metric", "pass rate"],
    "other": [],
  }
  const keywords = signals[category] ?? []
  let hits = keywords.filter(k => text.includes(k)).length
  // Length signal: very short docs are less useful
  const lenScore = Math.min(1, markdown.length / 3000) * 0.2
  return Math.min(1, hits / Math.max(1, keywords.length) * 0.8 + lenScore)
}

function summarizeHeuristic(markdown: string, title?: string): string {
  // First meaningful sentence(s) up to ~180 chars
  const cleaned = markdown.replace(/\s+/g, " ").trim()
  const sentence = cleaned.match(/[^.!?]{30,180}[.!?]/)?.[0]?.trim()
  const base = sentence ?? cleaned.slice(0, 180)
  return title ? `${title} — ${base}`.slice(0, 300) : base.slice(0, 300)
}

function extractPattern(markdown: string, category: InsightCategory): string {
  const text = markdown.slice(0, 3000)
  // Look for imperative / pattern-like lines
  const line = text.split("\n").find(l => /^(use|prefer|avoid|implement|add|enable|ensure|configure)\b/i.test(l.trim()))
  if (line) return line.trim().slice(0, 280)
  // Fallback: first 200 chars of summary
  return summarizeHeuristic(markdown).slice(0, 200)
}
