/**
 * Mira Memory — Hybrid Retrieval (vector + graph + rerank + assembly)
 *
 * Pipeline (O'Reilly 2026 stack #3):
 *   query → embed → [vector search (episodic|semantic|procedural) ∥ graph expand]
 *         → RRF fusion → MMR diversity → assembly (Cognitive Packet)
 *
 * Also merges external providers (Zep / Mem0) when configured.
 */

import { hashEmbedding, cosineSimilarity } from "./store.js"
import type { MemoryStore, MemoryProvider } from "./store.js"
import type { EpisodicMemory } from "./episodic.js"
import type { SemanticMemory } from "./semantic.js"
import type { ProceduralMemory } from "./procedural.js"

export type HitKind = "episodic" | "semantic" | "procedural" | "external"

export interface Hit {
  kind: HitKind
  id: string
  content: string
  score: number // fused 0..1
  metadata?: any
  source?: string // provider name when external
}

export interface RetrieveOpts {
  userId?: string
  sessionId?: string
  kinds?: HitKind[] // default all
  limit?: number // final hits (default 8)
  vectorLimit?: number // per-layer candidates (default 8)
  includeExternal?: boolean // default true if providers present
  graphHops?: number // semantic graph expansion (default 1)
  mmrLambda?: number // 0..1 diversity vs relevance (default 0.7)
}

export interface CognitivePacket {
  query: string
  hits: Hit[]
  context: string // assembled prompt injection
  sources: Record<HitKind, number>
}

export class HybridRetriever {
  constructor(
    private store: MemoryStore,
    private episodic: EpisodicMemory,
    private semantic: SemanticMemory,
    private procedural: ProceduralMemory,
    private providers: MemoryProvider[] = [],
  ) {}

  async retrieve(query: string, opts: RetrieveOpts = {}): Promise<CognitivePacket> {
    const kinds = opts.kinds ?? ["episodic", "semantic", "procedural", "external"]
    const vectorLimit = opts.vectorLimit ?? 8
    const limit = opts.limit ?? 8
    const graphHops = opts.graphHops ?? 1

    // ── 1. Parallel vector search per layer ─────────────────────────
    const tasks: Promise<Hit[]>[] = []
    if (kinds.includes("episodic")) tasks.push(
      this.episodic.search(query, { userId: opts.userId, sessionId: opts.sessionId, limit: vectorLimit })
        .then(rs => rs.map(r => ({ kind: "episodic" as const, id: r.id, content: r.content, score: r.score, metadata: { sessionId: r.sessionId, type: r.type, createdAt: r.createdAt } })))
        .catch(() => [])
    )
    if (kinds.includes("semantic")) tasks.push(
      this.semantic.search(query, { userId: opts.userId, limit: vectorLimit })
        .then(rs => rs.map(r => ({ kind: "semantic" as const, id: r.id, content: r.content, score: r.score, metadata: { subject: r.subject, predicate: r.predicate, object: r.object, confidence: r.confidence } })))
        .catch(() => [])
    )
    if (kinds.includes("procedural")) tasks.push(
      this.procedural.match(query, vectorLimit)
        .then(rs => rs.map(r => ({ kind: "procedural" as const, id: r.id, content: `Skill ${r.name}: ${r.description}\n${r.body.slice(0, 600)}`, score: r.score, metadata: { name: r.name, triggers: r.triggers } })))
        .catch(() => [])
    )
    if (kinds.includes("external") && opts.includeExternal !== false && this.providers.length) {
      for (const p of this.providers) {
        tasks.push(
          p.search(query, { userId: opts.userId, limit: vectorLimit })
            .then(rs => rs.map(r => ({ kind: "external" as const, id: `${p.name}:${hashStr(r.content).slice(0, 8)}`, content: r.content, score: r.score * 0.95, metadata: r.metadata, source: p.name })))
            .catch(() => [])
        )
      }
    }

    const groups = await Promise.all(tasks)
    let candidates: Hit[] = groups.flat()

    // ── 2. Graph expansion (semantic facts → neighbors) ─────────────
    if (graphHops > 0 && kinds.includes("semantic")) {
      const semHits = candidates.filter(h => h.kind === "semantic").slice(0, 3)
      for (const h of semHits) {
        try {
          const neighbors = await this.semantic.expand(h.id, graphHops, 5)
          for (const n of neighbors) {
            // avoid dupes
            if (candidates.some(c => c.id === n.id)) continue
            // graph hit gets discounted score
            candidates.push({ kind: "semantic", id: n.id, content: n.content, score: h.score * 0.6, metadata: { via: h.id, predicate: (n as any).predicate } })
          }
        } catch {}
      }
    }

    // ── 3. RRF fusion (dedupe + rank by reciprocal rank fusion) ─────
    // Each layer's hits have rank; fuse: score_rrf = Σ 1/(k + rank)
    const rrfK = 60
    const byId = new Map<string, { hit: Hit; rrf: number; bestScore: number }>()
    // rebuild per-layer ranking
    let offset = 0
    for (const group of groups) {
      for (let rank = 0; rank < group.length; rank++) {
        const h = group[rank]!
        const key = `${h.kind}:${h.id}`
        const entry = byId.get(key) ?? { hit: h, rrf: 0, bestScore: 0 }
        entry.rrf += 1 / (rrfK + rank + 1)
        entry.bestScore = Math.max(entry.bestScore, h.score)
        // keep best content
        if (h.score > entry.hit.score) entry.hit = h
        byId.set(key, entry)
      }
      offset += group.length
    }
    // also include graph-expanded not in RRF groups
    for (const h of candidates) {
      const key = `${h.kind}:${h.id}`
      if (!byId.has(key)) byId.set(key, { hit: h, rrf: 0.5 / rrfK, bestScore: h.score })
    }

    const fused: Hit[] = [...byId.values()]
      .map(({ hit, rrf, bestScore }) => ({ ...hit, score: rrf * 0.5 + bestScore * 0.5 }))
      .sort((a, b) => b.score - a.score)

    // ── 4. MMR diversity reranking ──────────────────────────────────
    const diversified = await mmrRerank(query, fused, opts.mmrLambda ?? 0.7, limit, this.store)

    // ── 5. Assembly (Cognitive Packet) ──────────────────────────────
    const context = assemble(diversified, query)
    const sources: Record<HitKind, number> = { episodic: 0, semantic: 0, procedural: 0, external: 0 }
    for (const h of diversified) sources[h.kind]++

    return { query, hits: diversified, context, sources }
  }

  /** Convenience: format for LLM prompt injection */
  formatForPrompt(packet: CognitivePacket, budget = 4000): string {
    let s = packet.context
    if (s.length > budget) s = s.slice(0, budget) + "\n…(truncated)"
    return s
  }
}

// ── MMR: Maximal Marginal Relevance ───────────────────────────────────
async function mmrRerank(query: string, hits: Hit[], lambda: number, limit: number, store: MemoryStore): Promise<Hit[]> {
  if (hits.length <= limit) return hits
  // embed query + hits
  let qEmb: number[] | null = null
  try { qEmb = await store.embed(query) } catch { qEmb = hashEmbedding(query) }
  const embs: (number[] | null)[] = []
  for (const h of hits) {
    try { embs.push(await store.embed(h.content.slice(0, 800))) } catch { embs.push(hashEmbedding(h.content.slice(0, 800))) }
  }

  const selected: Hit[] = []
  const remaining = [...hits]
  const remEmbs = [...embs]

  while (selected.length < limit && remaining.length) {
    let bestIdx = 0, bestMMR = -Infinity
    for (let i = 0; i < remaining.length; i++) {
      const rel = remaining[i]!.score // already 0..1
      // max cosine to any selected
      let maxSim = 0
      if (selected.length && qEmb && embs[i]) {
        // compute sim to selected hits via embeddings
        for (let j = 0; j < selected.length; j++) {
          const selIdx = hits.indexOf(selected[j]!)
          const e = selIdx >= 0 ? embs[selIdx] : null
          if (e && remEmbs[i]) maxSim = Math.max(maxSim, cosineSimilarity(remEmbs[i]!, e))
        }
        // also lexical overlap quick check
        maxSim = Math.max(maxSim, maxLexicalOverlap(remaining[i]!.content, selected.map(s => s.content)))
      }
      const mmr = lambda * rel - (1 - lambda) * maxSim
      if (mmr > bestMMR) { bestMMR = mmr; bestIdx = i }
    }
    selected.push(remaining[bestIdx]!)
    remaining.splice(bestIdx, 1)
    remEmbs.splice(bestIdx, 1)
  }
  return selected
}

function maxLexicalOverlap(text: string, others: string[]): number {
  const a = new Set(text.toLowerCase().split(/\W+/).filter(Boolean))
  let m = 0
  for (const o of others) {
    const b = new Set(o.toLowerCase().split(/\W+/).filter(Boolean))
    let inter = 0; for (const w of a) if (b.has(w)) inter++
    const j = a.size && b.size ? inter / Math.min(a.size, b.size) : 0
    m = Math.max(m, j)
  }
  return m * 0.5 // downweight lexical vs embedding sim
}

function assemble(hits: Hit[], query: string): string {
  if (!hits.length) return `No relevant memory for: "${query}"`
  const byKind: Record<string, Hit[]> = {}
  for (const h of hits) (byKind[h.kind] ??= []).push(h)
  const sections: string[] = []
  sections.push(`# Memory — "${query}" (${hits.length} hits)`)
  for (const kind of ["semantic", "episodic", "procedural", "external"] as const) {
    const arr = byKind[kind]
    if (!arr?.length) continue
    const label = kind === "semantic" ? "Facts & Preferences" : kind === "episodic" ? "Recent Episodes" : kind === "procedural" ? "Skills" : "External (Zep/Mem0)"
    sections.push(`\n## ${label}`)
    for (const h of arr) {
      const src = h.source ? ` [${h.source}]` : ""
      sections.push(`- (${h.score.toFixed(2)}) ${h.content.slice(0, 400).replace(/\n/g, " ")}${src}`)
    }
  }
  return sections.join("\n")
}

function hashStr(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i) | 0
  return Math.abs(h).toString(36)
}
