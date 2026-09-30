/**
 * Code Graph — AST call graph over TypeScript/JavaScript sources.
 *
 * Built by scanning a project root, parsing each source file (regex-based
 * parser, see parser.ts), and persisting symbols / imports / call sites into
 * SQLite (see graph.ts). Queries are read-only.
 *
 *   buildGraph(cwd?)        — full rebuild: scan → parse → resolve → persist
 *   findCallers(name)       — "file:line" strings of call sites of a function
 *   findDependencies(file)  — project-relative paths the file imports
 *   findDependents(file)    — project-relative paths that import the file
 *
 * One instance per database via codeGraphFor(db) — startup builds the graph
 * once and tools reuse the same instance (lazy-built on first use).
 */

import { Glob } from 'bun'
import { existsSync } from 'node:fs'
import type { MiraDB } from '../storage/db.js'
import { parseFile } from './parser.js'
import { CodeGraphStore, type CodeGraphStats } from './graph.js'

export interface CodeGraphDeps {
  db?: MiraDB
  rootDir?: string
}

export interface BuildResult {
  files: number
  symbols: number
  imports: number
  calls: number
  durationMs: number
}

const SOURCE_GLOBS = ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx']
const IGNORE_RE = /node_modules|dist|build|\.git|\.next|out\/|coverage|\.turbo/
const RESOLVE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.json']

export class CodeGraph {
  private store: CodeGraphStore

  constructor(private deps: CodeGraphDeps = {}) {
    this.store = new CodeGraphStore(deps.db)
  }

  /** Full rebuild: scan project → parse → resolve imports → persist (transactional). */
  async buildGraph(cwd?: string): Promise<BuildResult> {
    const root = cwd ?? this.deps.rootDir ?? process.cwd()
    const started = performance.now()
    this.store.clear()

    // Pass 1: parse every source file
    const parsed: Array<{ rel: string; text: string }> = []
    for (const pattern of SOURCE_GLOBS) {
      const glob = new Glob(pattern)
      for await (const file of glob.scan({ cwd: root, onlyFiles: true })) {
        if (IGNORE_RE.test(file)) continue
        const rel = file.replace(/\\/g, '/')
        try {
          const text = await Bun.file(`${root}/${file}`).text()
          parsed.push({ rel, text })
        } catch {
          // unreadable file — skip
        }
      }
    }

    const now = Date.now()
    const files = parsed.map((p) => p.rel)
    const parsedFiles = parsed.map((p) => parseFile(p.rel, p.text))

    // Global symbol name set — call sites are only kept for names that are
    // declared somewhere in the project or imported by the calling file.
    const globalNames = new Set<string>()
    for (const pf of parsedFiles) for (const sym of pf.symbols) globalNames.add(sym.name)

    let symbolCount = 0
    let importCount = 0
    let callCount = 0

    const store = this.store
    store.transaction(() => {
      for (const rel of files) store.insertFile(rel, now)

      for (const pf of parsedFiles) {
        for (const sym of pf.symbols) {
          store.insertSymbol(pf.path, sym)
          symbolCount++
        }

        // Resolve this file's imports to project-relative paths
        const baseDir = pf.path.split('/').slice(0, -1)
        const localNames = new Set<string>()
        for (const imp of pf.imports) {
          for (const n of imp.names) localNames.add(n)
          const resolved = resolveImport(root, baseDir, imp.specifier)
          if (resolved) {
            store.insertImport(pf.path, resolved, imp.specifier, imp.line)
            importCount++
          }
        }

        // Call sites: keep identifiers that are project symbols or imported
        // names (locally declared names are already in globalNames)
        for (const call of pf.calls) {
          if (!globalNames.has(call.name) && !localNames.has(call.name)) continue
          store.insertCall(pf.path, call.name, call.line)
          callCount++
        }
      }
    })

    return {
      files: files.length,
      symbols: symbolCount,
      imports: importCount,
      calls: callCount,
      durationMs: Math.round(performance.now() - started),
    }
  }

  /** Files/lines that call the given function: ["src/foo.ts:42", …]. */
  findCallers(functionName: string, limit = 50): string[] {
    return this.store.findCallers(functionName, limit).map((r) => `${r.file}:${r.line}`)
  }

  /** Project-relative paths the given file imports. Accepts relative or absolute. */
  findDependencies(filePath: string, limit = 100): string[] {
    return this.store.findDependencies(this.normalizePath(filePath), limit)
  }

  /** Project-relative paths that import the given file (reverse deps). */
  findDependents(filePath: string, limit = 100): string[] {
    return this.store.findDependents(this.normalizePath(filePath), limit)
  }

  /** Declarations of a symbol across the project. */
  findSymbolDeclarations(name: string, limit = 50) {
    return this.store.findSymbol(name, limit)
  }

  stats(): CodeGraphStats {
    return this.store.stats()
  }

  /** Normalize a user-supplied path to a project-relative forward-slash path. */
  private normalizePath(filePath: string): string {
    const root = this.deps.rootDir ?? process.cwd()
    let p = filePath.replace(/\\/g, '/')
    const rootNorm = root.replace(/\\/g, '/')
    if (p.startsWith(`${rootNorm}/`)) p = p.slice(rootNorm.length + 1)
    return p
  }
}

/** Resolve a relative import specifier to a project-relative file path (best effort). */
function resolveImport(root: string, baseDir: string[], specifier: string): string | null {
  if (!specifier.startsWith('.')) return null // bare module — not a file dependency
  const parts: string[] = []
  for (const seg of [...baseDir, ...specifier.split('/')]) {
    if (seg === '.' || seg === '') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  const joined = parts.join('/')
  if (!joined) return null
  // Try exact, then extensions, then directory index files
  const candidates = [
    joined,
    ...RESOLVE_EXTS.map((e) => `${joined}${e}`),
    ...RESOLVE_EXTS.map((e) => `${joined}/index${e}`),
  ]
  for (const cand of candidates) {
    if (existsSync(`${root}/${cand}`)) return cand
  }
  // Best effort: prefer the .ts extension for extensionless specifiers
  return /\.[a-z]+$/.test(joined) ? joined : `${joined}.ts`
}

export function createCodeGraph(deps: CodeGraphDeps = {}): CodeGraph {
  return new CodeGraph(deps)
}

// ── Shared instance (one per database) ──────────────────────────────
// Startup builds the graph once; tools reuse the same instance via
// codeGraphFor(db). WeakMap keyed by db → no leaks, no cross-db bleed.

const graphCache = new WeakMap<object, CodeGraph>()

export function codeGraphFor(db?: MiraDB): CodeGraph {
  if (!db) return new CodeGraph({})
  const key = db as object
  let g = graphCache.get(key)
  if (!g) {
    g = new CodeGraph({ db })
    graphCache.set(key, g)
  }
  return g
}

export { parseFile } from './parser.js'
export type { ParsedFile, SymbolDecl, ImportDecl, CallSite, SymbolKind } from './parser.js'
export { CodeGraphStore } from './graph.js'
export type { CallerRef, CodeGraphStats, SymbolRow } from './graph.js'
