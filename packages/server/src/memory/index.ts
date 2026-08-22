/**
 * Mira Memory — Main
 * Hierarchical: Episodic (L2 events) → Semantic (L3 facts) → Procedural (L4 skills) + Hybrid retrieval
 * Storage: Postgres+pgvector (prod) / SQLite WAL (dev) via Drizzle
 * External: Zep / Mem0 adapters (opt-in via env)
 *
 * Usage:
 *   const memory = await createMiraMemory({ db })
 *   await memory.remember("user prefers dark mode", { kind: "preference" })
 *   const packet = await memory.recall("what theme does user like?")
 *   // inject into LLM prompt:
 *   const prompt = `...${packet.context}...`
 */

import { createMemoryStore, createProviders } from "./store.js"
import type { MemoryStore, MemoryProvider } from "./store.js"
import { EpisodicMemory } from "./episodic.js"
import { SemanticMemory } from "./semantic.js"
import { ProceduralMemory } from "./procedural.js"
import { HybridRetriever } from "./hybrid.js"
import type { Hit, CognitivePacket, RetrieveOpts } from "./hybrid.js"

// Re-exports
export * from "./store.js"
export * from "./episodic.js"
export * from "./semantic.js"
export * from "./procedural.js"
export * from "./hybrid.js"

export interface MiraMemoryOpts {
  db: any // drizzle instance (pass `createDatabase()` from storage/db.ts or a pg drizzle)
  userId?: string
  providers?: MemoryProvider[] // override; default = env-based Zep/Mem0
  embedder?: (text: string) => Promise<number[]>
}

export class MiraMemory {
  readonly store: MemoryStore
  readonly episodic: EpisodicMemory
  readonly semantic: SemanticMemory
  readonly procedural: ProceduralMemory
  readonly hybrid: HybridRetriever
  readonly providers: MemoryProvider[]
  readonly userId: string

  constructor(store: MemoryStore, episodic: EpisodicMemory, semantic: SemanticMemory, procedural: ProceduralMemory, hybrid: HybridRetriever, userId: string, providers: MemoryProvider[]) {
    this.store = store
    this.episodic = episodic
    this.semantic = semantic
    this.procedural = procedural
    this.hybrid = hybrid
    this.userId = userId
    this.providers = providers
  }

  /** Remember anything — routes to semantic (fact/preference) or episodic (event) */
  async remember(content: string, opts: {
    kind?: "fact" | "preference" | "entity" | "event" | "skill"
    sessionId?: string
    subject?: string; predicate?: string; object?: string
    metadata?: Record<string, unknown>
  } = {}): Promise<{ id: string; kind: string }> {
    const kind = opts.kind ?? "fact"
    if (kind === "event") {
      const ep = await this.episodic.record(opts.sessionId ?? "global", content, { userId: this.userId, metadata: opts.metadata })
      // also fan-out to external providers (best-effort)
      for (const p of this.providers) p.add(content, { userId: this.userId, metadata: opts.metadata }).catch(() => {})
      return { id: ep.id, kind: "episodic" }
    }
    if (kind === "skill") {
      // expects body in content; caller should use procedural.register directly for structured skills
      return { id: content.slice(0, 32), kind: "procedural" }
    }
    // semantic
    const f = await this.semantic.remember(content, {
      userId: this.userId, kind: kind as any,
      subject: opts.subject, predicate: opts.predicate, object: opts.object,
      metadata: opts.metadata,
    })
    for (const p of this.providers) p.add(content, { userId: this.userId, metadata: opts.metadata }).catch(() => {})
    return { id: f.id, kind: "semantic" }
  }

  /** Recall — hybrid retrieval across all layers */
  async recall(query: string, opts: RetrieveOpts = {}): Promise<CognitivePacket> {
    return this.hybrid.retrieve(query, { userId: this.userId, ...opts })
  }

  /** Alias for recall */
  async search(query: string, opts: RetrieveOpts = {}): Promise<Hit[]> {
    const pkt = await this.recall(query, opts)
    return pkt.hits
  }

  /** Inject memory context into a system prompt (call at session start) */
  async inject(query: string, opts: RetrieveOpts = {}): Promise<string> {
    const pkt = await this.recall(query, opts)
    return pkt.context
  }

  /** SessionPrompt integration: record a turn */
  async recordTurn(sessionId: string, role: "user" | "assistant", text: string, metadata?: Record<string, unknown>): Promise<void> {
    await this.episodic.record(sessionId, `${role}: ${text}`, { userId: this.userId, metadata: { role, ...metadata } })
  }

  /** Convenience for tools/memory.ts */
  toToolContext() {
    return {
      search: (q: string, o?: RetrieveOpts) => this.search(q, o),
      remember: (c: string, o?: any) => this.remember(c, o),
    }
  }
}

export async function createMiraMemory(opts: MiraMemoryOpts): Promise<MiraMemory> {
  const store = await createMemoryStore({ db: opts.db, embedder: opts.embedder })
  const episodic = new EpisodicMemory(store)
  const semantic = new SemanticMemory(store)
  const procedural = new ProceduralMemory(store)
  const providers = opts.providers ?? createProviders()
  const hybrid = new HybridRetriever(store, episodic, semantic, procedural, providers)
  const userId = opts.userId ?? "default"
  return new MiraMemory(store, episodic, semantic, procedural, hybrid, userId, providers)
}

// Singleton for server bootstrap (lazy)
let _singleton: MiraMemory | null = null
export async function getMiraMemory(db: any, userId = "default"): Promise<MiraMemory> {
  if (_singleton) return _singleton
  _singleton = await createMiraMemory({ db, userId })
  return _singleton
}
