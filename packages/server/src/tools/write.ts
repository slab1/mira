/**
 * Tool: write — Create/overwrite files (with mkdir -p)
 * Fallback-aware: creates parent dirs automatically
 */
import { z } from "zod"
import type { ToolDef } from "./registry.js"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"

const writeSchema = z.object({
  path: z.string().describe("File path to write"),
  content: z.string().describe("File content"),
})

export const writeTool = {
  name: "write",
  description: "Create or overwrite a file. Creates parent directories if needed. Prefer edit for partial updates.",
  category: "file",
  needsPermission: true,
  schema: writeSchema,
  async execute({ path, content }, ctx) {
    const cwd = ctx.cwd ?? process.cwd()
    const abs = path.startsWith("/") ? path : `${cwd}/${path}`
    await mkdir(dirname(abs), { recursive: true })
    await Bun.write(abs, content)
    return { ok: true, path, bytes: Buffer.byteLength(content, "utf8") }
  },
} satisfies ToolDef<typeof writeSchema>

export default writeTool
export const tools = [writeTool]
export const tool = writeTool
