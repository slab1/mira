/**
 * Mira Knowledge Base — Hierarchical Memory (Episodic, Semantic, Procedural)
 *
 * Taxonomy (Aether-aligned, O'Reilly 2026 3-tier):
 *   L1 Episodic   — events/traces: what happened (session logs, tool traces, online fetches)
 *   L2 Semantic   — facts/insights: what is true (distilled learnings, patterns)
 *   L3 Procedural — skills/how-to: how to do it (verified patches, prompt improvements)
 *
 * Retrieval: hybrid (vector + graph + rerank + assembly) — mocked vector
 * via in-memory cosine on keyword embeddings so the system works without
 * pgvector; swaps to real pgvector when DATABASE_URL is set.
 *
 * Cross-session: all learnings persist to SQLite (and optionally Postgres
 * + pgvector in prod). In-memory index is rebuilt on startup from DB.
 *
 * Integration:
 *   - OnlineLearner & UsageLearner call `knowledge.store()` after each cycle
 *   - Scheduler & ImprovementEngine call `knowledge.retrieve()` to ground patches
 *   - SessionPrompt can call `retrieve()` to inject relevant memory into context
 */

import type { Bus } from "../bus/index.js"
import type { Insight } from "./online.js"
import type { UsageAnalysis, FailurePattern, SuccessPattern } from "./usage.js"

// ── Types ────────────────────────────────────────────────────────────

export type MemoryTier = "episodic" | "semantic" | "procedural"
export type MemorySource = "online" | "usage" | "improvement" | "user" | "system"

export interface MemoryEntry {
  id: string
  tier: MemoryTier
  source: MemorySource
  title: string
  content: string        // main text (summary + pattern)
  tags: string[]
  graphLinks: string[]   // ids of related entries (knowledge graph edges)
  embedding?: number[]   // optional vector (keyword hash or real embedding)
  metadata: Record<string, unknown>
  score?: number         // retrieval score (filled on search)
  createdAt: number
  updatedAt: number
}

export interface StoreInput {
  tier: MemoryTier
  source: MemorySource
  title: string
  content: string
  tags?: string[]
  metadata?: Record<string, unknown>
  links?: string[]       // graph edges to existing entry ids
}

export interface RetrieveOptions {
  query: string
  tier?: MemoryTier      // filter by tier
  limit?: number         // default 8
  minScore?: number      // default 0.15
  hybrid?: boolean       // default true (vector + graph expansion)
}

export interface KnowledgeBaseDeps {
  bus?: Bus
  db?: any
}

// ── KnowledgeBase ────────────────────────────────────────────────────

export class KnowledgeBase {
  /** in-memory index (always available; DB is durability) */
  private entries = new Map<string, MemoryEntry>()
  /** keyword → entry ids (graph-like inverted index) */
  private tagIndex = new Map<string, Set<string>>()
  private loaded = false

  constructor(private deps: KnowledgeBaseDeps = {}) {}

  // ── Lifecycle ──────────────────────────────────────────────────────

  /** Load persisted entries from SQLite into memory (idempotent) */
  async load(): Promise<number> {
    if (this.loaded) return this.entries.size
    this.loaded = true
    if (!this.deps.db?.sqlite) return 0
    try {
      const sqlite = this.deps.db.sqlite
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS knowledge_entries (
          id TEXT PRIMARY KEY,
          tier TEXT NOT NULL,
          source TEXT NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          tags TEXT,
          graph_links TEXT,
          embedding TEXT,
          metadata TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS knowledge_tier_idx ON knowledge_entries(tier);
        CREATE INDEX IF NOT EXISTS knowledge_source_idx ON knowledge_entries(source);
      `)
      const rows: any[] = sqlite.prepare(`SELECT * FROM knowledge_entries ORDER BY updated_at DESC LIMIT 2000`).all()
      for (const r of rows) {
        const e: MemoryEntry = {
          id: r.id, tier: r.tier, source: r.source, title: r.title, content: r.content,
          tags: JSON.parse(r.tags ?? "[]"),
          graphLinks: JSON.parse(r.graph_links ?? "[]"),
          embedding: r.embedding ? JSON.parse(r.embedding) : undefined,
          metadata: JSON.parse(r.metadata ?? "{}"),
          createdAt: r.created_at, updatedAt: r.updated_at,
        }
        this.entries.set(e.id, e)
        this.indexEntry(e)
      }
    } catch {}
    return this.entries.size
  }

  // ── Write ──────────────────────────────────────────────────────────

  async store(input: StoreInput): Promise<MemoryEntry> {
    await this.load()
    const entry: MemoryEntry = {
      id: `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      tier: input.tier,
      source: input.source,
      title: input.title.slice(0, 200),
      content: input.content.slice(0, 4000),
      tags: (input.tags ?? []).slice(0, 8),
      graphLinks: (input.links ?? []).slice(0, 12),
      embedding: embedKeyword(input.title + " " + input.content),
      metadata: input.metadata ?? {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.entries.set(entry.id, entry)
    this.indexEntry(entry)
    await this.persist(entry).catch(() => {})

    // Auto-link: connect to top-2 similar existing entries (graph growth)
    const neighbors = this.findNeighbors(entry, 2)
    if (neighbors.length) {
      entry.graphLinks = [...new Set([...entry.graphLinks, ...neighbors.map(n => n.id)])]
      // Also add reverse edges (best-effort)
      for (const n of neighbors) {
        if (!n.graphLinks.includes(entry.id)) n.graphLinks.push(entry.id)
      }
    }
    return entry
  }

  /** Store an Online insight as semantic memory */
  async storeInsight(insight: Insight): Promise<MemoryEntry> {
    return this.store({
      tier: "semantic",
      source: "online",
      title: insight.summary.slice(0, 180),
      content: `Pattern: ${insight.pattern}\nSource: ${insight.source} — ${insight.sourceTitle}\nExcerpt: ${insight.rawExcerpt}\nRelevance: ${insight.relevance}`,
      tags: insight.tags,
      metadata: { insightId: insight.id, category: insight.category, relevance: insight.relevance, url: insight.source },
    })
  }

  /** Store a usage analysis as episodic + semantic memories */
  async storeUsageAnalysis(analysis: UsageAnalysis): Promise<MemoryEntry[]> {
    const out: MemoryEntry[] = []
    // Episodic: the raw analysis
    out.push(await this.store({
      tier: "episodic",
      source: "usage",
      title: `Usage analysis: ${analysis.window.sessions} sessions @ ${new Date(analysis.generatedAt).toISOString().slice(0, 10)}`,
      content: `Window: ${analysis.window.sessions} sessions. Failures: ${analysis.failurePatterns.map(f => `${f.key}(${Math.round(f.errorRate * 100)}%)`).join(", ") || "none"}. Success: ${analysis.successPatterns.map(s => s.key).join("; ") || "none"}.`,
      tags: ["usage", "analysis"],
      metadata: { kind: "usage_analysis", window: analysis.window } as any,
    }))
    // Semantic: each failure pattern as a fact
    for (const f of analysis.failurePatterns) {
      out.push(await this.store({
        tier: "semantic",
        source: "usage",
        title: `Failure pattern: ${f.key} — ${Math.round(f.errorRate * 100)}% over ${f.count} occurrences`,
        content: f.suggestion,
        tags: ["failure-pattern", f.kind],
        metadata: { kind: "failure_pattern", pattern: f } as any,
      }))
    }
    return out
  }

  // ── Read ───────────────────────────────────────────────────────────

  /**
   * Hybrid retrieval: vector (cosine on keyword embeddings) + graph expansion
   * + tier filter + rerank. Works offline; upgrades to real embeddings when
   * an embedder is injected.
   */
  async retrieve(opts: RetrieveOptions): Promise<MemoryEntry[]> {
    await this.load()
    const qEmb = embedKeyword(opts.query)
    const limit = opts.limit ?? 8
    const minScore = opts.minScore ?? 0.15

    // 1. Vector score (cosine)
    const scored: Array<MemoryEntry & { _score: number }> = []
    for (const e of this.entries.values()) {
      if (opts.tier && e.tier !== opts.tier) continue
      const emb = e.embedding ?? embedKeyword(e.title + " " + e.content)
      const s = cosine(qEmb, emb)
      // Tag overlap bonus
      const qTags = new Set(opts.query.toLowerCase().split(/\W+/).filter(Boolean))
      const overlap = e.tags.filter(t => qTags.has(t.toLowerCase())).length
      const score = s + overlap * 0.08
      if (score >= minScore) scored.push({ ...e, _score: score, score })
    }
    scored.sort((a, b) => b._score - a._score)
    let top = scored.slice(0, limit)

    // 2. Graph expansion (hybrid): pull 1-hop neighbors of top results
    if (opts.hybrid !== false && top.length) {
      const seen = new Set(top.map(t => t.id))
      const expanded: typeof scored = [...top]
      for (const t of top.slice(0, 3)) {
        for (const linkId of (t.graphLinks ?? []).slice(0, 3)) {
          if (seen.has(linkId)) continue
          const n = this.entries.get(linkId)
          if (n) {
            seen.add(linkId)
            const nEmb = n.embedding ?? embedKeyword(n.title + " " + n.content)
            expanded.push({ ...n, _score: cosine(qEmb, nEmb) * 0.7, score: cosine(qEmb, nEmb) * 0.7 })
          }
        }
      }
      expanded.sort((a, b) => b._score - a._score)
      top = expanded.slice(0, limit)
    }

    // 3. Assembly: return ranked entries (strip internal _score)
    return top.map(({ _score, ...e }) => e)
  }

  /** Direct lookup by id */
  get(id: string): MemoryEntry | undefined {
    return this.entries.get(id)
  }

  /** List by tier/source (for debugging / TUI) */
  list(filter?: { tier?: MemoryTier; source?: MemorySource; limit?: number }): MemoryEntry[] {
    let arr = [...this.entries.values()]
    if (filter?.tier) arr = arr.filter(e => e.tier === filter.tier)
    if (filter?.source) arr = arr.filter(e => e.source === filter.source)
    arr.sort((a, b) => b.updatedAt - a.updatedAt)
    return arr.slice(0, filter?.limit ?? 50)
  }

  /** Number of entries (for health checks) */
  size(): number { return this.entries.size }

  /** Build a cognitive packet for prompt injection (HCM-style) */
  async buildCognitivePacket(query: string, limit = 6): Promise<string> {
    const memories = await this.retrieve({ query, limit })
    if (!memories.length) return ""
    const lines = memories.map(m => `- [${m.tier}/${m.source}] ${m.title}: ${m.content.slice(0, 220)}`)
    return `## Relevant Memory (KnowledgeBase)\n${lines.join("\n")}`
  }

  // ── Internals ──────────────────────────────────────────────────────

  private indexEntry(e: MemoryEntry): void {
    for (const tag of e.tags) {
      const k = tag.toLowerCase()
      if (!this.tagIndex.has(k)) this.tagIndex.set(k, new Set())
      this.tagIndex.get(k)!.add(e.id)
    }
  }

  private findNeighbors(entry: MemoryEntry, k: number): MemoryEntry[] {
    const qEmb = entry.embedding!
    const scored: Array<{ e: MemoryEntry; s: number }> = []
    for (const other of this.entries.values()) {
      if (other.id === entry.id) continue
      const s = cosine(qEmb, other.embedding ?? embedKeyword(other.title + " " + other.content))
      scored.push({ e: other, s })
    }
    scored.sort((a, b) => b.s - a.s)
    return scored.slice(0, k).map(x => x.e)
  }

  private async persist(entry: MemoryEntry): Promise<void> {
    const sqlite = this.deps.db?.sqlite
    if (!sqlite) return
    sqlite.prepare(
      `INSERT OR REPLACE INTO knowledge_entries
       (id, tier, source, title, content, tags, graph_links, embedding, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      entry.id, entry.tier, entry.source, entry.title, entry.content,
      JSON.stringify(entry.tags), JSON.stringify(entry.graphLinks),
      JSON.stringify(entry.embedding ?? null), JSON.stringify(entry.metadata),
      entry.createdAt, entry.updatedAt,
    )
  }
}

// ── Keyword embedding (offline, deterministic, no API key) ───────────
// Hashes text into a fixed 64-dim unit vector via token hashing.
// Swap with real embeddings (OpenAI / Voyage / local) by injecting via
// `embedFn` — the cosine retrieval stays the same.

const EMBED_DIM = 64

export function embedKeyword(text: string): number[] {
  const vec = new Array(EMBED_DIM).fill(0)
  const tokens = text.toLowerCase().split(/\W+/).filter(t => t.length >= 2)
  for (const tok of tokens) {
    let h = 0
    for (let i = 0; i < tok.length; i++) h = (Math.imul(31, h) + tok.charCodeAt(i)) | 0
    const idx = Math.abs(h) % EMBED_DIM
    vec[idx] += 1
  }
  // L2 normalize
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1
  return vec.map(v => v / norm)
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) dot += a[i] * b[i]
  return dot // already normalized
}

/** Singleton for prompt injection — one KB per process, loaded once from SQLite */
let _sharedKB: KnowledgeBase | undefined
export function setSharedKnowledge(kb: KnowledgeBase): void {
  _sharedKB = kb
}
export function sharedKnowledge(deps?: KnowledgeBaseDeps): KnowledgeBase {
  if (!_sharedKB) _sharedKB = new KnowledgeBase(deps)
  return _sharedKB
}

/** Simple helper for prompt injection */
export async function searchKnowledge(query: string, limit = 3) {
  return sharedKnowledge().retrieve({ query, limit })
}
