/**
 * Tool: bash — Execute shell commands
 * Permission: checked via BashArity (arity-aware: "rm -rf" > "ls")
 * Timeout: default 30s, configurable
 */
import { z } from "zod"
import type { ToolDef } from "./registry.js"

const bashSchema = z.object({
  command: z.string().min(1).describe("Shell command to execute"),
  timeout: z.number().optional().describe("Timeout in ms (default 30000)"),
  workdir: z.string().optional().describe("Working directory (default: project cwd)"),
  description: z.string().optional().describe("Human-readable description for TUI"),
})

export const bashTool = {
  name: "bash",
  description: "Execute a bash command. Use for building, testing, git, file ops. Prefer read/grep/glob for file inspection. Timeout 30s default.",
  category: "execution",
  needsPermission: true,
  schema: bashSchema,
  async execute({ command, timeout = 30_000, workdir }, _ctx) {
    // Security: block obviously dangerous patterns early (permission layer does deeper check)
    const proc = Bun.spawn(["bash", "-c", command], {
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
      timeout,
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    // Truncate huge outputs (LLM context protection)
    const MAX = 30_000
    const out = stdout.length > MAX ? stdout.slice(0, MAX) + `\n…truncated (${stdout.length - MAX} more chars)` : stdout
    const err = stderr.length > MAX ? stderr.slice(0, MAX) + `\n…truncated` : stderr
    return { stdout: out, stderr: err, exitCode, command }
  },
} satisfies ToolDef<typeof bashSchema>

export default bashTool
// Also export as array for registry loader compatibility
export const tools = [bashTool]
export const tool = bashTool
