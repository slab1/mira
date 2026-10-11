import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createDatabase, migrate, type MiraDB } from '../storage/db.js'
import {
  analyzeEmbeddingRelevance,
  cosineSimilarity,
  DEFAULT_SIMILARITY_THRESHOLD,
  resetEmbedFn,
} from './embed-relevance.js'

// Embedding relevance — semantic distance between task text and file content.
// The embedder is INJECTED (never a real API call in tests).

const embedderFrom = (table: Array<[string, number[]]>) => {
  const map = new Map(table)
  return async (text: string): Promise<number[]> => {
    for (const [k, v] of map) if (text.includes(k)) return v
    return [0, 0, 0]
  }
}

let db: MiraDB

beforeEach(async () => {
  db = createDatabase(':memory:')
  await migrate(db)
  delete process.env.MIRA_EMBED_RELEVANCE
  delete process.env.OPENAI_API_KEY
  resetEmbedFn()
})

afterEach(() => {
  delete process.env.MIRA_EMBED_RELEVANCE
  delete process.env.OPENAI_API_KEY
  resetEmbedFn()
})

describe('cosineSimilarity', () => {
  test('identical vectors → 1', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1)
  })
  test('orthogonal → 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0)
  })
  test('mismatched lengths → 0 (never throws)', () => {
    expect(cosineSimilarity([1], [1, 2])).toBe(0)
    expect(cosineSimilarity([], [])).toBe(0)
  })
})

describe('analyzeEmbeddingRelevance', () => {
  test('low similarity → advisory warning with the score', async () => {
    const res = await analyzeEmbeddingRelevance({
      taskText: 'fix the login session expiry bug in the auth flow',
      fileContent: 'function pruneDatabaseCache() { /* vacuum logic */ }',
      db,
      embedFn: embedderFrom([
        ['login session expiry', [1, 0, 0]],
        ['pruneDatabaseCache', [0, 1, 0]],
      ]),
    })
    expect(res.warning).toBeTruthy()
    expect(res.similarity).toBe(0)
    expect(res.warning).toContain('0.00')
  })

  test('high similarity → silent', async () => {
    const res = await analyzeEmbeddingRelevance({
      taskText: 'fix the login session expiry bug in the auth flow',
      fileContent: 'login session expiry handling for the auth flow',
      db,
      embedFn: embedderFrom([
        ['login session expiry', [0.9, 0.1, 0]],
        ['login session expiry handling', [0.9, 0.12, 0]],
      ]),
    })
    expect(res.warning).toBeUndefined()
    expect(res.similarity).toBeGreaterThan(DEFAULT_SIMILARITY_THRESHOLD)
  })

  test('short task text → skipped (too little intent to judge)', async () => {
    const res = await analyzeEmbeddingRelevance({
      taskText: 'fix it',
      fileContent: 'anything',
      db,
      embedFn: embedderFrom([['fix it', [1, 0, 0]]]),
    })
    expect(res.similarity).toBeNull()
    expect(res.warning).toBeUndefined()
  })

  test('env kill switch MIRA_EMBED_RELEVANCE=0', async () => {
    process.env.MIRA_EMBED_RELEVANCE = '0'
    const res = await analyzeEmbeddingRelevance({
      taskText: 'fix the login session expiry bug in the auth flow module now',
      fileContent: 'unrelated content',
      db,
      embedFn: embedderFrom([['login', [1, 0, 0]]]),
    })
    expect(res.similarity).toBeNull()
  })

  test('embeddings are cached per text (same input → one embed)', async () => {
    let calls = 0
    const counting = async (text: string): Promise<number[]> => {
      calls++
      return text.includes('task') ? [1, 0, 0] : [0.9, 0.1, 0]
    }
    const input = {
      taskText: 'task about the login module with plenty of detail here',
      fileContent: 'login module content with detail here as well',
      db,
    }
    await analyzeEmbeddingRelevance({ ...input, embedFn: counting })
    const afterFirst = calls
    await analyzeEmbeddingRelevance({ ...input, embedFn: counting })
    expect(calls).toBe(afterFirst) // second run fully served from cache
  })

  test('cache table persists vectors in sqlite', async () => {
    await analyzeEmbeddingRelevance({
      taskText: 'task about the login module with plenty of detail here',
      fileContent: 'login module content with detail here as well',
      db,
      embedFn: embedderFrom([
        ['task', [1, 0, 0]],
        ['login', [0.9, 0.1, 0]],
      ]),
    })
    const row = db.sqlite.prepare('SELECT COUNT(*) AS c FROM embedding_cache').get() as {
      c: number
    }
    expect(row.c).toBe(2)
  })

  test('failing embedder degrades to similarity null, never throws', async () => {
    const res = await analyzeEmbeddingRelevance({
      taskText: 'task text long enough to be judged by the analyzer',
      fileContent: 'content',
      db,
      embedFn: async () => {
        throw new Error('provider down')
      },
    })
    expect(res.similarity).toBeNull()
    expect(res.warning).toBeUndefined()
  })

  test('without an embedder at all → signal absent, no warning', async () => {
    resetEmbedFn() // no OPENAI_API_KEY in test env → getEmbedFn() returns null
    const res = await analyzeEmbeddingRelevance({
      taskText: 'task text long enough to be judged by the analyzer',
      fileContent: 'content',
      db,
    })
    expect(res.similarity).toBeNull()
  })
})
