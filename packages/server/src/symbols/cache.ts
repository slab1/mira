/**
 * Symbol Cache — LRU(500) + TTL(30s) + contentHash invalidation
 */

import { createHash } from 'crypto'
import type { SymbolInfo } from './types.js'

const MAX_SIZE = 500
const TTL_MS = 30_000

interface CacheEntry<T> {
  value: T
  timestamp: number
  contentHash: string
}

export class LRUCache<K, V> {
  private store = new Map<K, CacheEntry<V>>()
  private maxSize: number
  private ttlMs: number

  constructor(maxSize = MAX_SIZE, ttlMs = TTL_MS) {
    this.maxSize = maxSize
    this.ttlMs = ttlMs
  }

  private isExpired(entry: CacheEntry<V>): boolean {
    return Date.now() - entry.timestamp > this.ttlMs
  }

  private evictIfNeeded(): void {
    while (this.store.size >= this.maxSize) {
      const firstKey = this.store.keys().next().value as K | undefined
      if (firstKey === undefined) break
      this.store.delete(firstKey)
    }
  }

  get(key: K, contentHash?: string): V | undefined {
    const entry = this.store.get(key)
    if (!entry) return undefined
    if (this.isExpired(entry)) {
      this.store.delete(key)
      return undefined
    }
    if (contentHash !== undefined && entry.contentHash !== contentHash) {
      this.store.delete(key)
      return undefined
    }
    // Refresh LRU order
    this.store.delete(key)
    this.store.set(key, entry)
    return entry.value
  }

  set(key: K, value: V, contentHash = ''): void {
    if (this.store.has(key)) this.store.delete(key)
    this.evictIfNeeded()
    this.store.set(key, { value, timestamp: Date.now(), contentHash })
  }

  has(key: K): boolean {
    const entry = this.store.get(key)
    if (!entry) return false
    if (this.isExpired(entry)) {
      this.store.delete(key)
      return false
    }
    return true
  }

  delete(key: K): void {
    this.store.delete(key)
  }

  clear(): void {
    this.store.clear()
  }

  size(): number {
    return this.store.size
  }

  keys(): IterableIterator<K> {
    return this.store.keys()
  }
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

export class SymbolCache {
  private cache = new LRUCache<string, SymbolInfo[]>(MAX_SIZE, TTL_MS)
  private hashCache = new Map<string, string>()

  get(file: string, content: string): SymbolInfo[] | undefined {
    const hash = hashContent(content)
    const cached = this.cache.get(file, hash)
    if (cached !== undefined) return cached
    // Also check if content changed — invalidate
    const prevHash = this.hashCache.get(file)
    if (prevHash !== undefined && prevHash !== hash) {
      this.cache.delete(file)
    }
    return undefined
  }

  set(file: string, symbols: SymbolInfo[], content: string): void {
    const hash = hashContent(content)
    this.hashCache.set(file, hash)
    this.cache.set(file, symbols, hash)
  }

  invalidate(file: string): void {
    this.cache.delete(file)
    this.hashCache.delete(file)
  }

  has(file: string): boolean {
    return this.cache.has(file)
  }

  clear(): void {
    this.cache.clear()
    this.hashCache.clear()
  }

  size(): number {
    return this.cache.size()
  }
}

export const symbolCache = new SymbolCache()
