/**
 * Provider System — Semantic Cache
 *
 * Caches LLM responses by prompt hash (model + temperature + prompt).
 * TTL-based eviction with configurable max entries.
 */

import { createHash } from 'node:crypto'

export interface CachedResponse {
  text: string
  inputTokens: number
  outputTokens: number
  costUSD: number
  timestamp: number
  model: string
}

export interface CacheStats {
  hits: number
  misses: number
  size: number
}

export class SemanticCache {
  private cache = new Map<string, CachedResponse>()
  private hits = 0
  private misses = 0
  private readonly ttlMs: number
  private readonly maxEntries: number

  constructor(ttlMs = 5 * 60 * 1000, maxEntries = 1000) {
    this.ttlMs = ttlMs
    this.maxEntries = maxEntries
  }

  /**
   * Generate a SHA-256 cache key from model, temperature, and prompt.
   * Same prompt + same model + same temperature = same response.
   */
  key(prompt: string, model: string, temperature: number): string {
    const input = `${model}:${temperature}:${prompt}`
    const hash = createHash('sha256').update(input).digest('hex')
    return hash
  }

  /**
   * Retrieve a cached response by key.
   * Returns null if the key is missing or the entry has expired.
   */
  get(key: string): CachedResponse | null {
    const entry = this.cache.get(key)
    if (!entry) {
      this.misses++
      return null
    }
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key)
      this.misses++
      return null
    }
    this.hits++
    return entry
  }

  /**
   * Store a response in the cache with the current timestamp.
   * Evicts oldest entries if max capacity is reached.
   */
  set(key: string, response: CachedResponse): void {
    // Evict oldest entries if at capacity
    if (this.cache.size >= this.maxEntries && !this.cache.has(key)) {
      const firstKey = this.cache.keys().next().value
      if (firstKey !== undefined) {
        this.cache.delete(firstKey)
      }
    }
    this.cache.set(key, { ...response, timestamp: Date.now() })
  }

  /**
   * Invalidate cache entries whose key contains the given pattern.
   */
  invalidate(pattern: string): void {
    for (const key of this.cache.keys()) {
      if (key.includes(pattern)) {
        this.cache.delete(key)
      }
    }
  }

  /**
   * Return cache hit/miss statistics and current size.
   */
  stats(): CacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.cache.size,
    }
  }

  /** Get the number of entries currently in the cache */
  get size(): number {
    return this.cache.size
  }

  /** Clear all entries and reset counters */
  clear(): void {
    this.cache.clear()
    this.hits = 0
    this.misses = 0
  }
}

/** Factory function to create a SemanticCache with defaults */
export function createSemanticCache(ttlMs?: number, maxEntries?: number): SemanticCache {
  return new SemanticCache(ttlMs, maxEntries)
}
