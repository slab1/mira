/**
 * Embedding-backed relevance (the last open wrong-edit finding).
 *
 * The lexical signals (file name, module boundary, symbol binding) are blind
 * when the task speaks *about* the code without naming it — "fix the expiry
 * bug" names nothing. This module gives the edit-target analysis a real
 * semantic signal: embed the task text and the target file's content, compare
 * by cosine similarity, and warn when the task is semantically distant from
 * the file being changed.
 *
 * Honesty rules:
 *   - Routed through the gateway's provider registry, so ANY provider
 *     configured in mira.json can serve embeddings (default:
 *     `openai/text-embedding-3-small`, overridable with MIRA_EMBEDDING_MODEL).
 *     With nothing resolvable the signal is silently absent — never a fake score.
 *   - Advisory only, like every relevance signal: it can be wrong about
 *     intent and must never block a mutation.
 *   - Bounded cost: an SQLite cache (sha256 of provider+model+text → vector)
 *     means the task text and each file version embed at most once; disable
 *     with MIRA_EMBED_RELEVANCE=0.
 */
import { createHash } from 'node:crypto'
import { getConfig } from '../config/index.js'
import { buildRegistry } from '../gateway/provider.js'
import { embedText } from '../providers/embedding.js'
import type { MiraDB } from '../storage/db.js'

export type EmbedFn = (text: string) => Promise<number[] | null>

export interface EmbedRelevanceInput {
  taskText: string
  /** The content being changed (pre-edit snapshot head is enough). */
  fileContent: string
  db?: MiraDB
  /** Injected embedder (tests); defaults to the AI SDK-backed one. */
  embedFn?: EmbedFn
  /** Below this cosine similarity the task is flagged unrelated. */
  threshold?: number
}

export interface EmbedRelevanceResult {
  /** Advisory message when the task looks semantically unrelated. */
  warning?: string
  similarity: number | null
}

/** Cosine similarity for unit/normalized vectors (falls back to norm divide). */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

/** Default advisory threshold — text-embedding-3-small cosines for unrelated
 *  technical text cluster near 0.0–0.15; related pairs typically > 0.3. */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.18

/** Default embedding model — provider-qualified so the gateway can route it. */
export const DEFAULT_EMBEDDING_MODEL = 'openai/text-embedding-3-small'

export interface Embedder {
  fn: EmbedFn
  /** `provider/model` — part of the cache key, so vectors from two providers
   *  can never be compared (their dimensions differ; the cosine would be
   *  meaningless even when the lengths happened to match). */
  id: string
  provider: string
  model: string
}

let cachedEmbedder: Embedder | null | undefined

/**
 * Build (once) the gateway-routed embedder for `MIRA_EMBEDDING_MODEL`.
 * Returns null when no provider can serve it — callers treat null as "signal
 * absent", never as a zero vector.
 */
export function getEmbedder(cwd?: string): Embedder | null {
  if (cachedEmbedder !== undefined) return cachedEmbedder
  try {
    const requested = process.env.MIRA_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL
    // Same registry the chat path uses: longest-prefix resolution, alias
    // expansion, circuit breaker, rate limit, and env-expanded keys/headers.
    const registry = buildRegistry(getConfig(cwd))
    const target = registry.resolve(requested)
    if (!target.apiKey) {
      cachedEmbedder = null
      return null
    }
    const id = `${target.providerKey}/${target.modelID}`
    const embedFn: EmbedFn = async (text: string) =>
      embedText({
        baseURL: target.baseURL,
        apiKey: target.apiKey,
        modelID: target.modelID,
        input: text,
        headers: target.headers,
        timeoutMs: target.timeout,
      })
    cachedEmbedder = {
      fn: embedFn,
      id,
      provider: target.providerKey,
      model: target.modelID,
    }
  } catch (e) {
    console.warn('[edit-target] embedder unavailable:', String(e))
    cachedEmbedder = null
  }
  return cachedEmbedder
}

/** The embed function alone (tests and callers that only need to embed). */
export function getEmbedFn(): EmbedFn | null {
  return getEmbedder()?.fn ?? null
}

/** Reset the memoized embedder (tests, runtime config change). */
export function resetEmbedFn(): void {
  cachedEmbedder = undefined
}

function cacheKey(model: string, text: string): string {
  return createHash('sha256').update(`${model}:${text}`).digest('hex')
}

function cacheGet(db: MiraDB | undefined, key: string): number[] | null {
  if (!db) return null
  try {
    db.sqlite.exec(
      'CREATE TABLE IF NOT EXISTS embedding_cache (key TEXT PRIMARY KEY, vector TEXT NOT NULL, created_at INTEGER NOT NULL)',
    )
    const row = db.sqlite.prepare('SELECT vector FROM embedding_cache WHERE key = ?').get(key) as
      { vector: string } | undefined
    return row ? (JSON.parse(row.vector) as number[]) : null
  } catch {
    return null
  }
}

function cachePut(db: MiraDB | undefined, key: string, vector: number[]): void {
  if (!db) return
  try {
    db.sqlite
      .prepare('INSERT OR REPLACE INTO embedding_cache (key, vector, created_at) VALUES (?, ?, ?)')
      .run(key, JSON.stringify(vector), Date.now())
  } catch {}
}

/**
 * Semantic relevance: embed task + file content (cached), compare, warn when
 * below threshold. Never throws; similarity null = signal absent.
 */
export async function analyzeEmbeddingRelevance(
  input: EmbedRelevanceInput,
): Promise<EmbedRelevanceResult> {
  if (process.env.MIRA_EMBED_RELEVANCE === '0') return { similarity: null }
  const threshold = input.threshold ?? DEFAULT_SIMILARITY_THRESHOLD
  const task = input.taskText.trim()
  if (task.length < 20) return { similarity: null } // too little intent to judge

  const embedder = input.embedFn ? null : getEmbedder()
  const embedFn = input.embedFn ?? embedder?.fn ?? null
  if (!embedFn) return { similarity: null }

  // Cache key is provider-qualified: switching MIRA_EMBEDDING_MODEL (or its
  // provider) must not reuse vectors from another model's space.
  const model = input.embedFn ? process.env.MIRA_EMBEDDING_MODEL || 'injected' : embedder!.id
  const fileHead = `path context\n${input.fileContent.slice(0, 4000)}`
  try {
    const taskKey = cacheKey(model, task)
    const fileKey = cacheKey(model, fileHead)
    let taskVec = cacheGet(input.db, taskKey)
    let fileVec = cacheGet(input.db, fileKey)
    if (!taskVec) {
      taskVec = await embedFn(task.slice(0, 8000))
      if (taskVec) cachePut(input.db, taskKey, taskVec)
    }
    if (!fileVec) {
      fileVec = await embedFn(fileHead)
      if (fileVec) cachePut(input.db, fileKey, fileVec)
    }
    if (!taskVec || !fileVec) return { similarity: null }
    // Dimensions must agree. A mismatch (different provider, model swap
    // mid-flight, truncated response) is missing signal, not similarity 0 —
    // reporting 0 would raise a "completely unrelated" warning off a
    // dimensionality artifact.
    if (taskVec.length !== fileVec.length) return { similarity: null }

    const similarity = cosineSimilarity(taskVec, fileVec)
    if (similarity < threshold) {
      return {
        similarity,
        warning:
          `Semantic check: this file's content looks unrelated to the stated task ` +
          `(similarity ${similarity.toFixed(2)} < ${threshold}). ` +
          `Confirm the target before continuing — or ignore if the task is genuinely broader.`,
      }
    }
    return { similarity }
  } catch (e) {
    console.warn('[edit-target] embedding relevance failed:', String(e))
    return { similarity: null }
  }
}
