/**
 * Tool: bash — Execute shell commands
 * Permission: checked via BashArity (arity-aware: "rm -rf" > "ls")
 * Timeout: default 30s, configurable
 */
import { z } from 'zod'
import type { ToolDef } from './registry.js'
import { sanitizeCommand } from '../guardrails/index.js'

const bashSchema = z.object({
  command: z.string().min(1).describe('Shell command to execute'),
  timeout: z.number().optional().describe('Timeout in ms (default 30000)'),
  workdir: z.string().optional().describe('Working directory (default: project cwd)'),
  description: z.string().optional().describe('Human-readable description for TUI'),
})

export const bashTool = {
  name: 'bash',
  description:
    'Execute a bash command. Use for building, testing, git, file ops. Prefer read/grep/glob for file inspection. Timeout 30s default.',
  category: 'execution',
  needsPermission: true,
  schema: bashSchema,
  async execute({ command, timeout = 30_000, workdir }, ctx) {
    // Sanitize command at the tool layer — defense in depth beyond guardrails
    const sanitized = sanitizeCommand(command)
    if (!sanitized.ok) {
      return { stdout: '', stderr: `Command rejected: ${sanitized.reason}`, exitCode: 1, command }
    }
    // Clamp caller-provided timeout: never allow more than 2 minutes to prevent
    // indefinite runs from LLM-supplied values (e.g. timeout: 9999999).
    const BASH_TIMEOUT_MAX_MS = 120_000
    const effectiveTimeout = Math.min(timeout, BASH_TIMEOUT_MAX_MS)
    const proc = Bun.spawn(['bash', '-c', command], {
      cwd: workdir ?? ctx.cwd ?? process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: effectiveTimeout,
    })
    // Kill the process when the abort signal fires (timeout or caller cancellation)
    const onAbort = () => {
      try {
        proc.kill()
      } catch {}
    }
    if (ctx.signal) {
      if (ctx.signal.aborted) {
        onAbort()
      } else {
        ctx.signal.addEventListener('abort', onAbort, { once: true })
      }
    }
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    // Clean up the abort listener if it wasn't triggered
    if (ctx.signal) {
      ctx.signal.removeEventListener('abort', onAbort)
    }
    // Truncate huge outputs (LLM context protection)
    const MAX = 30_000
    const out =
      stdout.length > MAX
        ? stdout.slice(0, MAX) + `\n…truncated (${stdout.length - MAX} more chars)`
        : stdout
    const err = stderr.length > MAX ? stderr.slice(0, MAX) + `\n…truncated` : stderr
    return { stdout: out, stderr: err, exitCode, command }
  },
} satisfies ToolDef<typeof bashSchema>

export default bashTool
// Also export as array for registry loader compatibility
export const tools = [bashTool]
export const tool = bashTool
