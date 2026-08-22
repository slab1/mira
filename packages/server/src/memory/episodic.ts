/**
 * Mira Memory — Episodic (L2)
 * Session traces + events. Every tool call / message / decision is an episode.
 * Compaction → rolling summary to stay within context window.
 */

import { memoryEpisodes } from "./store.js"
import { cosineSimilarity, parseEmbedding, serializeEmbedding, hashEmbedding } from "./store.js"
import type { MemoryStore } from "./store.js"

export type EpisodeType = "event" | "summary" | "compaction"

export interface Episode {
  id: string
  sessionId: string
  userId: string
  type: EpisodeType
  content: string
  embedding?: number[] | null
  metadata?: Record<string, unknown> | null
  createdAt: number
}

export interface RecordOpts {
  userId?: string
  type?: EpisodeType
  metadata?: Record<string, unknown>
  embed?: boolean // default true
}

function uid() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` }

export class EpisodicMemory {
  constructor(private store: MemoryStore) {}

  /** Record an event (tool call, message, decision) */
  async record(sessionId: string, content: string, opts: RecordOpts = {}): Promise<Episode> {
    const id = uid()
    const userId = opts.userId ?? "default"
    const type = opts.type ?? "event"
    const createdAt = Date.now()
    const shouldEmbed = opts.embed !== false
    const embedding = shouldEmbed ? await this.store.embed(content).catch(() => hashEmbedding(content)) : null

    // persist
    try {
      const db = this.store.db
      // drizzle sqlite insert
      if (db.insert) {
        await db.insert(memoryEpisodes).values({
          id, sessionId, userId, type, content,
          embedding: serializeEmbedding(embedding),
          metadata: opts.metadata ?? null,
          createdAt,
        } as any)
      } else if (db.sqlite) {
        db.sqlite.prepare(
          `INSERT INTO memory_episodes (id, session_id, user_id, type, content, embedding, metadata, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, sessionId, userId, type, content, serializeEmbedding(embedding), JSON.stringify(opts.metadata ?? null), createdAt)
      }
    } catch (e) {
      // best-effort — still return episode if DB unavailable
      console.warn("[episodic] insert failed", (e as Error).message)
    }

    return { id, sessionId, userId, type, content, embedding, metadata: opts.metadata ?? null, createdAt }
  }

  /** Fetch recent episodes for a session (chronological) */
  async getSession(sessionId: string, limit = 50): Promise<Episode[]> {
    const db = this.store.db
    try {
      if (db.query?.memoryEpisodes) {
        const rows: any[] = await db.query.memoryEpisodes.findMany({
          where: (t: any, { eq }: any) => eq(t.sessionId, sessionId),
          orderBy: (t: any, { desc }: any) => [desc(t.createdAt)],
          limit,
        })
        return rows.reverse().map(toEpisode)
      }
      if (db.sqlite) {
        const rows = db.sqlite.prepare(
          `SELECT * FROM memory_episodes WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`
        ).all(sessionId, limit) as any[]
        return rows.reverse().map(toEpisodeFromRaw)
      }
    } catch {}
    return []
  }

  /** Vector search within episodic layer */
  async search(query: string, opts: { userId?: string; sessionId?: string; limit?: number } = {}): Promise<(Episode & { score: number })[]> {
    const limit = opts.limit ?? 5
    const qEmb = await this.store.embed(query).catch(() => hashEmbedding(query))
    const db = this.store.db
    let candidates: Episode[] = []

    try {
      if (db.sqlite) {
        // SQLite: scan recent 500, JS cosine
        const rows = db.sqlite.prepare(
          `SELECT * FROM memory_episodes ${opts.userId ? "WHERE user_id = ?" : ""} ORDER BY created_at DESC LIMIT 500`
        ).all(...(opts.userId ? [opts.userId] : [])) as any[]
        candidates = rows.map(toEpisodeFromRaw).filter(e => !opts.sessionId || e.sessionId === opts.sessionId)
      } else if (db.query?.memoryEpisodes) {
        const rows: any[] = await db.query.memoryEpisodes.findMany({ limit: 500, orderBy: (t: any, { desc }: any) => [desc(t.createdAt)] })
        candidates = rows.map(toEpisode).filter(e => (!opts.userId || e.userId === opts.userId) && (!opts.sessionId || e.sessionId === opts.sessionId))
      }
    } catch { candidates = [] }

    // Score with cosine; fallback to lexical overlap if no embeddings
    const scored = candidates.map(e => {
      const emb = e.embedding ?? parseEmbedding((e as any).__rawEmbedding ?? null)
      let score = 0
      if (emb && qEmb) score = cosineSimilarity(qEmb, emb)
      else score = lexicalScore(query, e.content)
      // small recency boost
      const ageHours = (Date.now() - e.createdAt) / 3_600_000
      score = score * 0.9 + Math.exp(-ageHours / 24) * 0.1
      return { ...e, score }
    }).sort((a, b) => b.score - a.score).slice(0, limit)

    return scored
  }

  /** Compact a session: summarize first N episodes into a summary episode */
  async compact(sessionId: string, keepLast = 20): Promise<Episode | null> {
    const all = await this.getSession(sessionId, 500)
    if (all.length <= keepLast) return null
    const toSummarize = all.slice(0, all.length - keepLast)
    const summary = `Session ${sessionId} summary (${toSummarize.length} events):\n` +
      toSummarize.map(e => `- [${e.type}] ${e.content.slice(0, 120)}`).join("\n")
    return this.record(sessionId, summary, { type: "compaction", metadata: { compacted: toSummarize.length } })
  }

  /** Sessions list for a user */
  async listSessions(userId = "default", limit = 20): Promise<string[]> {
    const db = this.store.db
    try {
      if (db.sqlite) {
        const rows = db.sqlite.prepare(
          `SELECT DISTINCT session_id FROM memory_episodes WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`
        ).all(userId, limit) as any[]
        return rows.map((r: any) => r.session_id)
      }
      if (db.query?.memoryEpisodes) {
        const rows: any[] = await db.query.memoryEpisodes.findMany({
          where: (t: any, { eq }: any) => eq(t.userId, userId),
          orderBy: (t: any, { desc }: any) => [desc(t.createdAt)],
          limit: limit * 3,
        })
        return [...new Set(rows.map((r: any) => r.sessionId))].slice(0, limit)
      }
    } catch {}
    return []
  }
}

function toEpisode(row: any): Episode {
  return {
    id: row.id, sessionId: row.sessionId ?? row.session_id, userId: row.userId ?? row.user_id,
    type: row.type, content: row.content,
    embedding: parseEmbedding(row.embedding),
    metadata: row.metadata ?? null, createdAt: row.createdAt ?? row.created_at,
  }
}
function toEpisodeFromRaw(row: any): Episode {
  const ep = toEpisode(row)
  ;(ep as any).__rawEmbedding = row.embedding
  if (typeof ep.metadata === "string") { try { ep.metadata = JSON.parse(ep.metadata) } catch {} }
  return ep
}

function lexicalScore(query: string, text: string): number {
  const q = new Set(query.toLowerCase().split(/\W+/).filter(Boolean))
  const t = new Set(text.toLowerCase().split(/\W+/).filter(Boolean))
  let inter = 0
  for (const w of q) if (t.has(w)) inter++
  return q.size ? inter / q.size : 0
}
