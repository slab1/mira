/**
 * Tool: lsp — Language Server Protocol intelligence
 * Symbol-aware edits: find references, go-to-definition, diagnostics
 * Core of Mira's 9-layer edit reliability
 */
import { z } from "zod"
import type { ToolDef } from "./registry.js"
import { symbolIndex } from "../symbols/index.js"

export const lspTool: ToolDef = {
  name: "lsp",
  description: "LSP operations: hover, definition, references, diagnostics, rename. Use for symbol-aware code intelligence before edits.",
  category: "file",
  schema: z.object({
    operation: z.enum(["hover", "definition", "references", "diagnostics", "rename"]).describe("LSP operation"),
    file: z.string().describe("File path"),
    line: z.number().optional().describe("Line (1-indexed)"),
    character: z.number().optional().describe("Character (0-indexed)"),
    symbol: z.string().optional().describe("Symbol name for references/rename if line/char not provided"),
    newName: z.string().optional().describe("For rename operation"),
  }),
  async execute({ operation, file, line, character, symbol, newName }, ctx) {
    const root = (ctx as any)?.cwd ?? process.cwd();
    // Ensure symbolIndex uses same root
    // Note: SymbolIndex is singleton with cwd; for simplicity assume files are relative to root
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
          return { operation, file, line, character, definition: def };
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
    } catch (err) {
      return { operation, file, error: String(err) };
    }
  },
}

export default lspTool
export const tools = [lspTool]
export const tool = lspTool
