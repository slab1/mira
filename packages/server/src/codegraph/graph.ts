/**
 * Code Graph Store — SQLite schema + low-level queries for the AST call graph.
 *
 * Tables (created idempotently on construction, same convention as
 * repo/graph.ts — self-contained schema, no central migration needed):
 *   codegraph_files    — scanned source files
 *   codegraph_symbols  — symbol declarations (name, kind, line, signature)
 *   codegraph_imports  — resolved file → file dependency edges
 *   codegraph_calls    — call sites (caller_file → callee_name, line)
 *
 * All queries are read-only; writes happen only via buildGraph().
 */

import type { Database } from 'bun:sqlite'
import type { MiraDB } from '../storage/db.js'
import type { SymbolDecl } from './parser.js'

export interface CallerRef {
  file: string // project-relative, forward slashes
  line: number // 1-based
}

export interface SymbolRow extends SymbolDecl {
  file: string
}

export interface CodeGraphStats {
  files: number
  symbols: number
  imports: number
  calls: number
}

export class CodeGraphStore {
  private sqlite: Database | null

  constructor(db?: MiraDB | null) {
    this.sqlite = db?.sqlite ?? null
    this.initSchema()
  }

  private initSchema(): void {
    const sqlite = this.sqlite
    if (!sqlite) return
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS codegraph_files (
        path TEXT PRIMARY KEY,
        scanned_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS codegraph_symbols (
        file TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        line INTEGER NOT NULL,
        signature TEXT,
        is_exported INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (file, name, line)
      );
      CREATE INDEX IF NOT EXISTS codegraph_symbols_name_idx ON codegraph_symbols(name);
      CREATE TABLE IF NOT EXISTS codegraph_imports (
        from_file TEXT NOT NULL,
        to_file TEXT NOT NULL,
        specifier TEXT NOT NULL,
        line INTEGER NOT NULL,
        PRIMARY KEY (from_file, to_file, line)
      );
      CREATE INDEX IF NOT EXISTS codegraph_imports_from_idx ON codegraph_imports(from_file);
      CREATE INDEX IF NOT EXISTS codegraph_imports_to_idx ON codegraph_imports(to_file);
      CREATE TABLE IF NOT EXISTS codegraph_calls (
        caller_file TEXT NOT NULL,
        callee_name TEXT NOT NULL,
        line INTEGER NOT NULL,
        PRIMARY KEY (caller_file, callee_name, line)
      );
      CREATE INDEX IF NOT EXISTS codegraph_calls_name_idx ON codegraph_calls(callee_name);
    `)
  }

  /** Full rebuild: wipe previous rows so deleted/renamed files don't linger. */
  clear(): void {
    const sqlite = this.sqlite
    if (!sqlite) return
    sqlite.exec(`
      DELETE FROM codegraph_calls;
      DELETE FROM codegraph_imports;
      DELETE FROM codegraph_symbols;
      DELETE FROM codegraph_files;
    `)
  }

  /** Run fn inside a transaction when SQLite is available (no-op wrapper otherwise). */
  transaction(fn: () => void): void {
    const sqlite = this.sqlite
    if (!sqlite) {
      fn()
      return
    }
    sqlite.exec('BEGIN')
    try {
      fn()
      sqlite.exec('COMMIT')
    } catch (e) {
      try {
        sqlite.exec('ROLLBACK')
      } catch {}
      throw e
    }
  }

  insertFile(path: string, scannedAt: number): void {
    this.sqlite
      ?.prepare(`INSERT OR REPLACE INTO codegraph_files (path, scanned_at) VALUES (?, ?)`)
      .run(path, scannedAt)
  }

  insertSymbol(file: string, sym: SymbolDecl): void {
    this.sqlite
      ?.prepare(
        `INSERT OR REPLACE INTO codegraph_symbols (file, name, kind, line, signature, is_exported)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(file, sym.name, sym.kind, sym.line, sym.signature, sym.isExported ? 1 : 0)
  }

  insertImport(fromFile: string, toFile: string, specifier: string, line: number): void {
    this.sqlite
      ?.prepare(
        `INSERT OR IGNORE INTO codegraph_imports (from_file, to_file, specifier, line)
         VALUES (?, ?, ?, ?)`,
      )
      .run(fromFile, toFile, specifier, line)
  }

  insertCall(callerFile: string, calleeName: string, line: number): void {
    this.sqlite
      ?.prepare(
        `INSERT OR IGNORE INTO codegraph_calls (caller_file, callee_name, line)
         VALUES (?, ?, ?)`,
      )
      .run(callerFile, calleeName, line)
  }

  /** Files/lines that call the given function name (exact identifier match). */
  findCallers(name: string, limit = 50): CallerRef[] {
    const rows = this.sqlite
      ?.prepare(
        `SELECT caller_file, line FROM codegraph_calls
         WHERE callee_name = ? ORDER BY caller_file, line LIMIT ?`,
      )
      .all(name, limit) as { caller_file: string; line: number }[] | undefined
    return (rows ?? []).map((r) => ({ file: r.caller_file, line: r.line }))
  }

  /** Files the given file imports (project-relative paths). */
  findDependencies(filePath: string, limit = 100): string[] {
    const rows = this.sqlite
      ?.prepare(
        `SELECT DISTINCT to_file FROM codegraph_imports
         WHERE from_file = ? ORDER BY to_file LIMIT ?`,
      )
      .all(filePath, limit) as { to_file: string }[] | undefined
    return (rows ?? []).map((r) => r.to_file)
  }

  /** Reverse dependencies: files that import the given file. */
  findDependents(filePath: string, limit = 100): string[] {
    const rows = this.sqlite
      ?.prepare(
        `SELECT DISTINCT from_file FROM codegraph_imports
         WHERE to_file = ? ORDER BY from_file LIMIT ?`,
      )
      .all(filePath, limit) as { from_file: string }[] | undefined
    return (rows ?? []).map((r) => r.from_file)
  }

  /** Declarations of a symbol across the project. */
  findSymbol(name: string, limit = 50): SymbolRow[] {
    const rows = this.sqlite
      ?.prepare(
        `SELECT file, name, kind, line, signature, is_exported FROM codegraph_symbols
         WHERE name = ? ORDER BY file, line LIMIT ?`,
      )
      .all(name, limit) as unknown[] | undefined
    return (rows ?? []).map((r) => ({
      file: (r as Record<string, unknown>).file as string,
      name: (r as Record<string, unknown>).name as string,
      kind: (r as Record<string, unknown>).kind as SymbolRow['kind'],
      line: (r as Record<string, unknown>).line as number,
      signature: ((r as Record<string, unknown>).signature as string) ?? '',
      isExported: ((r as Record<string, unknown>).is_exported as number) === 1,
    }))
  }

  stats(): CodeGraphStats {
    const sqlite = this.sqlite
    if (!sqlite) return { files: 0, symbols: 0, imports: 0, calls: 0 }
    const count = (t: string) =>
      (sqlite.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c
    return {
      files: count('codegraph_files'),
      symbols: count('codegraph_symbols'),
      imports: count('codegraph_imports'),
      calls: count('codegraph_calls'),
    }
  }
}
