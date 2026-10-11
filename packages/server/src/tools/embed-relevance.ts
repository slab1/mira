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
 *   - Requires OPENAI_API_KEY (AI SDK + @ai-sdk/openai). Without it, the
 *     signal is silently absent — never a fake score.
 *   - Advisory only, like every relevance signal: it can be wrong about
 *     intent and must never block a mutation.
 *   - Bounded cost: an SQLite cache (sha256 of model+text → vector) means the
 *     task text and each file version embed at most once; disable with
 *     MIRA_EMBED_RELEVANCE=0.
 */
import { createHash } from 'node:crypto'
import { embed } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
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

let cachedEmbedFn: EmbedFn | null | undefined

/**
 * Build (once) the AI SDK-backed embedder. Returns null when no API key is
 * configured or construction fails — callers treat null as "signal absent".
 */
export function getEmbedFn(): EmbedFn | null {
  if (cachedEmbedFn !== undefined) return cachedEmbedFn
  try {
    if (!process.env.OPENAI_API_KEY) {
      cachedEmbedFn = null
      return null
    }
    const provider = createOpenAI({ apiKey: process.env.OPENAI_API_KEY })
    const model = provider.textEmbeddingModel(
      process.env.MIRA_EMBEDDING_MODEL || 'text-embedding-3-small',
    )
    cachedEmbedFn = async (text: string) => {
      const res = await embed({ model, value: text.slice(0, 8000) })
      return res.embedding ?? null
    }
  } catch (e) {
    console.warn('[edit-target] embedder unavailable:', String(e))
    cachedEmbedFn = null
  }
  return cachedEmbedFn
}

/** Reset the memoized embedder (tests). */
export function resetEmbedFn(): void {
  cachedEmbedFn = undefined
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

  const embedFn = input.embedFn ?? getEmbedFn()
  if (!embedFn) return { similarity: null }

  const model = process.env.MIRA_EMBEDDING_MODEL || 'text-embedding-3-small'
  const fileHead = `path context\n${input.fileContent.slice(0, 4000)}`
  try {
    const taskKey = cacheKey(model, task)
    const fileKey = cacheKey(model, fileHead)
    let taskVec = cacheGet(input.db, taskKey)
    let fileVec = cacheGet(input.db, fileKey)
    if (!taskVec) {
      taskVec = await embedFn(task)
      if (taskVec) cachePut(input.db, taskKey, taskVec)
    }
    if (!fileVec) {
      fileVec = await embedFn(fileHead)
      if (fileVec) cachePut(input.db, fileKey, fileVec)
    }
    if (!taskVec || !fileVec) return { similarity: null }

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
