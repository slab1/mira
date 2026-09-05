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
 * H2-1 Memory v2: temporal decay + entity graph + rerank
 *   - Temporal: lastAccessedAt + accessCount, decay by age (half-life 30d)
 *   - Entity graph: file → symbol → decision edges via extracted entities
 *   - Rerank: cosine + tag + decay + graph bonus + access bonus
 *
 * Cross-session: all learnings persist to SQLite (and optionally Postgres
 * + pgvector in prod). In-memory index is rebuilt on startup from DB.
 *
 * Integration:
 *   - OnlineLearner & UsageLearner call `knowledge.store()` after each cycle
 *   - Scheduler & ImprovementEngine call `knowledge.retrieve()` to ground patches
 *   - SessionPrompt can call `retrieve()` to inject relevant memory into context
 */

import type { Bus } from '../bus/index.js'
import type { Insight } from './online.js'
import type { UsageAnalysis, FailurePattern, SuccessPattern } from './usage.js'
import type { MiraDB } from '../storage/db.js'
import type { JsonValue } from '../types/index.js'

// ── Types ────────────────────────────────────────────────────────────

export type MemoryTier = 'episodic' | 'semantic' | 'procedural'
export type MemorySource = 'online' | 'usage' | 'improvement' | 'user' | 'system'

export interface MemoryEntry {
  id: string
  tier: MemoryTier
  source: MemorySource
  title: string
  content: string // main text (summary + pattern)
  tags: string[]
  graphLinks: string[] // ids of related entries (knowledge graph edges)
  embedding?: number[] // optional vector (keyword hash or real embedding)
  metadata: Record<string, JsonValue>
  score?: number // retrieval score (filled on search)
  createdAt: number
  updatedAt: number
  // H2-1: temporal decay
  lastAccessedAt: number
  accessCount: number
  // H2-1: entity graph — file → symbol → decision edges
  entities: string[] // extracted entities (file paths, symbols, decisions)
}

export interface StoreInput {
  tier: MemoryTier
  source: MemorySource
  title: string
  content: string
  tags?: string[]
  metadata?: Record<string, JsonValue>
  links?: string[] // graph edges to existing entry ids
  entities?: string[] // explicit entities (auto-extracted if omitted)
}

export interface RetrieveOptions {
  query: string
  tier?: MemoryTier // filter by tier
  limit?: number // default 8
  minScore?: number // default 0.15
  hybrid?: boolean // default true (vector + graph expansion)
}

export interface KnowledgeBaseDeps {
  bus?: Bus
  db?: MiraDB
}

/** Raw knowledge_entries row as returned by bun:sqlite (snake_case columns) */
interface KnowledgeRow {
  id: string
  tier?: string | null
  source?: string | null
  title?: string | null
  content: string
  tags?: string | null
  graph_links?: string | null
  embedding?: string | null
  metadata?: string | null
  created_at: number
  updated_at?: number | null
  last_accessed_at?: number | null
  access_count?: number | null
  entities?: string | null
  // legacy
  kind?: string | null
  session_id?: string | null
}

// Graph types for GET /knowledge/graph
export interface GraphNode {
  id: string
  label: string
  tier: string
  source: string
  tags: string[]
  entities: string[]
  createdAt: number
  updatedAt: number
  lastAccessedAt: number
  accessCount: number
  kind: 'knowledge' | 'finding'
  severity?: string
  status?: string
}

export interface GraphEdge {
  from: string
  to: string
  kind: 'related' | 'entity' | 'finding'
  label?: string
}

export interface KnowledgeGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

// ── KnowledgeBase ────────────────────────────────────────────────────

export class KnowledgeBase {
  /** in-memory index (always available; DB is durability) */
  private entries = new Map<string, MemoryEntry>()
  /** keyword → entry ids (graph-like inverted index) */
  private tagIndex = new Map<string, Set<string>>()
  /** entity → entry ids (entity graph index) */
  private entityIndex = new Map<string, Set<string>>()
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
          tier TEXT,
          source TEXT,
          title TEXT,
          content TEXT NOT NULL,
          tags TEXT,
          graph_links TEXT,
          embedding TEXT,
          metadata TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER,
          last_accessed_at INTEGER,
          access_count INTEGER,
          entities TEXT,
          session_id TEXT,
          kind TEXT
        );
        CREATE INDEX IF NOT EXISTS knowledge_tier_idx ON knowledge_entries(tier);
        CREATE INDEX IF NOT EXISTS knowledge_source_idx ON knowledge_entries(source);
      `)
      // Migrate existing DBs: add missing columns (idempotent)
      const addCol = (col: string, type: string) => {
        try {
          sqlite.exec(`ALTER TABLE knowledge_entries ADD COLUMN ${col} ${type}`)
        } catch (e) {
          if (!String(e).includes('duplicate column name'))
            console.warn(`[knowledge] addColumn ${col} failed:`, String(e))
        }
      }
      addCol('tier', 'TEXT')
      addCol('source', 'TEXT')
      addCol('title', 'TEXT')
      addCol('tags', 'TEXT')
      addCol('graph_links', 'TEXT')
      addCol('embedding', 'TEXT')
      addCol('metadata', 'TEXT')
      addCol('updated_at', 'INTEGER')
      addCol('last_accessed_at', 'INTEGER')
      addCol('access_count', 'INTEGER')
      addCol('entities', 'TEXT')

      const rows = sqlite
        .prepare(
          `SELECT * FROM knowledge_entries ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 2000`,
        )
        .all() as KnowledgeRow[]
      for (const r of rows) {
        // Skip legacy rows that have no tier/source/title (old kind-based schema) — still load as episodic
        const tier = (r.tier as MemoryTier | null) ?? (r.kind as MemoryTier | null) ?? 'episodic'
        const source = (r.source as MemorySource | null) ?? 'system'
        const title = r.title ?? r.content.slice(0, 80)
        const e: MemoryEntry = {
          id: r.id,
          tier,
          source,
          title,
          content: r.content,
          tags: safeJsonParse<string[]>(r.tags, []),
          graphLinks: safeJsonParse<string[]>(r.graph_links, []),
          embedding: r.embedding
            ? (safeJsonParse<number[] | null>(r.embedding, null) ?? undefined)
            : undefined,
          metadata: safeJsonParse<Record<string, JsonValue>>(r.metadata, {}),
          createdAt: r.created_at,
          updatedAt: r.updated_at ?? r.created_at,
          lastAccessedAt: r.last_accessed_at ?? r.updated_at ?? r.created_at,
          accessCount: r.access_count ?? 0,
          entities: safeJsonParse<string[]>(r.entities, []),
        }
        // Backfill entities if empty (extract from title+content+tags)
        if (!e.entities.length) {
          e.entities = extractEntities(e.title + ' ' + e.content, e.tags)
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
    const now = Date.now()
    const entities = (
      input.entities ?? extractEntities(input.title + ' ' + input.content, input.tags ?? [])
    ).slice(0, 12)
    const entry: MemoryEntry = {
      id: `mem_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      tier: input.tier,
      source: input.source,
      title: input.title.slice(0, 200),
      content: input.content.slice(0, 4000),
      tags: (input.tags ?? []).slice(0, 8),
      graphLinks: (input.links ?? []).slice(0, 12),
      embedding: embedKeyword(input.title + ' ' + input.content),
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      accessCount: 0,
      entities,
    }
    this.entries.set(entry.id, entry)
    this.indexEntry(entry)
    await this.persist(entry).catch(() => {})

    // Auto-link: connect to top-2 similar existing entries + entity overlap (graph growth)
    const neighbors = this.findNeighbors(entry, 2)
    const entityNeighbors = this.findEntityNeighbors(entry, 2)
    const allNeighbors = [
      ...new Map([...neighbors, ...entityNeighbors].map((n) => [n.id, n])).values(),
    ].slice(0, 3)
    if (allNeighbors.length) {
      entry.graphLinks = [...new Set([...entry.graphLinks, ...allNeighbors.map((n) => n.id)])]
      // Also add reverse edges (best-effort)
      for (const n of allNeighbors) {
        if (!n.graphLinks.includes(entry.id)) {
          n.graphLinks.push(entry.id)
          // persist reverse edge best-effort
          this.persist(n).catch(() => {})
        }
      }
      // re-persist with updated links
      await this.persist(entry).catch(() => {})
    }
    return entry
  }

  /** Store an Online insight as semantic memory.
   *  Deterministic id derivation (`mem_<insightId>`) so repeat cycles bump an
   *  existing row instead of piling duplicates; utility score preserved. */
  async storeInsight(insight: Insight): Promise<MemoryEntry> {
    const memId = `mem_${insight.id}`
    const existing = this.entries.get(memId)
    if (existing) {
      // Re-hydrate with fresh content, bump access count as "still surfaced" signal
      existing.title = insight.summary.slice(0, 180)
      existing.content = `Pattern: ${insight.pattern}\nSource: ${insight.source} — ${insight.sourceTitle}\nExcerpt: ${insight.rawExcerpt}\nRelevance: ${insight.relevance}`
      existing.tags = insight.tags
      existing.updatedAt = Date.now()
      existing.accessCount = (existing.accessCount ?? 0) + 1
      await this.persist(existing).catch(() => {})
      return existing
    }
    return this.store({
      tier: 'semantic',
      source: 'online',
      title: insight.summary.slice(0, 180),
      content: `Pattern: ${insight.pattern}\nSource: ${insight.source} — ${insight.sourceTitle}\nExcerpt: ${insight.rawExcerpt}\nRelevance: ${insight.relevance}`,
      tags: insight.tags,
      metadata: {
        insightId: insight.id,
        category: insight.category,
        relevance: insight.relevance,
        url: insight.source,
        utility: 0, // starts neutral; prompt feedback adjusts up/down
      },
      // Force deterministic id so dedupe works across cycles
      entities: extractEntities(insight.summary + ' ' + insight.pattern, insight.tags),
    }).then(async (e) => {
      // Patch the generated id to the deterministic mem_<insightId>
      const withNewId: MemoryEntry = { ...e, id: memId }
      this.entries.delete(e.id)
      this.entries.set(memId, withNewId)
      await this.persist(withNewId).catch(() => {})
      return withNewId
    })
  }

  /** Adjust a memory's utility score — called by SessionPrompt after each turn
   *  with success/failure at the session level. bounds clamped to [-20, +20]
   *  so a single rogue session can't dominate ranking permanently.
   */
  bumpUtility(id: string, delta: number): void {
    const e = this.entries.get(id)
    if (!e) return // no-op on unknown ids (e.g. already expired)
    const curr = (e.metadata.utility as number) ?? 0
    const nxt = Math.max(-20, Math.min(20, curr + delta))
    e.metadata = { ...e.metadata, utility: nxt }
    e.updatedAt = Date.now()
    this.persist(e).catch(() => {})
  }

  /** Store a usage analysis as episodic + semantic memories */
  async storeUsageAnalysis(analysis: UsageAnalysis): Promise<MemoryEntry[]> {
    const out: MemoryEntry[] = []
    // Episodic: the raw analysis
    out.push(
      await this.store({
        tier: 'episodic',
        source: 'usage',
        title: `Usage analysis: ${analysis.window.sessions} sessions @ ${new Date(analysis.generatedAt).toISOString().slice(0, 10)}`,
        content: `Window: ${analysis.window.sessions} sessions. Failures: ${analysis.failurePatterns.map((f) => `${f.key}(${Math.round(f.errorRate * 100)}%)`).join(', ') || 'none'}. Success: ${analysis.successPatterns.map((s) => s.key).join('; ') || 'none'}.`,
        tags: ['usage', 'analysis'],
        metadata: { kind: 'usage_analysis', window: analysis.window },
      }),
    )
    // Semantic: each failure pattern as a fact
    for (const f of analysis.failurePatterns) {
      out.push(
        await this.store({
          tier: 'semantic',
          source: 'usage',
          title: `Failure pattern: ${f.key} — ${Math.round(f.errorRate * 100)}% over ${f.count} occurrences`,
          content: f.suggestion,
          tags: ['failure-pattern', f.kind],
          metadata: { kind: 'failure_pattern', pattern: f as JsonValue },
        }),
      )
    }
    return out
  }

  // ── Read ───────────────────────────────────────────────────────────

  /**
   * Hybrid retrieval: vector (cosine on keyword embeddings) + graph expansion
   * + tier filter + rerank with temporal decay + graph bonus. Works offline;
   * upgrades to real embeddings when an embedder is injected.
   */
  async retrieve(opts: RetrieveOptions): Promise<MemoryEntry[]> {
    await this.load()
    const qEmb = embedKeyword(opts.query)
    const limit = opts.limit ?? 8
    const minScore = opts.minScore ?? 0.15
    const now = Date.now()

    // 1. Vector score (cosine) + tag overlap + temporal decay + access bonus
    const scored: Array<MemoryEntry & { _score: number; _rawScore: number }> = []
    for (const e of this.entries.values()) {
      if (opts.tier && e.tier !== opts.tier) continue
      const emb = e.embedding ?? embedKeyword(e.title + ' ' + e.content)
      const s = cosine(qEmb, emb)
      // Tag overlap bonus
      const qTags = new Set(opts.query.toLowerCase().split(/\W+/).filter(Boolean))
      const overlap = e.tags.filter((t) => qTags.has(t.toLowerCase())).length
      let score = s + overlap * 0.08

      // Entity overlap bonus (file → symbol → decision)
      const qEntities = new Set(extractEntities(opts.query, []))
      const entityOverlap = e.entities.filter((en) => qEntities.has(en.toLowerCase())).length
      score += entityOverlap * 0.06

      // Temporal decay: older entries desaturate (half-life 30 days)
      const decay = temporalDecay(e.lastAccessedAt ?? e.updatedAt, now)
      score *= decay

      // Access count bonus: frequently accessed entries get slight boost (log scale)
      const accessBonus = Math.log1p(e.accessCount) * 0.02
      score += accessBonus

      // Graph centrality bonus: well-connected entries are more important
      const graphBonus = Math.min(e.graphLinks.length * 0.015, 0.08)
      score += graphBonus

      // Phase 4: utility bonus — sessions that used this memory succeeded push it up (+0.4/win),
      // losses (-1) demote. Bounded at ±20 so a single rancid streak can't poison forever.
      const utility = (e.metadata.utility as number) ?? 0
      score += Math.max(-20, Math.min(20, utility)) * 0.04

      if (score >= minScore) scored.push({ ...e, _score: score, _rawScore: s, score })
    }
    scored.sort((a, b) => b._score - a._score)
    let top = scored.slice(0, limit)

    // 2. Graph expansion (hybrid): pull 1-hop neighbors of top results
    if (opts.hybrid !== false && top.length) {
      const seen = new Set(top.map((t) => t.id))
      const expanded: typeof scored = [...top]
      for (const t of top.slice(0, 3)) {
        for (const linkId of (t.graphLinks ?? []).slice(0, 3)) {
          if (seen.has(linkId)) continue
          const n = this.entries.get(linkId)
          if (n) {
            seen.add(linkId)
            const nEmb = n.embedding ?? embedKeyword(n.title + ' ' + n.content)
            const raw = cosine(qEmb, nEmb) * 0.7
            const decay = temporalDecay(n.lastAccessedAt ?? n.updatedAt, now)
            const accessBonus = Math.log1p(n.accessCount) * 0.02
            const graphBonus = Math.min(n.graphLinks.length * 0.015, 0.08)
            const score = raw * decay + accessBonus + graphBonus
            if (score >= minScore * 0.5) {
              expanded.push({ ...n, _score: score, _rawScore: raw, score })
            }
          }
        }
        // Also expand via entity overlap (1-hop entity neighbors)
        for (const ent of (t.entities ?? []).slice(0, 3)) {
          const ids = this.entityIndex.get(ent.toLowerCase())
          if (!ids) continue
          for (const eid of ids) {
            if (seen.has(eid)) continue
            const n = this.entries.get(eid)
            if (!n) continue
            seen.add(eid)
            const nEmb = n.embedding ?? embedKeyword(n.title + ' ' + n.content)
            const raw = cosine(qEmb, nEmb) * 0.6
            const decay = temporalDecay(n.lastAccessedAt ?? n.updatedAt, now)
            const score = raw * decay + 0.04 // entity bonus
            if (score >= minScore * 0.5) {
              expanded.push({ ...n, _score: score, _rawScore: raw, score })
            }
            if (expanded.length >= limit + 6) break
          }
        }
      }
      expanded.sort((a, b) => b._score - a._score)
      top = expanded.slice(0, limit)
    }

    // 3. Touch: update lastAccessedAt + accessCount for returned entries (temporal tracking)
    for (const t of top) {
      const e = this.entries.get(t.id)
      if (e) {
        e.lastAccessedAt = now
        e.accessCount = (e.accessCount ?? 0) + 1
        // persist async (best-effort, don't block retrieval)
        this.persist(e).catch(() => {})
      }
    }

    // 4. Assembly: return ranked entries (strip internal _score)
    return top.map(({ _score, _rawScore, ...e }) => e)
  }

  /** Direct lookup by id (also touches for temporal tracking) */
  get(id: string): MemoryEntry | undefined {
    const e = this.entries.get(id)
    if (e) {
      e.lastAccessedAt = Date.now()
      e.accessCount = (e.accessCount ?? 0) + 1
      this.persist(e).catch(() => {})
    }
    return e
  }

  /** List by tier/source (for debugging / TUI) */
  list(filter?: { tier?: MemoryTier; source?: MemorySource; limit?: number }): MemoryEntry[] {
    let arr = [...this.entries.values()]
    if (filter?.tier) arr = arr.filter((e) => e.tier === filter.tier)
    if (filter?.source) arr = arr.filter((e) => e.source === filter.source)
    arr.sort((a, b) => b.updatedAt - a.updatedAt)
    return arr.slice(0, filter?.limit ?? 50)
  }

  /** Number of entries (for health checks) */
  size(): number {
    return this.entries.size
  }

  /** Build a cognitive packet for prompt injection (HCM-style) */
  async buildCognitivePacket(query: string, limit = 6): Promise<string> {
    const memories = await this.retrieve({ query, limit })
    if (!memories.length) return ''
    const lines = memories.map(
      (m) => `- [${m.tier}/${m.source}] ${m.title}: ${m.content.slice(0, 220)}`,
    )
    return `## Relevant Memory (KnowledgeBase)\n${lines.join('\n')}`
  }

  /**
   * Build graph for MemoryGraph canvas: nodes + edges
   * Read-only, from existing knowledge_entries + findings (if db available)
   */
  async getGraph(limit = 100): Promise<KnowledgeGraph> {
    await this.load()
    const nodes: GraphNode[] = []
    const edges: GraphEdge[] = []
    const seenEdge = new Set<string>()

    // Knowledge nodes (most recent first, capped)
    const entries = [...this.entries.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)

    const entryIds = new Set(entries.map((e) => e.id))

    for (const e of entries) {
      nodes.push({
        id: e.id,
        label: e.title.slice(0, 60),
        tier: e.tier,
        source: e.source,
        tags: e.tags,
        entities: e.entities,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
        lastAccessedAt: e.lastAccessedAt,
        accessCount: e.accessCount,
        kind: 'knowledge',
      })
      // Edges from graphLinks (only to nodes in current slice)
      for (const target of e.graphLinks) {
        if (!entryIds.has(target)) continue
        const key = [e.id, target].sort().join('::')
        if (seenEdge.has(key)) continue
        seenEdge.add(key)
        edges.push({ from: e.id, to: target, kind: 'related' })
      }
    }

    // Entity-overlap edges (file → symbol → decision)
    // For each entity, connect entries sharing it (clique → star to avoid explosion)
    const entityGroups = new Map<string, string[]>()
    for (const e of entries) {
      for (const ent of e.entities) {
        const k = ent.toLowerCase()
        if (!entityGroups.has(k)) entityGroups.set(k, [])
        entityGroups.get(k)!.push(e.id)
      }
    }
    for (const [entity, ids] of entityGroups) {
      if (ids.length < 2 || ids.length > 8) continue // skip trivial or too dense
      // star: connect first to rest
      const hub = ids[0]!
      for (let i = 1; i < ids.length; i++) {
        const key = [hub, ids[i]!].sort().join('::entity::' + entity)
        if (seenEdge.has(key)) continue
        seenEdge.add(key)
        edges.push({ from: hub, to: ids[i]!, kind: 'entity', label: entity })
      }
    }

    // Findings as nodes + edges (if db available)
    if (this.deps.db?.sqlite) {
      try {
        const sqlite = this.deps.db.sqlite
        const findings = sqlite
          .prepare(
            `SELECT id, title, severity, status, created_at, updated_at FROM findings ORDER BY updated_at DESC LIMIT 50`,
          )
          .all() as Array<{
          id: string
          title: string
          severity: string
          status: string
          created_at: number
          updated_at: number
        }>
        for (const f of findings) {
          nodes.push({
            id: f.id,
            label: f.title.slice(0, 60),
            tier: 'episodic',
            source: 'system',
            tags: [f.severity, f.status],
            entities: extractEntities(f.title, []),
            createdAt: f.created_at,
            updatedAt: f.updated_at,
            lastAccessedAt: f.updated_at,
            accessCount: 0,
            kind: 'finding',
            severity: f.severity,
            status: f.status,
          })
        }
        // Link findings to knowledge entries via entity overlap (best-effort)
        for (const f of findings) {
          const fEntities = new Set(extractEntities(f.title, []).map((s) => s.toLowerCase()))
          for (const e of entries.slice(0, 30)) {
            const overlap = e.entities.filter((en) => fEntities.has(en.toLowerCase()))
            if (overlap.length) {
              const key = [f.id, e.id].sort().join('::finding')
              if (seenEdge.has(key)) continue
              seenEdge.add(key)
              edges.push({ from: f.id, to: e.id, kind: 'finding', label: overlap[0] })
            }
          }
        }
      } catch {}
    }

    return { nodes, edges }
  }

  // ── Internals ──────────────────────────────────────────────────────

  private indexEntry(e: MemoryEntry): void {
    for (const tag of e.tags) {
      const k = tag.toLowerCase()
      if (!this.tagIndex.has(k)) this.tagIndex.set(k, new Set())
      this.tagIndex.get(k)!.add(e.id)
    }
    for (const ent of e.entities) {
      const k = ent.toLowerCase()
      if (!this.entityIndex.has(k)) this.entityIndex.set(k, new Set())
      this.entityIndex.get(k)!.add(e.id)
    }
  }

  private findNeighbors(entry: MemoryEntry, k: number): MemoryEntry[] {
    const qEmb = entry.embedding!
    const scored: Array<{ e: MemoryEntry; s: number }> = []
    for (const other of this.entries.values()) {
      if (other.id === entry.id) continue
      const s = cosine(qEmb, other.embedding ?? embedKeyword(other.title + ' ' + other.content))
      scored.push({ e: other, s })
    }
    scored.sort((a, b) => b.s - a.s)
    return scored.slice(0, k).map((x) => x.e)
  }

  private findEntityNeighbors(entry: MemoryEntry, k: number): MemoryEntry[] {
    const entitySet = new Set(entry.entities.map((e) => e.toLowerCase()))
    if (!entitySet.size) return []
    const scored: Array<{ e: MemoryEntry; overlap: number }> = []
    for (const other of this.entries.values()) {
      if (other.id === entry.id) continue
      const overlap = other.entities.filter((en) => entitySet.has(en.toLowerCase())).length
      if (overlap > 0) scored.push({ e: other, overlap })
    }
    scored.sort((a, b) => b.overlap - a.overlap)
    return scored.slice(0, k).map((x) => x.e)
  }

  private async persist(entry: MemoryEntry): Promise<void> {
    const sqlite = this.deps.db?.sqlite
    if (!sqlite) return
    // Include legacy `kind` + `session_id` for backward compat with old DBs where kind NOT NULL
    const kind = entry.tier
    const sessionId =
      ((entry.metadata as Record<string, unknown>)?.sessionID as string | null) ?? null
    try {
      sqlite
        .prepare(
          `INSERT OR REPLACE INTO knowledge_entries
          (id, session_id, kind, tier, source, title, content, tags, graph_links, embedding, metadata, created_at, updated_at, last_accessed_at, access_count, entities)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entry.id,
          sessionId,
          kind,
          entry.tier,
          entry.source,
          entry.title,
          entry.content,
          JSON.stringify(entry.tags),
          JSON.stringify(entry.graphLinks),
          JSON.stringify(entry.embedding ?? null),
          JSON.stringify(entry.metadata),
          entry.createdAt,
          entry.updatedAt,
          entry.lastAccessedAt,
          entry.accessCount,
          JSON.stringify(entry.entities),
        )
    } catch (e) {
      // Fallback for DBs where new columns don't exist yet (should not happen after migrate, but be safe)
      try {
        sqlite
          .prepare(
            `INSERT OR REPLACE INTO knowledge_entries
            (id, tier, source, title, content, tags, graph_links, embedding, metadata, created_at, updated_at, last_accessed_at, access_count, entities)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            entry.id,
            entry.tier,
            entry.source,
            entry.title,
            entry.content,
            JSON.stringify(entry.tags),
            JSON.stringify(entry.graphLinks),
            JSON.stringify(entry.embedding ?? null),
            JSON.stringify(entry.metadata),
            entry.createdAt,
            entry.updatedAt,
            entry.lastAccessedAt,
            entry.accessCount,
            JSON.stringify(entry.entities),
          )
      } catch {}
    }
  }
}

// ── Temporal decay ─────────────────────────────────────────────────
// Half-life 30 days: score *= 0.5^(ageDays/30)
// Recent entries keep ~1.0, 30d old → 0.5, 60d → 0.25, 90d → 0.125
const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000

export function temporalDecay(lastAccessedAt: number, now = Date.now()): number {
  const ageMs = Math.max(0, now - lastAccessedAt)
  const ageDays = ageMs / (24 * 60 * 60 * 1000)
  // exponential decay with half-life
  const decay = Math.pow(0.5, ageDays / 30)
  // floor at 0.1 so very old entries don't vanish entirely
  return Math.max(0.1, decay)
}

// ── Entity extraction (file → symbol → decision) ───────────────────
export function extractEntities(text: string, tags: string[]): string[] {
  const entities = new Set<string>()
  // File paths: src/foo/bar.ts, packages/server/src/learning/knowledge.ts
  const fileRe = /\b[\w@./-]+\.(ts|js|tsx|jsx|md|json|py|rs|go)\b/g
  let m: RegExpExecArray | null
  while ((m = fileRe.exec(text)) !== null) {
    const f = m[0].slice(0, 120)
    // keep last 2 segments for dedup (e.g. learning/knowledge.ts)
    const parts = f.split('/')
    const short = parts.slice(-2).join('/')
    entities.add(short)
    if (f !== short) entities.add(f)
  }
  // Symbols: CamelCase or snake_case identifiers (heuristic)
  const symRe = /\b[A-Z][a-z]+[A-Z][a-zA-Z]+\b/g // CamelCase like KnowledgeBase, MemoryEntry
  while ((m = symRe.exec(text)) !== null) {
    entities.add(m[0])
  }
  // Decision / concept tags: already in tags, promote to entities
  for (const t of tags) {
    if (t.length >= 2 && t.length <= 40) entities.add(t)
  }
  // Also extract file-like from tags (e.g. "src/learning")
  for (const t of tags) {
    if (t.includes('/') || t.includes('.')) entities.add(t)
  }
  return [...entities].slice(0, 12)
}

// ── Helpers ────────────────────────────────────────────────────────
function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

// ── Keyword embedding (offline, deterministic, no API key) ───────────
// Hashes text into a fixed 64-dim unit vector via token hashing.
// Swap with real embeddings (OpenAI / Voyage / local) by injecting via
// `embedFn` — the cosine retrieval stays the same.

const EMBED_DIM = 64

export function embedKeyword(text: string): number[] {
  const vec = new Array(EMBED_DIM).fill(0)
  const tokens = text
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length >= 2)
  for (const tok of tokens) {
    let h = 0
    for (let i = 0; i < tok.length; i++) h = (Math.imul(31, h) + tok.charCodeAt(i)) | 0
    const idx = Math.abs(h) % EMBED_DIM
    vec[idx] += 1
  }
  // L2 normalize
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1
  return vec.map((v) => v / norm)
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
