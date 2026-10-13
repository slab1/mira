/**
 * Production Sandbox Isolation — agent → container → host boundary.
 *
 * Section 4 of docs/LONG_TERM_RISK_AND_SCALABILITY_PLAN.md requires execution
 * profiles, enforced resource limits, secrets kept out of the experiment
 * environment, and failure when the required isolation cannot be provided.
 *
 * Previously this was a single `enabled` boolean defaulting to MIRA_SANDBOX=1:
 *   - no CPU/memory/pid limits on the container
 *   - the host fallback path spawned with inherited process.env, handing every
 *     API key and token to whatever the agent ran
 *   - `opts.cwd` was interpolated straight into `-v ${cwd}:/work:ro` with no
 *     validation
 *   - bash.ts chose host-or-container from that one boolean, so "trusted local"
 *     and "autonomous experiment" were indistinguishable
 *
 * Profiles make the boundary strength explicit. An isolated profile that cannot
 * get a container FAILS — it never degrades to the host.
 */

import { realpathSync } from 'node:fs'

export type ExecutionProfile = 'trusted-local' | 'restricted' | 'isolated-experiment' | 'production'

export interface SandboxResult {
  code: number
  out: string
  isolated: boolean
  runtime?: string
  profile?: ExecutionProfile
}

export class SandboxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SandboxError'
  }
}

export interface ResourceLimitsSpec {
  /** docker/podman --memory, e.g. '2g' */
  memory?: string
  /** --cpus, e.g. '1.5' */
  cpus?: string
  /** --pids-limit */
  pids?: number
  /** wall clock, enforced host-side (the runtime's own timeout is not relied on) */
  timeoutMs: number
}

export interface ProfilePolicy {
  /** A container is mandatory. Missing runtime ⇒ SandboxError, never host. */
  requiresContainer: boolean
  readOnlyRoot: boolean
  /** Whether the work directory may be written. */
  writableWork: boolean
  /** Strip the parent environment down to an allowlist. */
  scrubEnv: boolean
  limits: ResourceLimitsSpec
}

export const EXECUTION_PROFILES: Record<ExecutionProfile, ProfilePolicy> = {
  'trusted-local': {
    requiresContainer: false,
    readOnlyRoot: false,
    writableWork: true,
    scrubEnv: true,
    limits: { timeoutMs: 120_000 },
  },
  restricted: {
    requiresContainer: false,
    readOnlyRoot: false,
    writableWork: true,
    scrubEnv: true,
    limits: { memory: '2g', cpus: '2', pids: 256, timeoutMs: 120_000 },
  },
  'isolated-experiment': {
    requiresContainer: true,
    readOnlyRoot: true,
    // §4.7: source read-only for analysis; the experiment writes to the
    // disposable worktree the caller passes.
    writableWork: false,
    scrubEnv: true,
    limits: { memory: '4g', cpus: '2', pids: 512, timeoutMs: 300_000 },
  },
  production: {
    requiresContainer: true,
    readOnlyRoot: true,
    writableWork: false,
    scrubEnv: true,
    limits: { memory: '2g', cpus: '1', pids: 128, timeoutMs: 60_000 },
  },
}

/**
 * Environment allowlist. Everything else — MIRA_TOKEN, provider API keys, CI
 * credentials — is withheld from anything an agent starts.
 */
const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TERM',
  'TZ',
  'TMPDIR',
  'NODE_ENV',
  'SHELL',
  'USER',
] as const

export interface SandboxConfig {
  /** @deprecated use `profile`; kept so MIRA_SANDBOX=1 keeps working. */
  enabled?: boolean
  profile?: ExecutionProfile
  image?: string
  runtime?: 'docker' | 'podman'
  allowFallback?: boolean
  timeoutMs?: number
  limits?: Partial<ResourceLimitsSpec>
  /** Extra env names to allow through (e.g. a proxy for dependency installs). */
  envAllowlist?: string[]
}

export interface RunOptions {
  cwd: string
  /** Disposable, separately-controlled writable directory for experiments. */
  worktree?: string
}

type ResolvedConfig = Omit<Required<Omit<SandboxConfig, 'runtime'>>, 'limits'> & {
  runtime?: string
  limits: ResourceLimitsSpec
}

export class ContainerSandbox {
  private config: ResolvedConfig
  private readonly policy: ProfilePolicy
  readonly profile: ExecutionProfile

  constructor(config: SandboxConfig = {}) {
    const profile = resolveProfile(config)
    this.profile = profile
    this.policy = EXECUTION_PROFILES[profile]
    this.config = {
      enabled: config.enabled ?? profile !== 'trusted-local',
      profile,
      image: config.image ?? 'node:22-alpine',
      runtime: config.runtime,
      allowFallback: config.allowFallback ?? false,
      timeoutMs: config.timeoutMs ?? this.policy.limits.timeoutMs,
      limits: { ...this.policy.limits, ...(config.limits ?? {}) },
      envAllowlist: config.envAllowlist ?? [],
    }
  }

  private detectRuntime(): string | null {
    // An explicitly configured runtime still has to exist. Returning an
    // uninstalled name made this fall through to Bun.spawn, which fails with a
    // raw "Executable not found" instead of the SandboxError callers rely on to
    // distinguish "isolation unavailable" from "the command failed".
    if (this.config.runtime) return Bun.which(this.config.runtime) ? this.config.runtime : null
    if (Bun.which('docker')) return 'docker'
    if (Bun.which('podman')) return 'podman'
    return null
  }

  /**
   * Validate a directory before it reaches a `-v` flag. A path containing a
   * colon would split the mount spec; a relative path resolves against whatever
   * cwd the runtime happens to have.
   */
  private safeDir(input: string, label: string): string {
    if (typeof input !== 'string' || input.length === 0) {
      throw new SandboxError(`${label} must be a non-empty path`)
    }
    if (input.includes(':') || /[\n\r\0]/.test(input)) {
      throw new SandboxError(`${label} contains characters that are unsafe in a mount spec`)
    }
    if (!input.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(input)) {
      throw new SandboxError(`${label} must be an absolute path (got "${input}")`)
    }
    try {
      return realpathSync(input)
    } catch {
      throw new SandboxError(`${label} does not resolve to an existing directory: ${input}`)
    }
  }

  /** Environment for a child process — allowlist only, never inherited. */
  private childEnv(): Record<string, string> {
    if (!this.policy.scrubEnv) return (process.env as Record<string, string>) ?? {}
    const allow = new Set<string>([...ENV_ALLOWLIST, ...this.config.envAllowlist])
    const out: Record<string, string> = {}
    for (const key of allow) {
      const v = process.env[key]
      if (v !== undefined) out[key] = v
    }
    return out
  }

  private limitFlags(): string[] {
    const l = this.config.limits
    const flags: string[] = []
    if (l.memory) flags.push('--memory', l.memory)
    if (l.cpus) flags.push('--cpus', String(l.cpus))
    if (l.pids) flags.push('--pids-limit', String(l.pids))
    return flags
  }

  /** Run a command under this sandbox's profile. */
  async run(cmd: string[], opts: RunOptions): Promise<SandboxResult> {
    const cwd = this.safeDir(opts.cwd, 'cwd')

    if (!this.policy.requiresContainer) {
      // Local profiles run on the host — still with a scrubbed environment and
      // the profile's timeout, and `isolated: false` says so plainly.
      return this.exec(cmd, cwd, false)
    }

    const runtime = this.detectRuntime()
    if (!runtime) {
      if (this.config.allowFallback) return this.exec(cmd, cwd, false)
      throw new SandboxError(
        `profile "${this.profile}" requires a container runtime but neither docker nor podman was found. ` +
          'Refusing to run untrusted work on the host.',
      )
    }

    const mounts: string[] = []
    // Source is always mounted read-only; experiments write to `worktree`.
    mounts.push('-v', `${cwd}:/work:ro`)
    if (opts.worktree) {
      const wt = this.safeDir(opts.worktree, 'worktree')
      mounts.push('-v', `${wt}:/scratch:rw`)
    }
    if (this.policy.readOnlyRoot) mounts.push('--read-only')
    mounts.push('--tmpfs', '/tmp:rw,size=256m')

    const workdir = opts.worktree ? '/scratch' : '/work'
    const full = [
      runtime,
      'run',
      '--rm',
      '--network',
      'none',
      ...mounts,
      ...this.limitFlags(),
      '-w',
      workdir,
      this.config.image,
      ...cmd,
    ]
    return this.exec(full, cwd, true, runtime)
  }

  private async exec(
    argv: string[],
    cwd: string,
    isolated: boolean,
    runtime?: string,
  ): Promise<SandboxResult> {
    const proc = Bun.spawn(argv, {
      cwd,
      env: this.childEnv(),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    // Read the wall clock from the merged limits, not the top-level timeoutMs —
    // reading the latter silently ignored a limits.timeoutMs override.
    const timer = setTimeout(() => proc.kill(), this.config.limits.timeoutMs)
    try {
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return { code, out: `${out}${err}`.trim(), isolated, runtime, profile: this.profile }
    } finally {
      clearTimeout(timer)
    }
  }

  status(): {
    enabled: boolean
    runtime: string | null
    image: string
    profile: ExecutionProfile
    requiresContainer: boolean
    limits: ResourceLimitsSpec
  } {
    return {
      enabled: this.config.enabled,
      runtime: this.config.enabled ? this.detectRuntime() : null,
      image: this.config.image,
      profile: this.profile,
      requiresContainer: this.policy.requiresContainer,
      limits: this.config.limits,
    }
  }
}

/** MIRA_SANDBOX_PROFILE wins; MIRA_SANDBOX=1 maps to an isolated experiment. */
function resolveProfile(config: SandboxConfig): ExecutionProfile {
  if (config.profile) return config.profile
  const env = process.env.MIRA_SANDBOX_PROFILE?.trim()
  if (env && env in EXECUTION_PROFILES) return env as ExecutionProfile
  if (config.enabled ?? process.env.MIRA_SANDBOX === '1') return 'isolated-experiment'
  return 'trusted-local'
}

export function createSandbox(config?: SandboxConfig): ContainerSandbox {
  return new ContainerSandbox(config)
}
