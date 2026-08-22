import { SymbolInfo, SymbolKind } from "./types.js";

export class SymbolIndex {
  private cache = new Map<string, SymbolInfo[]>();
  private root: string;

  constructor(root: string = process.cwd()) {
    this.root = root;
  }

  private async readFile(path: string): Promise<string> {
    const abs = path.startsWith("/") ? path : `${this.root}/${path}`;
    const file = Bun.file(abs);
    if (!(await file.exists())) return "";
    return await file.text();
  }

  private parseSymbols(content: string, file: string): SymbolInfo[] {
    const lines = content.split("\n");
    const symbols: SymbolInfo[] = [];

    const patterns: Array<{ regex: RegExp; kind: SymbolKind; isExport: boolean }> = [
      { regex: /^\s*export\s+function\s+([A-Za-z0-9_$]+)/, kind: "function", isExport: true },
      { regex: /^\s*export\s+const\s+([A-Za-z0-9_$]+)/, kind: "const", isExport: true },
      { regex: /^\s*export\s+let\s+([A-Za-z0-9_$]+)/, kind: "let", isExport: true },
      { regex: /^\s*export\s+var\s+([A-Za-z0-9_$]+)/, kind: "var", isExport: true },
      { regex: /^\s*export\s+class\s+([A-Za-z0-9_$]+)/, kind: "class", isExport: true },
      { regex: /^\s*export\s+interface\s+([A-Za-z0-9_$]+)/, kind: "interface", isExport: true },
      { regex: /^\s*export\s+type\s+([A-Za-z0-9_$]+)/, kind: "type", isExport: true },
      { regex: /^\s*export\s+enum\s+([A-Za-z0-9_$]+)/, kind: "enum", isExport: true },
      { regex: /^\s*function\s+([A-Za-z0-9_$]+)/, kind: "function", isExport: false },
      { regex: /^\s*class\s+([A-Za-z0-9_$]+)/, kind: "class", isExport: false },
      { regex: /^\s*interface\s+([A-Za-z0-9_$]+)/, kind: "interface", isExport: false },
      { regex: /^\s*type\s+([A-Za-z0-9_$]+)/, kind: "type", isExport: false },
      { regex: /^\s*enum\s+([A-Za-z0-9_$]+)/, kind: "enum", isExport: false },
      { regex: /^\s*const\s+([A-Za-z0-9_$]+)\s*=/, kind: "const", isExport: false },
      { regex: /^\s*let\s+([A-Za-z0-9_$]+)\s*=/, kind: "let", isExport: false },
      { regex: /^\s*var\s+([A-Za-z0-9_$]+)\s*=/, kind: "var", isExport: false },
    ];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Capture JSDoc comment above symbol
      let doc: string | undefined;
      if (line.trim().startsWith("*") || line.trim().startsWith("/**")) {
        // simple collect previous comments
        const comments: string[] = [];
        let j = i;
        while (j >= 0 && lines[j].trim().startsWith("*")) {
          comments.unshift(lines[j].replace(/^\s*\*\s?/, ""));
          j--;
        }
        if (comments.length) doc = comments.join(" ").trim();
      }

      for (const p of patterns) {
        const m = line.match(p.regex);
        if (m) {
          const name = m[1];
          const character = line.indexOf(name);
          symbols.push({
            name,
            kind: p.kind,
            file,
            line: i + 1,
            character,
            export: p.isExport,
            doc,
            range: { start: { line: i + 1, character }, end: { line: i + 1, character: character + name.length } },
          });
          break;
        }
      }
    }

    return symbols;
  }

  async ensureIndexed(file: string): Promise<SymbolInfo[]> {
    if (this.cache.has(file)) return this.cache.get(file)!;
    const content = await this.readFile(file);
    const symbols = this.parseSymbols(content, file);
    this.cache.set(file, symbols);
    return symbols;
  }

  async findSymbolAt(file: string, line: number, character: number): Promise<SymbolInfo | null> {
    const symbols = await this.ensureIndexed(file);
    const content = await this.readFile(file);
    const lines = content.split("\n");
    const targetLine = lines[line - 1] ?? "";
    // Extract word at character
    const before = targetLine.slice(0, character);
    const after = targetLine.slice(character);
    const wordMatch = before.match(/([A-Za-z0-9_$]+)$/);
    const word = wordMatch ? wordMatch[1] : targetLine.slice(character).match(/^([A-Za-z0-9_$]+)/)?.[1];
    if (!word) return null;
    // Find symbol definition in file with matching name
    const sym = symbols.find(s => s.name === word);
    return sym ?? null;
  }

  async findDefinition(file: string, line: number, character: number): Promise<SymbolInfo | null> {
    const sym = await this.findSymbolAt(file, line, character);
    if (!sym) return null;
    // For simplicity, try to find exact symbol definition in same file first
    const symbols = await this.ensureIndexed(file);
    const def = symbols.find(s => s.name === sym.name);
    if (def) return def;
    // Fallback: search workspace for exported symbol
    const candidates = await this.findSymbolInWorkspace(sym.name);
    return candidates[0] ?? null;
  }

  async findSymbolInWorkspace(name: string): Promise<SymbolInfo[]> {
    // Simple glob search in packages/**/*.ts
    const results: SymbolInfo[] = [];
    const files = await this.glob("packages/**/*.ts");
    for (const f of files) {
      const symbols = await this.ensureIndexed(f);
      const match = symbols.find(s => s.name === name && s.export);
      if (match) results.push(match);
    }
    return results;
  }

  async findReferences(name: string): Promise<Array<{ file: string; line: number; character: number }>> {
    const occurrences: Array<{ file: string; line: number; character: number }> = [];
    const files = await this.glob("packages/**/*.ts");
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`\\b${escaped}\\b`, "g");
    for (const f of files) {
      const content = await this.readFile(f);
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let m: RegExpExecArray | null;
        while ((m = regex.exec(line)) !== null) {
          occurrences.push({ file: f, line: i + 1, character: m.index });
        }
      }
    }
    return occurrences;
  }

  async renameSymbol(oldName: string, newName: string): Promise<{ files: string[]; count: number }> {
    const occurrences = await this.findReferences(oldName);
    const filesSet = new Set<string>();
    let count = 0;
    for (const occ of occurrences) {
      const abs = occ.file.startsWith("/") ? occ.file : `${this.root}/${occ.file}`;
      const content = await this.readFile(occ.file);
      const lines = content.split("\n");
      const lineIdx = occ.line - 1;
      const line = lines[lineIdx];
      const idx = occ.character;
      if (line.slice(idx, idx + oldName.length) === oldName) {
        const newLine = line.slice(0, idx) + newName + line.slice(idx + oldName.length);
        lines[lineIdx] = newLine;
        const newContent = lines.join("\n");
        await Bun.write(abs, newContent);
        filesSet.add(occ.file);
        count++;
        // Invalidate cache
        this.cache.delete(occ.file);
      }
    }
    return { files: [...filesSet], count };
  }

  private async glob(pattern: string): Promise<string[]> {
    // Very naive implementation for packages/**/*.ts
    const results: string[] = [];
    const base = this.root;
    await this.walk(base, pattern, results);
    return results;
  }

  private async walk(dir: string, pattern: string, results: string[]) {
    try {
      for await (const entry of Bun.readDir(dir)) {
        const full = `${dir}/${entry}`;
        if (entry === "." || entry === "..") continue;
        const stat = await Bun.file(full).stat().catch(() => null);
        if (!stat) continue;
        if (stat.isDirectory()) {
          await this.walk(full, pattern, results);
        } else if (full.endsWith(".ts") || full.endsWith(".tsx")) {
          // crude filter
          if (pattern.includes("packages")) {
            results.push(full.replace(this.root + "/", ""));
          }
        }
      }
    } catch {}
  }

  async hover(file: string, line: number, character: number): Promise<string> {
    const sym = await this.findSymbolAt(file, line, character);
    if (!sym) return "No symbol at position";
    const parts = [
      `Symbol: ${sym.name}`,
      `Kind: ${sym.kind}`,
      `Exported: ${sym.export}`,
      `Location: ${sym.file}:${sym.line}:${sym.character}`,
      sym.doc ? `Doc: ${sym.doc}` : "",
    ].filter(Boolean);
    return parts.join("\n");
  }

  async diagnostics(file: string): Promise<string[]> {
    const content = await this.readFile(file);
    const issues: string[] = [];
    if (!content) return issues;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/\btodo\b/i.test(line)) issues.push(`Line ${i+1}: TODO found`);
      if (line.includes("any")) issues.push(`Line ${i+1}: usage of 'any'`);
    }
    return issues;
  }
}

export const symbolIndex = new SymbolIndex();
