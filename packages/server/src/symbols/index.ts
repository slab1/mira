import { SymbolInfo, SymbolKind } from './types.js'
import { SymbolCache, hashContent } from './cache.js'

export class SymbolIndex {
  private cache = new Map<string, SymbolInfo[]>()
  private lruCache = new SymbolCache()
  private root: string

  constructor(root: string = process.cwd()) {
    this.root = root
  }

  /** Update root for workspace-aware per-session use */
  setRoot(root: string): void {
    this.root = root
  }
  getRoot(): string {
    return this.root
  }
  private resolveRoot(cwd?: string): string {
    return cwd ?? this.root
  }

  private async readFile(path: string, cwd?: string): Promise<string> {
    const root = this.resolveRoot(cwd)
    const abs = path.startsWith('/') ? path : `${root}/${path}`
    const file = Bun.file(abs)
    if (!(await file.exists())) return ''
    return await file.text()
  }

  private parseSymbols(content: string, file: string): SymbolInfo[] {
    const lines = content.split('\n')
    const symbols: SymbolInfo[] = []

    const patterns: Array<{ regex: RegExp; kind: SymbolKind; isExport: boolean }> = [
      { regex: /^\s*export\s+function\s+([A-Za-z0-9_$]+)/, kind: 'function', isExport: true },
      { regex: /^\s*export\s+const\s+([A-Za-z0-9_$]+)/, kind: 'const', isExport: true },
      { regex: /^\s*export\s+let\s+([A-Za-z0-9_$]+)/, kind: 'let', isExport: true },
      { regex: /^\s*export\s+var\s+([A-Za-z0-9_$]+)/, kind: 'var', isExport: true },
      { regex: /^\s*export\s+class\s+([A-Za-z0-9_$]+)/, kind: 'class', isExport: true },
      { regex: /^\s*export\s+interface\s+([A-Za-z0-9_$]+)/, kind: 'interface', isExport: true },
      { regex: /^\s*export\s+type\s+([A-Za-z0-9_$]+)/, kind: 'type', isExport: true },
      { regex: /^\s*export\s+enum\s+([A-Za-z0-9_$]+)/, kind: 'enum', isExport: true },
      { regex: /^\s*function\s+([A-Za-z0-9_$]+)/, kind: 'function', isExport: false },
      { regex: /^\s*class\s+([A-Za-z0-9_$]+)/, kind: 'class', isExport: false },
      { regex: /^\s*interface\s+([A-Za-z0-9_$]+)/, kind: 'interface', isExport: false },
      { regex: /^\s*type\s+([A-Za-z0-9_$]+)/, kind: 'type', isExport: false },
      { regex: /^\s*enum\s+([A-Za-z0-9_$]+)/, kind: 'enum', isExport: false },
      { regex: /^\s*const\s+([A-Za-z0-9_$]+)\s*=/, kind: 'const', isExport: false },
      { regex: /^\s*let\s+([A-Za-z0-9_$]+)\s*=/, kind: 'let', isExport: false },
      { regex: /^\s*var\s+([A-Za-z0-9_$]+)\s*=/, kind: 'var', isExport: false },
    ]

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      // Capture JSDoc comment above symbol
      let doc: string | undefined
      if (line.trim().startsWith('*') || line.trim().startsWith('/**')) {
        // simple collect previous comments
        const comments: string[] = []
        let j = i
        while (j >= 0 && lines[j].trim().startsWith('*')) {
          comments.unshift(lines[j].replace(/^\s*\*\s?/, ''))
          j--
        }
        if (comments.length) doc = comments.join(' ').trim()
      }

      for (const p of patterns) {
        const m = line.match(p.regex)
        if (m) {
          const name = m[1]
          const character = line.indexOf(name)
          symbols.push({
            name,
            kind: p.kind,
            file,
            line: i + 1,
            character,
            export: p.isExport,
            doc,
            range: {
              start: { line: i + 1, character },
              end: { line: i + 1, character: character + name.length },
            },
          })
          break
        }
      }
    }

    return symbols
  }

  async ensureIndexed(file: string, cwd?: string): Promise<SymbolInfo[]> {
    const content = await this.readFile(file, cwd)
    // Try LRU cache with contentHash invalidation first
    const cached = this.lruCache.get(file, content)
    if (cached) {
      // Keep legacy Map in sync
      this.cache.set(file, cached)
      return cached
    }
    if (this.cache.has(file)) {
      // Check if content hash changed — invalidate if stale
      const existing = this.cache.get(file)!
      // If we have content, verify hash hasn't changed via LRU miss
      // LRU miss already indicates hash mismatch or TTL expiry, so re-parse
      // Fall through to re-parse
      if (content && this.lruCache.get(file, content) === undefined) {
        // Content changed or TTL expired — re-parse below
      } else {
        return existing
      }
    }
    const symbols = this.parseSymbols(content, file)
    this.cache.set(file, symbols)
    this.lruCache.set(file, symbols, content)
    return symbols
  }

  /** Invalidate cache for a file (called by watcher on didChange) */
  invalidate(file: string): void {
    this.cache.delete(file)
    this.lruCache.invalidate(file)
  }

  async findSymbolAt(file: string, line: number, character: number, cwd?: string): Promise<SymbolInfo | null> {
    const symbols = await this.ensureIndexed(file, cwd)
    const content = await this.readFile(file, cwd)
    const lines = content.split('\n')
    const targetLine = lines[line - 1] ?? ''
    // Extract word at character
    const before = targetLine.slice(0, character)
    const after = targetLine.slice(character)
    const wordMatch = before.match(/([A-Za-z0-9_$]+)$/)
    const word = wordMatch
      ? wordMatch[1]
      : targetLine.slice(character).match(/^([A-Za-z0-9_$]+)/)?.[1]
    if (!word) return null
    // Find symbol definition in file with matching name
    const sym = symbols.find((s) => s.name === word)
    return sym ?? null
  }

  async findDefinition(file: string, line: number, character: number, cwd?: string): Promise<SymbolInfo | null> {
    const sym = await this.findSymbolAt(file, line, character, cwd)
    if (!sym) return null
    // For simplicity, try to find exact symbol definition in same file first
    const symbols = await this.ensureIndexed(file, cwd)
    const def = symbols.find((s) => s.name === sym.name)
    if (def) return def
    // Fallback: search workspace for exported symbol
    const candidates = await this.findSymbolInWorkspace(sym.name, cwd)
    return candidates[0] ?? null
  }

  async findSymbolInWorkspace(name: string, cwd?: string): Promise<SymbolInfo[]> {
    const root = this.resolveRoot(cwd)
    const results: SymbolInfo[] = []
    const files = await this.glob('**/*.{ts,tsx,js,jsx}', root)
    for (const f of files) {
      const symbols = await this.ensureIndexed(f, root)
      const match = symbols.find((s) => s.name === name && s.export)
      if (match) results.push(match)
    }
    return results
  }

  async findReferences(
    name: string,
    cwd?: string,
  ): Promise<Array<{ file: string; line: number; character: number }>> {
    const root = this.resolveRoot(cwd)
    const occurrences: Array<{ file: string; line: number; character: number }> = []
    const files = await this.glob('**/*.{ts,tsx,js,jsx}', root)
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(`\\b${escaped}\\b`, 'g')
    for (const f of files) {
      const content = await this.readFile(f, root)
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        let m: RegExpExecArray | null
        while ((m = regex.exec(line)) !== null) {
          occurrences.push({ file: f, line: i + 1, character: m.index })
        }
      }
    }
    return occurrences
  }

  async renameSymbol(
    oldName: string,
    newName: string,
    cwd?: string,
  ): Promise<{ files: string[]; count: number }> {
    const root = this.resolveRoot(cwd)
    const occurrences = await this.findReferences(oldName, root)
    // Group by file to batch writes — one read + one write per file
    const byFile = new Map<string, typeof occurrences>()
    for (const occ of occurrences) {
      const list = byFile.get(occ.file) ?? []
      list.push(occ)
      byFile.set(occ.file, list)
    }
    const filesSet = new Set<string>()
    let count = 0
    for (const [file, occs] of byFile) {
      const abs = file.startsWith('/') ? file : `${root}/${file}`
      let content = await this.readFile(file, root)
      let lines = content.split('\n')
      // Sort descending by line+char so replacements don't shift earlier offsets on same line
      occs.sort((a, b) => b.line - a.line || b.character - a.character)
      let changed = false
      for (const occ of occs) {
        const lineIdx = occ.line - 1
        const line = lines[lineIdx]
        if (!line) continue
        const idx = occ.character
        if (line.slice(idx, idx + oldName.length) === oldName) {
          lines[lineIdx] = line.slice(0, idx) + newName + line.slice(idx + oldName.length)
          count++
          changed = true
        }
      }
      if (changed) {
        await Bun.write(abs, lines.join('\n'))
        filesSet.add(file)
        this.cache.delete(file)
        this.lruCache.invalidate(file)
      }
    }
    return { files: [...filesSet], count }
  }

  private async glob(pattern: string, cwd?: string): Promise<string[]> {
    const base = this.resolveRoot(cwd)
    // Use Bun.Glob for workspace-aware scanning (respects cwd)
    try {
      const { Glob } = await import('bun')
      const glob = new Glob(pattern)
      const results: string[] = []
      for await (const file of glob.scan({ cwd: base, dot: false, onlyFiles: true })) {
        // Filter to source files only
        if (file.endsWith('.ts') || file.endsWith('.tsx') || file.endsWith('.js') || file.endsWith('.jsx')) {
          results.push(file)
        } else if (!pattern.includes('.')) {
          results.push(file)
        }
      }
      if (results.length) return results
    } catch {}
    // Fallback to walk
    const results: string[] = []
    await this.walk(base, pattern, results)
    return results
  }

  private async walk(dir: string, pattern: string, results: string[], baseRoot?: string) {
    const base = baseRoot ?? dir
    try {
      const { readdirSync } = await import('node:fs')
      const entries = readdirSync(dir)
      for (const entry of entries) {
        const full = `${dir}/${entry}`
        if (entry === '.' || entry === '..') continue
        // Skip ignored dirs
        if (entry === 'node_modules' || entry === '.git' || entry === 'dist' || entry === '.turbo' || entry === '.mira' || entry === 'coverage') continue
        const stat = await Bun.file(full)
          .stat()
          .catch(() => null)
        if (!stat) continue
        if (stat.isDirectory()) {
          await this.walk(full, pattern, results, base)
        } else if (full.endsWith('.ts') || full.endsWith('.tsx') || full.endsWith('.js') || full.endsWith('.jsx')) {
          // Respect session.cwd: return relative path to base (workspace root)
          const rel = full.startsWith(base + '/') ? full.slice(base.length + 1) : full
          results.push(rel)
        }
      }
    } catch {}
  }

  async hover(file: string, line: number, character: number, cwd?: string): Promise<string> {
    const sym = await this.findSymbolAt(file, line, character, cwd)
    if (!sym) return 'No symbol at position'
    const parts = [
      `Symbol: ${sym.name}`,
      `Kind: ${sym.kind}`,
      `Exported: ${sym.export}`,
      `Location: ${sym.file}:${sym.line}:${sym.character}`,
      sym.doc ? `Doc: ${sym.doc}` : '',
    ].filter(Boolean)
    return parts.join('\n')
  }

  async diagnostics(file: string, cwd?: string): Promise<string[]> {
    const content = await this.readFile(file, cwd)
    const issues: string[] = []
    if (!content) return issues
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (/\btodo\b/i.test(line)) issues.push(`Line ${i + 1}: TODO found`)
      if (line.includes('any')) issues.push(`Line ${i + 1}: usage of 'any'`)
    }
    return issues
  }
}

export const symbolIndex = new SymbolIndex()

// Per-session factory — workspace-aware (P2-1)
const indexCache = new Map<string, SymbolIndex>()
export function getSymbolIndex(cwd?: string): SymbolIndex {
  const root = cwd ?? process.cwd()
  let idx = indexCache.get(root)
  if (!idx) {
    idx = new SymbolIndex(root)
    indexCache.set(root, idx)
  }
  return idx
}
export function clearSymbolIndexCache(): void {
  indexCache.clear()
}
