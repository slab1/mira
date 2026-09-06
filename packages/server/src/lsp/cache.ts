/**
 * LSP Cache — diagnostics + document version cache
 */

import type { Diagnostic } from './protocol.js'

export class DiagnosticCache {
  private store = new Map<string, Diagnostic[]>()

  set(uri: string, diagnostics: Diagnostic[]): void {
    this.store.set(uri, diagnostics)
  }

  get(uri: string): Diagnostic[] | undefined {
    return this.store.get(uri)
  }

  has(uri: string): boolean {
    return this.store.has(uri)
  }

  delete(uri: string): void {
    this.store.delete(uri)
  }

  clear(): void {
    this.store.clear()
  }

  entries(): IterableIterator<[string, Diagnostic[]]> {
    return this.store.entries()
  }

  size(): number {
    return this.store.size
  }
}

export class DocumentVersionCache {
  private versions = new Map<string, number>()

  get(uri: string): number | undefined {
    return this.versions.get(uri)
  }

  set(uri: string, version: number): void {
    this.versions.set(uri, version)
  }

  increment(uri: string): number {
    const next = (this.versions.get(uri) ?? 0) + 1
    this.versions.set(uri, next)
    return next
  }

  has(uri: string): boolean {
    return this.versions.has(uri)
  }

  delete(uri: string): void {
    this.versions.delete(uri)
  }

  clear(): void {
    this.versions.clear()
  }

  size(): number {
    return this.versions.size
  }
}

export class LSPCache {
  readonly diagnostics = new DiagnosticCache()
  readonly versions = new DocumentVersionCache()

  clear(): void {
    this.diagnostics.clear()
    this.versions.clear()
  }
}

export const lspCache = new LSPCache()
