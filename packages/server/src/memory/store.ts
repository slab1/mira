/**
 * Mira Memory — Store
 * Postgres + pgvector + Drizzle (prod) — SQLite FTS5 fallback (dev)
 *
 * Tables (hierarchical):
 *   memory_episodes  — episodic (events, session traces)
 *   memory_facts     — semantic (facts, preferences, entities)
 *   memory_skills    — procedural (skills, tools)
 *   memory_edges     — graph edges (subject —predicate→ object)
 *
 * Embeddings: vector(1536) with HNSW in Postgres, JS cosine fallback in SQLite.
 * Drizzle kit dialect: `pg` for prod, `sqlite` for local dev.
 */

// Drizzle schema — optional (graceful fallback when drizzle-orm not installed due to ENOSPC)
let memoryEpisodes: any, memoryFacts: any, memorySkills: any, memoryEdges: any, memorySchema: any
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { sqliteTable, text, integer, index, real } = require("drizzle-orm/sqlite-core")
  memoryEpisodes = sqliteTable("memory_episodes", {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    userId: text("user_id").notNull().default("default"),
    type: text("type").notNull().default("event"),
    content: text("content").notNull(),
    embedding: text("embedding"),
    metadata: text("metadata", { mode: "json" }) as any,
    createdAt: integer("created_at").notNull(),
  }, (t: any) => [
    index("mem_episodes_session_idx").on(t.sessionId),
    index("mem_episodes_created_idx").on(t.createdAt),
    index("mem_episodes_user_idx").on(t.userId),
  ])
  memoryFacts = sqliteTable("memory_facts", {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().default("default"),
    kind: text("kind").notNull().default("fact"),
    subject: text("subject"),
    predicate: text("predicate"),
    object: text("object"),
    content: text("content").notNull(),
    confidence: real("confidence").notNull().default(0.8),
    embedding: text("embedding"),
    metadata: text("metadata", { mode: "json" }) as any,
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  }, (t: any) => [
    index("mem_facts_user_idx").on(t.userId),
    index("mem_facts_kind_idx").on(t.kind),
  ])
  memorySkills = sqliteTable("memory_skills", {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    description: text("description").notNull(),
    triggers: text("triggers", { mode: "json" }) as any,
    body: text("body").notNull(),
    embedding: text("embedding"),
    successRate: real("success_rate").notNull().default(0.5),
    useCount: integer("use_count").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  }, (t: any) => [
    index("mem_skills_name_idx").on(t.name),
  ])
  memoryEdges = sqliteTable("memory_edges", {
    id: text("id").primaryKey(),
    sourceId: text("source_id").notNull(),
    targetId: text("target_id").notNull(),
    predicate: text("predicate").notNull(),
    weight: real("weight").notNull().default(1.0),
    createdAt: integer("created_at").notNull(),
  }, (t: any) => [
    index("mem_edges_source_idx").on(t.sourceId),
    index("mem_edges_target_idx").on(t.targetId),
  ])
  memorySchema = { memoryEpisodes, memoryFacts, memorySkills, memoryEdges }
} catch {
  // Fallback stubs — raw SQL path (Bun SQLite) will be used instead
  const stub = (name: string) => ({ _: name } as any)
  memoryEpisodes = stub("memory_episodes")
  memoryFacts = stub("memory_facts")
  memorySkills = stub("memory_skills")
  memoryEdges = stub("memory_edges")
  memorySchema = { memoryEpisodes, memoryFacts, memorySkills, memoryEdges }
}
export { memoryEpisodes, memoryFacts, memorySkills, memoryEdges, memorySchema }

// ── Postgres migration SQL (prod) — pgvector + HNSW ───────────────────
/**
 * Run this with `psql $DATABASE_URL` or via drizzle-kit `pg` dialect.
 * Keep SQLite tables above for local dev; this SQL is authoritative for prod.
 */
export const pgVectorMigrationSQL = `
-- enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS memory_episodes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT 'default',
  type TEXT NOT NULL DEFAULT 'event',
  content TEXT NOT NULL,
  embedding vector(1536),
  metadata JSONB,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS mem_episodes_session_idx ON memory_episodes(session_id);
CREATE INDEX IF NOT EXISTS mem_episodes_embedding_hnsw
  ON memory_episodes USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS memory_facts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'default',
  kind TEXT NOT NULL DEFAULT 'fact',
  subject TEXT, predicate TEXT, object TEXT,
  content TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.8,
  embedding vector(1536),
  metadata JSONB,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS mem_facts_embedding_hnsw
  ON memory_facts USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS memory_skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  triggers JSONB, body TEXT NOT NULL,
  embedding vector(1536),
  success_rate REAL NOT NULL DEFAULT 0.5,
  use_count INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_edges (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL, target_id TEXT NOT NULL,
  predicate TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1.0,
  created_at BIGINT NOT NULL
);
`.trim()

// ── Embedding helpers ──────────────────────────────────────────────────
export const EMBEDDING_DIMS = 1536

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]! }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9)
}

// Deterministic hash embedding (no API key) — normalized, good for tests
export function hashEmbedding(text: string, dims = EMBEDDING_DIMS): number[] {
  const v = new Array(dims).fill(0)
  for (let i = 0; i < text.length; i++) {
    const h = (text.charCodeAt(i) * 9301 + 49297) % 233280
    const idx = h % dims
    v[idx]! += Math.sin(h) * 0.5 + 0.5
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
  return v.map(x => x / norm)
}

export type Embedder = (text: string) => Promise<number[]>

export function createEmbedder(): Embedder {
  const key = process.env.OPENAI_API_KEY
  if (!key) return async (t) => hashEmbedding(t)
  return async (text) => {
    // Use OpenAI embeddings if key present; fallback to hash on failure
    try {
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: "text-embedding-3-small", input: text, dimensions: EMBEDDING_DIMS }),
      })
      if (!res.ok) throw new Error(String(res.status))
      const json: any = await res.json()
      const vec: number[] = json.data?.[0]?.embedding
      if (vec?.length) return vec
      throw new Error("no embedding")
    } catch {
      return hashEmbedding(text)
    }
  }
}

export function serializeEmbedding(v: number[] | null): string | null {
  return v ? JSON.stringify(v) : null
}
export function parseEmbedding(s: string | null): number[] | null {
  if (!s) return null
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : null } catch { return null }
}

// ── Store factory ──────────────────────────────────────────────────────
export interface MemoryStoreConfig {
  db: any // drizzle instance (sqlite or pg)
  embedder?: Embedder
  dims?: number
}

export interface MemoryStore {
  db: any
  embed: Embedder
  dims: number
  ensureMigrated(): Promise<void>
}

export async function createMemoryStore(cfg: MemoryStoreConfig): Promise<MemoryStore> {
  const embed = cfg.embedder ?? createEmbedder()
  const dims = cfg.dims ?? EMBEDDING_DIMS
  const store: MemoryStore = {
    db: cfg.db,
    embed,
    dims,
    async ensureMigrated() {
      const sqlite = cfg.db?.sqlite
      if (!sqlite) return // pg: migration is external (pgVectorMigrationSQL)
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS memory_episodes (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL, user_id TEXT NOT NULL DEFAULT 'default',
          type TEXT NOT NULL DEFAULT 'event', content TEXT NOT NULL,
          embedding TEXT, metadata TEXT, created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS mem_episodes_session_idx ON memory_episodes(session_id);
        CREATE INDEX IF NOT EXISTS mem_episodes_created_idx ON memory_episodes(created_at);
        CREATE TABLE IF NOT EXISTS memory_facts (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'default', kind TEXT NOT NULL DEFAULT 'fact',
          subject TEXT, predicate TEXT, object TEXT, content TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 0.8, embedding TEXT, metadata TEXT,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS mem_facts_user_idx ON memory_facts(user_id);
        CREATE TABLE IF NOT EXISTS memory_skills (
          id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL,
          triggers TEXT, body TEXT NOT NULL, embedding TEXT,
          success_rate REAL NOT NULL DEFAULT 0.5, use_count INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memory_edges (
          id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT NOT NULL,
          predicate TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1.0, created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS mem_edges_source_idx ON memory_edges(source_id);
        CREATE INDEX IF NOT EXISTS mem_edges_target_idx ON memory_edges(target_id);
      `)
    },
  }
  await store.ensureMigrated()
  return store
}

// ── Zep / Mem0 provider contracts ─────────────────────────────────────
export interface MemoryProvider {
  name: "zep" | "mem0" | "local"
  search(query: string, opts?: { userId?: string; limit?: number }): Promise<{ content: string; score: number; metadata?: any }[]>
  add(content: string, opts?: { userId?: string; metadata?: any }): Promise<{ id: string }>
}

/** Zep adapter — https://getzep.com (temporal graph + sessions) */
export function createZepProvider(opts: { apiKey?: string; baseUrl?: string } = {}): MemoryProvider | null {
  const key = opts.apiKey ?? process.env.ZEP_API_KEY
  if (!key) return null
  const base = (opts.baseUrl ?? process.env.ZEP_BASE_URL ?? "https://api.getzep.com").replace(/\/$/, "")
  return {
    name: "zep",
    async search(query, { userId = "default", limit = 5 } = {}) {
      // Zep v2: POST /api/v2/graph/search  (fallback to simple fetch contract)
      const res = await fetch(`${base}/api/v2/graph/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Api-Key ${key}` },
        body: JSON.stringify({ query, user_id: userId, limit }),
      }).catch(() => null as any)
      if (!res?.ok) return []
      const j: any = await res.json().catch(() => ({}))
      const nodes = j.nodes ?? j.results ?? j.facts ?? []
      return nodes.slice(0, limit).map((n: any) => ({
        content: n.content ?? n.text ?? n.fact ?? JSON.stringify(n),
        score: n.score ?? n.relevance ?? 0.7,
        metadata: n,
      }))
    },
    async add(content, { userId = "default", metadata } = {}) {
      const res = await fetch(`${base}/api/v2/graph/data`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Api-Key ${key}` },
        body: JSON.stringify({ user_id: userId, type: "text", data: content, metadata }),
      }).catch(() => null as any)
      const j: any = await res?.json().catch(() => ({}))
      return { id: j.id ?? j.uuid ?? `zep-${Date.now()}` }
    },
  }
}

/** Mem0 adapter — https://mem0.ai (managed semantic memory) */
export function createMem0Provider(opts: { apiKey?: string; baseUrl?: string } = {}): MemoryProvider | null {
  const key = opts.apiKey ?? process.env.MEM0_API_KEY
  if (!key) return null
  const base = (opts.baseUrl ?? process.env.MEM0_BASE_URL ?? "https://api.mem0.ai").replace(/\/$/, "")
  return {
    name: "mem0",
    async search(query, { userId = "default", limit = 5 } = {}) {
      const res = await fetch(`${base}/v1/memories/search/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Token ${key}` },
        body: JSON.stringify({ query, user_id: userId, top_k: limit }),
      }).catch(() => null as any)
      if (!res?.ok) return []
      const j: any = await res.json().catch(() => ({}))
      const arr = Array.isArray(j) ? j : j.results ?? j.memories ?? []
      return arr.slice(0, limit).map((m: any) => ({
        content: m.memory ?? m.text ?? m.content ?? JSON.stringify(m),
        score: m.score ?? m.relevance ?? 0.7,
        metadata: m,
      }))
    },
    async add(content, { userId = "default", metadata } = {}) {
      const res = await fetch(`${base}/v1/memories/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Token ${key}` },
        body: JSON.stringify({ messages: [{ role: "user", content }], user_id: userId, metadata }),
      }).catch(() => null as any)
      const j: any = await res?.json().catch(() => ({}))
      return { id: j.id ?? `mem0-${Date.now()}` }
    },
  }
}

export function createProviders(): MemoryProvider[] {
  return [createZepProvider(), createMem0Provider()].filter(Boolean) as MemoryProvider[]
}
