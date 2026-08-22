/**
 * Mira Memory — Semantic (L3)
 * Facts, preferences, entities — the knowledge graph.
 * Subject-predicate-object triples + freeform content, with embeddings.
 */

import { memoryFacts, memoryEdges } from "./store.js"
import { parseEmbedding, serializeEmbedding, hashEmbedding, cosineSimilarity } from "./store.js"
import type { MemoryStore } from "./store.js"

export type FactKind = "fact" | "preference" | "entity"

export interface Fact {
  id: string
  userId: string
  kind: FactKind
  subject?: string | null
  predicate?: string | null
  object?: string | null
  content: string
  confidence: number
  embedding?: number[] | null
  metadata?: Record<string, unknown> | null
  createdAt: number
  updatedAt: number
}

export interface Edge {
  id: string
  sourceId: string
  targetId: string
  predicate: string
  weight: number
  createdAt: number
}

function uid() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` }

export class SemanticMemory {
  constructor(private store: MemoryStore) {}

  /** Upsert a fact/preference. Deduplicates by (userId, content) hash. */
  async remember(content: string, opts: {
    userId?: string
    kind?: FactKind
    subject?: string; predicate?: string; object?: string
    confidence?: number
    metadata?: Record<string, unknown>
  } = {}): Promise<Fact> {
    const userId = opts.userId ?? "default"
    const kind = opts.kind ?? "fact"
    const now = Date.now()
    const embedding = await this.store.embed(content).catch(() => hashEmbedding(content))

    // dedup: if same content exists, bump confidence + update
    const existing = await this.findByContent(content, userId)
    if (existing) {
      const updated: Fact = {
        ...existing,
        kind, subject: opts.subject ?? existing.subject,
        predicate: opts.predicate ?? existing.predicate,
        object: opts.object ?? existing.object,
        confidence: Math.min(1, Math.max(existing.confidence, opts.confidence ?? 0.85)),
        embedding, updatedAt: now,
      }
      await this.persist(updated)
      return updated
    }

    const fact: Fact = {
      id: uid(), userId, kind,
      subject: opts.subject ?? null, predicate: opts.predicate ?? null, object: opts.object ?? null,
      content, confidence: opts.confidence ?? 0.8,
      embedding, metadata: opts.metadata ?? null,
      createdAt: now, updatedAt: now,
    }
    await this.persist(fact)
    return fact
  }

  /** Preference convenience: `rememberPreference("theme", "dark")` */
  async rememberPreference(key: string, value: string, userId = "default"): Promise<Fact> {
    return this.remember(`user prefers ${key} = ${value}`, {
      userId, kind: "preference", subject: "user", predicate: key, object: value, confidence: 0.95,
    })
  }

  async getPreference(key: string, userId = "default"): Promise<string | null> {
    const facts = await this.list({ userId, kind: "preference", limit: 100 })
    const hit = facts.find(f => f.predicate === key || f.content.includes(`${key} =`) || f.content.includes(`${key}:`))
    if (!hit) return null
    return hit.object ?? hit.content.split("=").pop()?.trim() ?? null
  }

  async list(opts: { userId?: string; kind?: FactKind; limit?: number } = {}): Promise<Fact[]> {
    const userId = opts.userId ?? "default"
    const db = this.store.db
    try {
      if (db.sqlite) {
        let sql = `SELECT * FROM memory_facts WHERE user_id = ?`
        const params: any[] = [userId]
        if (opts.kind) { sql += ` AND kind = ?`; params.push(opts.kind) }
        sql += ` ORDER BY updated_at DESC LIMIT ?`; params.push(opts.limit ?? 50)
        const rows = db.sqlite.prepare(sql).all(...params) as any[]
        return rows.map(toFactFromRaw)
      }
      if (db.query?.memoryFacts) {
        const rows: any[] = await db.query.memoryFacts.findMany({
          where: (t: any, { eq, and }: any) => opts.kind ? and(eq(t.userId, userId), eq(t.kind, opts.kind)) : eq(t.userId, userId),
          orderBy: (t: any, { desc }: any) => [desc(t.updatedAt)],
          limit: opts.limit ?? 50,
        })
        return rows.map(toFact)
      }
    } catch {}
    return []
  }

  /** Vector search over semantic memory */
  async search(query: string, opts: { userId?: string; kind?: FactKind; limit?: number } = {}): Promise<(Fact & { score: number })[]> {
    const limit = opts.limit ?? 5
    const qEmb = await this.store.embed(query).catch(() => hashEmbedding(query))
    const candidates = await this.list({ userId: opts.userId, kind: opts.kind, limit: 300 })
    const scored = candidates.map(f => {
      const emb = f.embedding ?? null
      let score = emb ? cosineSimilarity(qEmb, emb) : lexicalScore(query, f.content)
      // preference boost
      if (f.kind === "preference") score += 0.05
      // confidence weighting
      score = score * (0.7 + f.confidence * 0.3)
      return { ...f, score }
    }).sort((a, b) => b.score - a.score).slice(0, limit)
    return scored
  }

  /** Graph: link two facts/entities */
  async link(sourceId: string, targetId: string, predicate: string, weight = 1.0): Promise<Edge> {
    const edge: Edge = { id: uid(), sourceId, targetId, predicate, weight, createdAt: Date.now() }
    const db = this.store.db
    try {
      if (db.insert) {
        await db.insert(memoryEdges).values({
          id: edge.id, sourceId, targetId, predicate, weight, createdAt: edge.createdAt,
        } as any)
      } else if (db.sqlite) {
        db.sqlite.prepare(
          `INSERT INTO memory_edges (id, source_id, target_id, predicate, weight, created_at) VALUES (?, ?, ?, ?, ?, ?)`
        ).run(edge.id, sourceId, targetId, predicate, weight, edge.createdAt)
      }
    } catch (e) { console.warn("[semantic] link failed", (e as Error).message) }
    return edge
  }

  async getEdges(nodeId: string, limit = 20): Promise<Edge[]> {
    const db = this.store.db
    try {
      if (db.sqlite) {
        const rows = db.sqlite.prepare(
          `SELECT * FROM memory_edges WHERE source_id = ? OR target_id = ? ORDER BY created_at DESC LIMIT ?`
        ).all(nodeId, nodeId, limit) as any[]
        return rows.map((r: any) => ({ id: r.id, sourceId: r.source_id, targetId: r.target_id, predicate: r.predicate, weight: r.weight, createdAt: r.created_at }))
      }
      if (db.query?.memoryEdges) {
        const rows: any[] = await db.query.memoryEdges.findMany({
          where: (t: any, { or, eq }: any) => or(eq(t.sourceId, nodeId), eq(t.targetId, nodeId)),
          orderBy: (t: any, { desc }: any) => [desc(t.createdAt)], limit,
        })
        return rows.map((r: any) => ({ id: r.id, sourceId: r.sourceId, targetId: r.targetId, predicate: r.predicate, weight: r.weight, createdAt: r.createdAt }))
      }
    } catch {}
    return []
  }

  /** Walk graph N hops from a fact */
  async expand(factId: string, hops = 1, limit = 20): Promise<Fact[]> {
    const visited = new Set<string>([factId])
    let frontier = [factId]
    const results: Fact[] = []
    for (let h = 0; h < hops; h++) {
      const next: string[] = []
      for (const id of frontier) {
        const edges = await this.getEdges(id, limit)
        for (const e of edges) {
          const nid = e.sourceId === id ? e.targetId : e.sourceId
          if (visited.has(nid)) continue
          visited.add(nid); next.push(nid)
          const f = await this.getById(nid)
          if (f) results.push(f)
        }
      }
      frontier = next
      if (!frontier.length) break
    }
    return results.slice(0, limit)
  }

  // ── private ──────────────────────────────────────────────────────
  private async findByContent(content: string, userId: string): Promise<Fact | null> {
    const db = this.store.db
    try {
      if (db.sqlite) {
        const row = db.sqlite.prepare(`SELECT * FROM memory_facts WHERE user_id = ? AND content = ? LIMIT 1`).get(userId, content) as any
        return row ? toFactFromRaw(row) : null
      }
      if (db.query?.memoryFacts) {
        const row: any = await db.query.memoryFacts.findFirst({
          where: (t: any, { and, eq }: any) => and(eq(t.userId, userId), eq(t.content, content)),
        })
        return row ? toFact(row) : null
      }
    } catch {}
    return null
  }

  private async getById(id: string): Promise<Fact | null> {
    const db = this.store.db
    try {
      if (db.sqlite) {
        const row = db.sqlite.prepare(`SELECT * FROM memory_facts WHERE id = ? LIMIT 1`).get(id) as any
        return row ? toFactFromRaw(row) : null
      }
      if (db.query?.memoryFacts) {
        const row: any = await db.query.memoryFacts.findFirst({ where: (t: any, { eq }: any) => eq(t.id, id) })
        return row ? toFact(row) : null
      }
    } catch {}
    return null
  }

  private async persist(f: Fact): Promise<void> {
    const db = this.store.db
    try {
      if (db.insert) {
        // upsert via insert+onConflict if supported; fallback to insert-or-replace
        await db.insert(memoryFacts).values({
          id: f.id, userId: f.userId, kind: f.kind,
          subject: f.subject, predicate: f.predicate, object: f.object,
          content: f.content, confidence: f.confidence,
          embedding: serializeEmbedding(f.embedding ?? null),
          metadata: f.metadata ?? null,
          createdAt: f.createdAt, updatedAt: f.updatedAt,
        } as any).onConflictDoUpdate?.({
          target: memoryFacts.id as any,
          set: { content: f.content, confidence: f.confidence, embedding: serializeEmbedding(f.embedding ?? null), updatedAt: f.updatedAt } as any,
        } as any) ?? await db.insert(memoryFacts).values({
          id: f.id, userId: f.userId, kind: f.kind, subject: f.subject, predicate: f.predicate, object: f.object,
          content: f.content, confidence: f.confidence, embedding: serializeEmbedding(f.embedding ?? null),
          metadata: f.metadata ?? null, createdAt: f.createdAt, updatedAt: f.updatedAt,
        } as any)
        return
      }
      if (db.sqlite) {
        db.sqlite.prepare(
          `INSERT INTO memory_facts (id, user_id, kind, subject, predicate, object, content, confidence, embedding, metadata, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET content=excluded.content, confidence=excluded.confidence, embedding=excluded.embedding, updated_at=excluded.updated_at`
        ).run(f.id, f.userId, f.kind, f.subject, f.predicate, f.object, f.content, f.confidence, serializeEmbedding(f.embedding ?? null), JSON.stringify(f.metadata ?? null), f.createdAt, f.updatedAt)
      }
    } catch (e) {
      // last resort: plain insert
      try { if (db.sqlite) db.sqlite.prepare(`INSERT OR REPLACE INTO memory_facts (id, user_id, kind, subject, predicate, object, content, confidence, embedding, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(f.id, f.userId, f.kind, f.subject, f.predicate, f.object, f.content, f.confidence, serializeEmbedding(f.embedding ?? null), JSON.stringify(f.metadata ?? null), f.createdAt, f.updatedAt) } catch {}
    }
  }
}

function toFact(row: any): Fact {
  return {
    id: row.id, userId: row.userId ?? row.user_id, kind: row.kind,
    subject: row.subject, predicate: row.predicate, object: row.object,
    content: row.content, confidence: row.confidence,
    embedding: parseEmbedding(row.embedding), metadata: row.metadata ?? null,
    createdAt: row.createdAt ?? row.created_at, updatedAt: row.updatedAt ?? row.updated_at,
  }
}
function toFactFromRaw(row: any): Fact {
  const f = toFact(row)
  if (typeof f.metadata === "string") { try { f.metadata = JSON.parse(f.metadata as any) } catch {} }
  return f
}
function lexicalScore(q: string, t: string): number {
  const qs = new Set(q.toLowerCase().split(/\W+/).filter(Boolean))
  const ts = new Set(t.toLowerCase().split(/\W+/).filter(Boolean))
  let inter = 0; for (const w of qs) if (ts.has(w)) inter++
  return qs.size ? inter / qs.size : 0
}
