/**
 * Tool: lsp — Language Server Protocol intelligence
 * Symbol-aware edits: find references, go-to-definition, diagnostics
 * Core of Mira's 9-layer edit reliability
 */
import { z } from "zod"
import type { ToolDef } from "./registry.js"

export const lspTool: ToolDef = {
  name: "lsp",
  description: "LSP operations: hover, definition, references, diagnostics, rename. Use for symbol-aware code intelligence before edits.",
  category: "file",
  schema: z.object({
    operation: z.enum(["hover", "definition", "references", "diagnostics", "rename"]).describe("LSP operation"),
    file: z.string().describe("File path"),
    line: z.number().optional().describe("Line (1-indexed)"),
    character: z.number().optional().describe("Character (0-indexed)"),
    newName: z.string().optional().describe("For rename operation"),
  }),
  async execute({ operation, file, line, character, newName }, _ctx) {
    // In production: connect to language server (typescript-language-server, rust-analyzer, etc.)
    // via JSON-RPC over stdio, proxy through MCP-style transport
    // Stub: return placeholder that signals readiness
    return {
      operation, file, line, character,
      result: `[LSP stub: ${operation} on ${file}:${line}:${character}] — connect language server for live intelligence. Diagnostics/rename/hover require LSP process.`,
      ...(newName ? { newName } : {}),
    }
  },
}

export default lspTool
export const tools = [lspTool]
export const tool = lspTool
