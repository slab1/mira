/**
 * Tool: bash — Execute shell commands
 * Permission: checked via BashArity (arity-aware: "rm -rf" > "ls")
 * Timeout: default 30s, configurable
 * Sandbox: MIRA_SANDBOX=1 routes execution through ContainerSandbox (docker/podman,
 * read-only rootfs, no network). Fails closed when no runtime is available.
 */
import { z } from 'zod'
import type { ToolDef } from './registry.js'
import { sanitizeCommand } from '../guardrails/index.js'
import { createSandbox, SandboxError, type ContainerSandbox } from '../sandbox/isolation.js'

const bashSchema = z.object({
  command: z.string().min(1).describe('Shell command to execute'),
  timeout: z.number().optional().describe('Timeout in ms (default 30000)'),
  workdir: z.string().optional().describe('Working directory (default: project cwd)'),
  description: z.string().optional().describe('Human-readable description for TUI'),
})

// Module-level sandbox singleton — reads MIRA_SANDBOX / MIRA_SANDBOX_PROFILE
// at construction. Under a container-requiring profile every command goes
// through the sandbox (and therefore fails closed if no runtime is present);
// under a host profile the sandbox still applies env scrubbing and timeouts.
let sandbox: ContainerSandbox = createSandbox()

/** True when this sandbox demands a container rather than host execution. */
const requiresContainer = (): boolean => sandbox.status().requiresContainer

/** Test hook: swap the sandbox instance (e.g. for a mock). Pass null to reset. */
export function __setSandbox(s: ContainerSandbox | null): void {
  sandbox = s ?? createSandbox()
}

export const bashTool = {
  name: 'bash',
  description:
    'Execute a bash command. Use for building, testing, git, file ops, installing packages (bun add, npm i), running tools/scripts. Prefer read/grep/glob for file inspection. Timeout 30s default.',
  category: 'execution',
  needsPermission: true,
  schema: bashSchema,
  async execute({ command, timeout = 30_000, workdir }, ctx) {
    // Sanitize command at the tool layer — defense in depth beyond guardrails
    const sanitized = sanitizeCommand(command)
    if (!sanitized.ok) {
      return { stdout: '', stderr: `Command rejected: ${sanitized.reason}`, exitCode: 1, command }
    }
    const cwd = workdir ?? ctx.cwd ?? process.cwd()
    // Clamp caller-provided timeout: never allow more than 2 minutes to prevent
    // indefinite runs from LLM-supplied values (e.g. timeout: 9999999).
    const BASH_TIMEOUT_MAX_MS = 120_000
    const effectiveTimeout = Math.min(timeout, BASH_TIMEOUT_MAX_MS)

    // In production, always enforce a container sandbox dynamically even if
    // NODE_ENV=production was applied after module load.
    const effectiveSandbox =
      process.env.NODE_ENV === 'production' && !requiresContainer()
        ? createSandbox({ profile: 'production' })
        : sandbox

    // Sandboxed path — run inside a container with the session cwd mounted.
    // SandboxError (e.g. no container runtime) fails closed: never silent host run.
    if (effectiveSandbox.status().enabled || effectiveSandbox.status().requiresContainer) {
      try {
        const result = await effectiveSandbox.run(['bash', '-c', command], { cwd })
        return {
          stdout: result.out,
          stderr: '',
          exitCode: result.code,
          command,
          isolated: result.isolated,
          ...(result.runtime ? { runtime: result.runtime } : {}),
        }
      } catch (e) {
        const msg =
          e instanceof SandboxError
            ? e.message
            : `Sandbox execution failed: ${e instanceof Error ? e.message : String(e)}`
        return { stdout: '', stderr: msg, exitCode: 1, command }
      }
    }

    // Host fallback only permitted outside production; still strip sensitive secrets.
    const scrubbedEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue
      if (/^(MIRA_TOKEN|MIRA_APPROVAL_SIGNING_KEY)$/i.test(k)) continue
      if (/(API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/i.test(k)) continue
      scrubbedEnv[k] = v
    }

    const proc = Bun.spawn(['bash', '-c', command], {
      cwd,
      env: scrubbedEnv,
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
