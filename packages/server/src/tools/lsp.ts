/**
 * Tool: lsp — Language Server Protocol intelligence
 * Symbol-aware edits: find references, go-to-definition, diagnostics
 * Core of Mira's 9-layer edit reliability
 */
import { z } from "zod"
import type { ToolDef } from "./registry.js"
import type { JsonValue } from "../types/index.js"
import { symbolIndex } from "../symbols/index.js"
import { guardEdit } from "../symbols/semantic.js"
import { resolve } from "node:path"
import { readFileSync } from "node:fs"
import { clientForFile, type LSPClient } from "../lsp/client.js"

const LANG_BY_EXT: Record<string, string> = {
  go: "go", ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  py: "python", rs: "rust", md: "markdown", json: "json",
}

/**
 * Plain-JSON view of LSP payload values (typing only).
 * LSP SDK results are declared as interfaces (SymbolInfo / LSPLocation), which
 * are not assignable to JsonValue; a JSON round-trip yields identical data with
 * a JsonValue-compatible type.
 */
const asJson = (v: object | string | number | boolean | null): JsonValue =>
  JSON.parse(JSON.stringify(v ?? null)) as JsonValue

/**
 * Real LSP path: spawn/connect a language server for the file's language,
 * push the document, run the operation. Returns null when no server is
 * available — caller falls back to heuristic symbolIndex.
 */
async function withRealLSP<T>(
  file: string,
  root: string,
  op: (client: LSPClient, uri: string) => Promise<T>,
): Promise<T | null> {
  const client = await clientForFile(file, root)
  if (!client?.alive) return null
  const abs = resolve(root, file)
  let text = ""
  try { text = readFileSync(abs, "utf-8") } catch { return null }
  const uri = `file://${abs}`
  await client.didOpen(uri, text, LANG_BY_EXT[abs.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext")
  return await op(client, uri)
}

const lspSchema = z.object({
  operation: z.enum(["hover", "definition", "references", "diagnostics", "rename"]).describe("LSP operation"),
  file: z.string().describe("File path"),
  line: z.number().optional().describe("Line (1-indexed)"),
  character: z.number().optional().describe("Character (0-indexed)"),
  symbol: z.string().optional().describe("Symbol name for references/rename if line/char not provided"),
  newName: z.string().optional().describe("For rename operation"),
})

export const lspTool = {
  name: "lsp",
  description: "LSP operations: hover, definition, references, diagnostics, rename. Use for symbol-aware code intelligence before edits.",
  category: "file",
  schema: lspSchema,
  async execute({ operation, file, line, character, symbol, newName }, ctx) {
    const root = ctx.cwd ?? process.cwd();

    // ── Real LSP first (gopls etc.); heuristic fallback when unavailable ──
    const real = await withRealLSP(file, root, async (client, uri) => {
      const pos = { line: Math.max(0, (line ?? 1) - 1), character: character ?? 0 }
      switch (operation) {
        case "hover":
          return { operation, file, server: client.serverName, hover: await client.hover(uri, pos) }
        case "definition": {
          if (line == null || character == null) throw new Error("line and character required for definition")
          return { operation, file, server: client.serverName, definition: asJson(await client.definition(uri, pos)) }
        }
        case "references": {
          const pos2 = line != null && character != null ? pos : null
          if (!pos2 && !symbol) throw new Error("symbol or line/character required for references")
          // When only a name is given, fall through to heuristics for locating it
          if (!pos2) throw new Error("SKIP_TO_FALLBACK")
          return { operation, file, server: client.serverName, references: asJson(await client.references(uri, pos2)) }
        }
      }
      throw new Error("SKIP_TO_FALLBACK")
    }).catch(e => e instanceof Error && e.message === "SKIP_TO_FALLBACK" ? undefined : { error: String(e) })

    if (real !== null && real !== undefined && !("error" in real)) return real

    // ── Heuristic fallback (symbolIndex) — original implementation ──
    try {
      switch (operation) {
        case "hover": {
          if (line == null || character == null) throw new Error("line and character required for hover");
          const contents = await symbolIndex.hover(file, line, character);
          return { operation, file, line, character, hover: contents };
        }
        case "definition": {
          if (line == null || character == null) throw new Error("line and character required for definition");
          const def = await symbolIndex.findDefinition(file, line, character);
          return { operation, file, line, character, definition: asJson(def) };
        }
        case "references": {
          const name = symbol ?? (line != null && character != null ? (await symbolIndex.findSymbolAt(file, line, character))?.name : undefined);
          if (!name) throw new Error("symbol name required for references");
          const occurrences = await symbolIndex.findReferences(name);
          return { operation, symbol: name, references: occurrences };
        }
        case "diagnostics": {
          const issues = await symbolIndex.diagnostics(file);
          return { operation, file, diagnostics: issues };
        }
        case "rename": {
          if (!symbol && (!line || !character)) throw new Error("symbol name or location required for rename");
          const targetName = symbol ?? (await symbolIndex.findSymbolAt(file, line!, character!))?.name;
          if (!targetName) throw new Error("symbol not found");
          if (!newName) throw new Error("newName required for rename");
          const result = await symbolIndex.renameSymbol(targetName, newName);
          return { operation, oldName: targetName, newName, renamedFiles: result.files, occurrences: result.count };
        }
      }
      // Switch above is exhaustive over the operation enum — unreachable guard
      // so the inferred return type excludes undefined (JsonValue contract).
      throw new Error(`unsupported LSP operation: ${operation}`);
    } catch (err) {
      return { operation, file, error: String(err) };
    }
  },
} satisfies ToolDef<typeof lspSchema>

export default lspTool
export const tools = [lspTool]
export const tool = lspTool
