/**
 * Tool: read — Read files (text, images via base64)
 * Layered fallback: Bun.file → with line numbers, handles large files via offset/limit
 */
import { z } from "zod"
import type { ToolDef } from "./registry.js"

export const readTool = {
  name: "read",
  description: "Read a file from disk. Returns content with line numbers. For images, returns base64. Use glob to discover files first.",
  category: "file",
  schema: z.object({
    path: z.string().describe("Absolute or relative path to file"),
    offset: z.number().optional().describe("Line offset (1-indexed)"),
    limit: z.number().optional().describe("Max lines to return (default 2000)"),
  }),
  async execute({ path, offset = 1, limit = 2000 }, ctx) {
    const cwd = (ctx as any).cwd ?? process.cwd()
    const abs = path.startsWith("/") ? path : `${cwd}/${path}`
    const file = Bun.file(abs)
    if (!(await file.exists())) throw new Error(`File not found: ${path}`)

    // Image handling
    if (/\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(path)) {
      const buf = await file.arrayBuffer()
      const b64 = Buffer.from(buf).toString("base64")
      const mime = path.endsWith(".png") ? "image/png" : path.endsWith(".webp") ? "image/webp" : "image/jpeg"
      return { type: "image", mime, base64: b64.slice(0, 100_000) + (b64.length > 100_000 ? "…truncated" : "") }
    }

    const text = await file.text()
    const lines = text.split("\n")
    const slice = lines.slice(offset - 1, offset - 1 + limit)
    const numbered = slice.map((l, i) => `${String(offset + i).padStart(4, " ")}│ ${l}`).join("\n")
    const truncated = lines.length > offset - 1 + limit ? `\n… ${lines.length - (offset - 1 + limit)} more lines` : ""
    return { path, content: numbered + truncated, totalLines: lines.length }
  },
}

export default readTool
export const tools = [readTool]
export const tool = readTool
