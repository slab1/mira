/**
 * Code Graph Parser — lightweight regex-based TypeScript/JavaScript parser (v1).
 *
 * Tree-sitter can replace this later; for v1 we extract just enough structure
 * for a call graph:
 *   - Symbol declarations (function / class / const / interface / …) + signature
 *   - Import / export-from / require dependency edges (raw specifiers)
 *   - Call sites (`name(` occurrences, filtered to known names at build time)
 *
 * Limitations (accepted for v1):
 *   - No scope resolution — a call site matches on identifier name only
 *   - Class methods are not indexed (regex cannot track class bodies reliably)
 *   - Template-literal contents are treated as string literals
 */

// ── Types ────────────────────────────────────────────────────────────

export type SymbolKind =
  'function' | 'class' | 'const' | 'let' | 'var' | 'interface' | 'type' | 'enum'

export interface SymbolDecl {
  name: string
  kind: SymbolKind
  line: number // 1-based
  signature: string // trimmed source line (capped)
  isExported: boolean
}

export interface ImportDecl {
  specifier: string // raw module specifier ('./foo', 'zod', …)
  line: number // 1-based
  names: string[] // bound names introduced into the file (default + named + namespace)
  isReexport: boolean // `export … from '…'`
}

export interface CallSite {
  name: string
  line: number // 1-based
}

export interface ParsedFile {
  path: string
  symbols: SymbolDecl[]
  imports: ImportDecl[]
  calls: CallSite[]
}

// ── Comment stripping (preserves line numbers + string contents) ──────
// Import specifiers live inside strings, so strings are kept verbatim;
// comments are dropped but newlines are preserved to keep line numbers stable.

function stripComments(text: string): string {
  let out = ''
  let i = 0
  const n = text.length
  let state: 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl' = 'code'
  while (i < n) {
    const c = text[i]!
    const next = text[i + 1]
    if (state === 'code') {
      if (c === '/' && next === '/') {
        state = 'line'
        i += 2
        continue
      }
      if (c === '/' && next === '*') {
        state = 'block'
        i += 2
        continue
      }
      if (c === "'") {
        state = 'sq'
        out += c
        i++
        continue
      }
      if (c === '"') {
        state = 'dq'
        out += c
        i++
        continue
      }
      if (c === '`') {
        state = 'tpl'
        out += c
        i++
        continue
      }
      out += c
      i++
      continue
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code'
        out += c
      }
      i++
      continue
    }
    if (state === 'block') {
      if (c === '*' && next === '/') {
        state = 'code'
        i += 2
        continue
      }
      if (c === '\n') out += '\n' // keep line numbering intact
      i++
      continue
    }
    // string states: preserve content (imports need it), honor escapes
    const quote = state === 'sq' ? "'" : state === 'dq' ? '"' : '`'
    if (c === '\\') {
      out += c + (next ?? '')
      i += 2
      continue
    }
    if (c === quote) {
      state = 'code'
      out += c
      i++
      continue
    }
    out += c
    i++
  }
  return out
}

// ── Regexes ──────────────────────────────────────────────────────────

// `import … from 'x'` / `export … from 'x'` — clause may contain default
// name, `{ a, b as c }`, `* as ns`, and the `type` modifier.
const IMPORT_FROM_RE = /(?:^|[;\n])\s*(import|export)\s+([^;'"]*?)\s+from\s*(['"])([^'"]+)\3/g
// Side-effect imports: `import 'x'`
const BARE_IMPORT_RE = /^[ \t]*import\s*(['"])([^'"]+)\1/gm
// CommonJS: `require('x')`
const REQUIRE_RE = /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g

const FN_DECL_RE =
  /(?:^|[;\n])\s*(export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g
const CLASS_DECL_RE = /(?:^|[;\n])\s*(export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g
const VAR_DECL_RE = /(?:^|[;\n])\s*(export\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)/g
const TYPE_DECL_RE = /(?:^|[;\n])\s*(export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/g

const CALL_RE = /\b([A-Za-z_$][\w$]*)\s*\(/g

// Keywords that look like calls but never are project symbols
const CALL_KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'function',
  'await',
  'typeof',
  'new',
  'delete',
  'void',
  'in',
  'of',
  'do',
  'else',
  'try',
  'finally',
  'throw',
  'case',
  'yield',
  'async',
  'import',
  'require',
])

const SIGNATURE_MAX = 140

// ── Helpers ──────────────────────────────────────────────────────────

function lineOf(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++
  return line
}

function signatureAt(text: string, pos: number): string {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1
  let lineEnd = text.indexOf('\n', pos)
  if (lineEnd === -1) lineEnd = text.length
  const trimmed = text.slice(lineStart, lineEnd).trim()
  return trimmed.length > SIGNATURE_MAX ? trimmed.slice(0, SIGNATURE_MAX) : trimmed
}

/** Parse an import clause into bound names: default, `{ a, b as c }`, `* as ns`. */
function parseImportClause(clause: string): string[] {
  const names: string[] = []
  let c = clause.trim()
  if (c.startsWith('type ')) c = c.slice(5).trim()
  // namespace: * as ns
  const nsMatch = c.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/)
  if (nsMatch) names.push(nsMatch[1]!)
  // named: { a, b as c }
  const braceMatch = c.match(/\{([^}]*)\}/)
  if (braceMatch) {
    for (const part of braceMatch[1]!.split(',')) {
      const p = part.trim()
      if (!p) continue
      const asMatch = p.match(/^(?:type\s+)?([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/)
      // record the *local* binding name (after `as`)
      names.push(asMatch ? asMatch[2]! : p.replace(/^type\s+/, ''))
    }
  }
  // default: leading identifier not part of the above
  const defaultMatch = c.match(/^([A-Za-z_$][\w$]*)\s*(?:,|$)/)
  if (defaultMatch && !c.startsWith('{') && !c.startsWith('*')) names.push(defaultMatch[1]!)
  return [...new Set(names)]
}

// ── Main entry ───────────────────────────────────────────────────────

export function parseFile(path: string, rawText: string): ParsedFile {
  const text = stripComments(rawText)
  const symbols: SymbolDecl[] = []
  const imports: ImportDecl[] = []
  const calls: CallSite[] = []

  // Matches anchored at `[;\n]` start on the newline that ENDS the previous
  // line — anchor line/signature to the keyword or name position instead.
  const keywordPos = (m: RegExpMatchArray, group: string | number) =>
    (m.index ?? 0) + m[0].indexOf(typeof group === 'number' ? m[group]! : group)

  for (const m of text.matchAll(IMPORT_FROM_RE)) {
    const isExport = m[1] === 'export'
    const clause = m[2] ?? ''
    const specifier = m[4] ?? ''
    if (!specifier) continue
    imports.push({
      specifier,
      line: lineOf(text, keywordPos(m, m[1]!)),
      names: parseImportClause(clause),
      isReexport: isExport,
    })
  }
  for (const m of text.matchAll(BARE_IMPORT_RE)) {
    imports.push({
      specifier: m[2] ?? '',
      line: lineOf(text, m.index),
      names: [],
      isReexport: false,
    })
  }
  for (const m of text.matchAll(REQUIRE_RE)) {
    imports.push({
      specifier: m[2] ?? '',
      line: lineOf(text, m.index),
      names: [],
      isReexport: false,
    })
  }

  const pushSymbol = (name: string, kind: SymbolKind, m: RegExpMatchArray, isExported: boolean) => {
    const namePos = (m.index ?? 0) + m[0].indexOf(name)
    symbols.push({
      name,
      kind,
      line: lineOf(text, namePos),
      signature: signatureAt(text, namePos),
      isExported,
    })
  }
  for (const m of text.matchAll(FN_DECL_RE)) pushSymbol(m[2]!, 'function', m, !!m[1])
  for (const m of text.matchAll(CLASS_DECL_RE)) pushSymbol(m[2]!, 'class', m, !!m[1])
  for (const m of text.matchAll(VAR_DECL_RE)) pushSymbol(m[3]!, m[2] as SymbolKind, m, !!m[1])
  for (const m of text.matchAll(TYPE_DECL_RE)) pushSymbol(m[2]!, 'type', m, !!m[1])

  // Declaration name positions — `function helper(` would otherwise be
  // recorded as a call to `helper` (the declaration is not a call site).
  const declNameIndexes = new Set<number>()
  for (const m of text.matchAll(FN_DECL_RE)) declNameIndexes.add(m.index + m[0].indexOf(m[2]!))
  for (const m of text.matchAll(CLASS_DECL_RE)) declNameIndexes.add(m.index + m[0].indexOf(m[2]!))
  for (const m of text.matchAll(VAR_DECL_RE)) declNameIndexes.add(m.index + m[0].indexOf(m[3]!))
  for (const m of text.matchAll(TYPE_DECL_RE)) declNameIndexes.add(m.index + m[0].indexOf(m[2]!))

  for (const m of text.matchAll(CALL_RE)) {
    const name = m[1]!
    if (CALL_KEYWORDS.has(name)) continue
    if (declNameIndexes.has(m.index ?? 0)) continue
    calls.push({ name, line: lineOf(text, m.index ?? 0) })
  }

  return { path, symbols, imports, calls }
}
