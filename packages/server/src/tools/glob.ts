/**
 * Tools: glob, grep, bash — File discovery & search
 */
import { z } from "zod"
import type { ToolDef } from "./registry.js"
import { Glob } from "bun"

export const globTool = {
  name: "glob",
  description: "Find files by glob pattern. Example: **/*.ts, src/**/*.tsx. Returns matching paths.",
  category: "file",
  schema: z.object({
    pattern: z.string().describe("Glob pattern, e.g. **/*.ts"),
    cwd: z.string().optional().describe("Base directory (default cwd)"),
    limit: z.number().optional().describe("Max results (default 100)"),
  }),
  async execute({ pattern, cwd, limit = 100 }, _ctx) {
    const base = cwd ?? process.cwd()
    const glob = new Glob(pattern)
    const results: string[] = []
    for await (const file of glob.scan({ cwd: base, dot: false })) {
      results.push(file)
      if (results.length >= limit) break
    }
    return { pattern, cwd: base, count: results.length, files: results }
  },
}

export const grepTool = {
  name: "grep",
  description: "Search file contents via regex. Returns file:line matches. Use glob first to narrow scope if needed.",
  category: "file",
  schema: z.object({
    pattern: z.string().describe("Regex pattern to search"),
    include: z.string().optional().describe("Glob filter, e.g. *.ts"),
    path: z.string().optional().describe("Directory to search (default cwd)"),
    limit: z.number().optional().describe("Max matches (default 50)"),
  }),
  async execute({ pattern, include, path, limit = 50 }, _ctx) {
    const cwd = path ?? process.cwd()
    const args = ["-rn", "--color=never", pattern, cwd]
    if (include) args.splice(1, 0, `--include=${include}`)
    args.push("--max-count", String(limit))

    // Use ripgrep if available, fallback to grep
    let proc = Bun.spawn(["rg", "-n", pattern, cwd, "--max-count", String(limit), ...(include ? ["-g", include] : [])], {
      stdout: "pipe", stderr: "pipe",
    })
    let out = await new Response(proc.stdout).text()
    let code = await proc.exited
    if (code !== 0 && !out) {
      // fallback to grep
      proc = Bun.spawn(["grep", ...args], { stdout: "pipe", stderr: "pipe" })
      out = await new Response(proc.stdout).text()
      await proc.exited
    }
    const lines = out.split("\n").filter(Boolean).slice(0, limit)
    return { pattern, cwd, count: lines.length, matches: lines }
  },
}

export default globTool
export const tools = [globTool, grepTool]
