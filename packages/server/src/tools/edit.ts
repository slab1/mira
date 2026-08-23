/**
 * Tool: edit — Precise string replacement (hash-anchored edit pattern)
 * Based on OpenCode's 9-layer edit fallback: exact → trimmed → fuzzy
 * Prevents stale-line failures (raises success 7% → 68% in benchmarks)
 */
import { z } from "zod"
import type { ToolDef } from "./registry.js"
import { applyEditWithFallback } from "./edit-fallback.js"

export const editTool = {
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
    
    // Use 9-layer fallback engine with verification
    const result = await applyEditWithFallback(abs, oldString, newString, replaceAll ?? false)
    
    // Backward compatible return shape
    return {
      ok: result.ok,
      path,
      replaced: result.replaced ?? 1,
      fallback: result.fallback,
      layer: result.layer,
      verification: result.verification,
      notes: result.notes,
    }
  },
}

// Companion: apply patch via unified diff (9th fallback layer)
export const patchTool = {
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
      stdin: Bun.file(tmp) as any,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    return { ok: code === 0, stdout: out, stderr: err, exitCode: code }
  },
}

export default editTool
export const tools = [editTool, patchTool]
