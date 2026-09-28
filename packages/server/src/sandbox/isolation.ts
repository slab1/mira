/**
 * Production Sandbox Isolation — agent → container → host boundary.
 *
 * Runs commands inside a container (docker/podman) when available and
 * MIRA_SANDBOX=1; otherwise falls back to the existing process-level
 * guardrails (allowedRoots etc.) with an explicit `isolated: false` flag so
 * callers know the boundary strength.
 *
 * Never silently weakens isolation: if sandbox is requested but the
 * container runtime is unavailable, the call fails closed (SandboxError)
 * unless `allowFallback` is explicitly set by config (default false).
 */

export interface SandboxResult {
  code: number
  out: string
  isolated: boolean
  runtime?: string
}

export class SandboxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SandboxError'
  }
}

export interface SandboxConfig {
  enabled?: boolean // MIRA_SANDBOX=1
  image?: string // default node:22-alpine
  runtime?: 'docker' | 'podman' // auto-detect if unset
  allowFallback?: boolean // default false: fail closed when runtime missing
  timeoutMs?: number
}

export class ContainerSandbox {
  private config: Required<Omit<SandboxConfig, 'runtime'>> & { runtime?: string }

  constructor(config: SandboxConfig = {}) {
    this.config = {
      enabled: config.enabled ?? process.env.MIRA_SANDBOX === '1',
      image: config.image ?? 'node:22-alpine',
      runtime: config.runtime,
      allowFallback: config.allowFallback ?? false,
      timeoutMs: config.timeoutMs ?? 120_000,
    }
  }

  private detectRuntime(): string | null {
    if (this.config.runtime) return this.config.runtime
    if (Bun.which('docker')) return 'docker'
    if (Bun.which('podman')) return 'podman'
    return null
  }

  /** Run a command inside a container with the repo mounted read-only-ish. */
  async run(cmd: string[], opts: { cwd: string }): Promise<SandboxResult> {
    if (!this.config.enabled) {
      return this.runHost(cmd, opts)
    }
    const runtime = this.detectRuntime()
    if (!runtime) {
      if (this.config.allowFallback) return this.runHost(cmd, opts)
      throw new SandboxError(
        'MIRA_SANDBOX=1 requested but no container runtime (docker/podman) found. ' +
          'Set allowFallback: true to permit host execution.',
      )
    }
    const full = [
      runtime,
      'run', '--rm',
      '--network', 'none',
      '--read-only',
      '-v', `${opts.cwd}:/work:ro`,
      '-w', '/work',
      this.config.image,
      ...cmd,
    ]
    return this.exec(full, opts.cwd, true, runtime)
  }

  /** Host fallback — still subject to guardrails upstream; not isolated. */
  private async runHost(cmd: string[], opts: { cwd: string }): Promise<SandboxResult> {
    return this.exec(cmd, opts.cwd, false)
  }

  private async exec(argv: string[], cwd: string, isolated: boolean, runtime?: string): Promise<SandboxResult> {
    const proc = Bun.spawn(argv, { cwd, stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => proc.kill(), this.config.timeoutMs)
    try {
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return { code, out: `${out}${err}`.trim(), isolated, runtime }
    } finally {
      clearTimeout(timer)
    }
  }

  status(): { enabled: boolean; runtime: string | null; image: string } {
    return {
      enabled: this.config.enabled,
      runtime: this.config.enabled ? this.detectRuntime() : null,
      image: this.config.image,
    }
  }
}

export function createSandbox(config?: SandboxConfig): ContainerSandbox {
  return new ContainerSandbox(config)
}
