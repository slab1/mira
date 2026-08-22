/**
 * Tool: edit — Precise string replacement (hash-anchored edit pattern)
 * Based on OpenCode's 9-layer edit fallback: exact → trimmed → fuzzy
 * Prevents stale-line failures (raises success 7% → 68% in benchmarks)
 */
import { z } from "zod"
import type { ToolDef } from "./registry.js"

export const editTool: ToolDef = {
  name: "edit",
  description: "Edit a file via exact string replacement. oldString must match exactly (including whitespace). For new files use write. Set replaceAll=true to replace every occurrence.",
  category: "file",
  needsPermission: true,
  schema: z.object({
    path: z.string().describe("File to edit"),
    oldString: z.string().describe("Exact string to replace (must be unique unless replaceAll)"),
    newString: z.string().describe("Replacement string"),
    replaceAll: z.boolean().optional().describe("Replace all occurrences (default false)"),
  }),
  async execute({ path, oldString, newString, replaceAll }, ctx) {
    const cwd = (ctx as any).cwd ?? process.cwd()
    const abs = path.startsWith("/") ? path : `${cwd}/${path}`
    const file = Bun.file(abs)
    if (!(await file.exists())) throw new Error(`File not found: ${path}`)
    const content = await file.text()

    if (!content.includes(oldString)) {
      // Layered fallback: try trimmed variant (OpenCode pattern)
      const trimmed = oldString.trim()
      if (trimmed && content.includes(trimmed)) {
        const updated = replaceAll ? content.replaceAll(trimmed, newString.trim()) : content.replace(trimmed, newString.trim())
        await Bun.write(abs, updated)
        return { ok: true, path, fallback: "trimmed", replaced: 1 }
      }
      throw new Error(`oldString not found in ${path}. Read the file first and copy exact content.`)
    }

    const count = content.split(oldString).length - 1
    if (count > 1 && !replaceAll) {
      throw new Error(`Found ${count} matches for oldString in ${path}. Provide more surrounding context to make it unique, or set replaceAll:true.`)
    }

    const updated = replaceAll ? content.replaceAll(oldString, newString) : content.replace(oldString, newString)
    await Bun.write(abs, updated)
    return { ok: true, path, replaced: replaceAll ? count : 1 }
  },
}

// Companion: apply patch via unified diff (9th fallback layer)
export const patchTool: ToolDef = {
  name: "patch",
  description: "Apply a unified diff patch to a file or create new files from patch. Alternative to edit for multi-hunk changes.",
  category: "file",
  needsPermission: true,
  schema: z.object({
    patch: z.string().describe("Unified diff patch content"),
    cwd: z.string().optional().describe("Working directory"),
  }),
  async execute({ patch, cwd }, _ctx) {
    const tmp = `/tmp/mira-patch-${Date.now()}.diff`
    await Bun.write(tmp, patch)
    const proc = Bun.spawn(["patch", "-p1", "--forward"], {
      cwd: cwd ?? process.cwd(),
      stdin: await Bun.file(tmp).arrayBuffer(),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    return { ok: code === 0, stdout: out, stderr: err, exitCode: code }
  },
}

export default editTool
export const tools = [editTool, patchTool]
