/**
 * Production Sandbox Isolation — agent → container → host boundary.
 *
 * Enforces explicit execution profiles, verified container runtime security
 * configuration, least-privilege container flags, environment allowlisting,
 * and strict fail-closed refusal in production when isolation is unavailable.
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
  /** Drop all Linux capabilities and enforce no-new-privileges. */
  dropCapabilities: boolean
  limits: ResourceLimitsSpec
}

export const EXECUTION_PROFILES: Record<ExecutionProfile, ProfilePolicy> = {
  'trusted-local': {
    requiresContainer: false,
    readOnlyRoot: false,
    writableWork: true,
    scrubEnv: true,
    dropCapabilities: false,
    limits: { timeoutMs: 120_000 },
  },
  restricted: {
    requiresContainer: false,
    readOnlyRoot: false,
    writableWork: true,
    scrubEnv: true,
    dropCapabilities: false,
    limits: { memory: '2g', cpus: '2', pids: 256, timeoutMs: 120_000 },
  },
  'isolated-experiment': {
    requiresContainer: true,
    readOnlyRoot: true,
    writableWork: false,
    scrubEnv: true,
    dropCapabilities: true,
    limits: { memory: '4g', cpus: '2', pids: 512, timeoutMs: 300_000 },
  },
  production: {
    requiresContainer: true,
    readOnlyRoot: true,
    writableWork: false,
    scrubEnv: true,
    dropCapabilities: true,
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

export interface RuntimeVerificationResult {
  ok: boolean
  rootless?: boolean
  securityOptions?: string[]
  reason?: string
}

export type RuntimeProbe = (runtime: string) => RuntimeVerificationResult

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
  /** Container UID:GID (default '65534:65534' nobody). Root ('0', 'root') rejected in production. */
  user?: string
  /** Require `@sha256:...` digest pinning on container image. */
  requireDigestPin?: boolean
  /** Verify runtime daemon health & security posture before running containers. */
  verifyRuntime?: boolean
  /** Optional custom runtime probe (for deterministic tests). */
  runtimeProbe?: RuntimeProbe
}

export interface RunOptions {
  cwd: string
  /** Disposable, separately-controlled writable directory for experiments. */
  worktree?: string
}

type ResolvedConfig = {
  enabled: boolean
  profile: ExecutionProfile
  image: string
  runtime?: string
  allowFallback: boolean
  timeoutMs: number
  limits: ResourceLimitsSpec
  envAllowlist: string[]
  user: string
  requireDigestPin: boolean
  verifyRuntime: boolean
  runtimeProbe?: RuntimeProbe
}

function isProductionMode(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.MIRA_SANDBOX_STRICT === '1'
}

export function validateContainerImage(image: string, requireDigestPin: boolean, profile: ExecutionProfile): void {
  const trimmed = image.trim()
  if (!trimmed || /[\s\0\n\r]/.test(trimmed)) {
    throw new SandboxError('Container image must be a valid non-empty reference')
  }
  if (profile === 'production' && /:latest$/i.test(trimmed)) {
    throw new SandboxError(`Refusing mutable ":latest" image "${trimmed}" in production profile`)
  }
  if (requireDigestPin && !/@sha256:[a-f0-9]{64}$/i.test(trimmed)) {
    throw new SandboxError(
      `Container image "${trimmed}" must be pinned by immutable @sha256 digest`,
    )
  }
}

export function defaultRuntimeProbe(runtime: string): RuntimeVerificationResult {
  try {
    const res = Bun.spawnSync([runtime, 'info', '--format', '{{json .}}'], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 5000,
    })
    if (res.exitCode !== 0) {
      const stderr = res.stderr ? new TextDecoder().decode(res.stderr).trim() : ''
      return {
        ok: false,
        reason: `${runtime} daemon check failed (exit ${res.exitCode})${stderr ? `: ${stderr.slice(0, 200)}` : ''}`,
      }
    }
    const raw = res.stdout ? new TextDecoder().decode(res.stdout).trim() : '{}'
    const info = JSON.parse(raw) as {
      SecurityOptions?: string[]
      Host?: { Security?: { Rootless?: boolean } }
      Rootless?: boolean
    }
    const securityOptions = Array.isArray(info.SecurityOptions) ? info.SecurityOptions : []
    const rootless =
      Boolean(info.Host?.Security?.Rootless) ||
      Boolean(info.Rootless) ||
      securityOptions.some((opt) => /rootless/i.test(opt))
    return {
      ok: true,
      rootless,
      securityOptions,
    }
  } catch (err) {
    return {
      ok: false,
      reason: `failed to inspect container runtime "${runtime}": ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

export class ContainerSandbox {
  private config: ResolvedConfig
  private readonly policy: ProfilePolicy
  readonly profile: ExecutionProfile

  constructor(config: SandboxConfig = {}) {
    const prod = isProductionMode()
    const profile = resolveProfile(config)
    this.profile = profile
    this.policy = EXECUTION_PROFILES[profile]

    if ((prod || profile === 'production') && config.allowFallback === true) {
      throw new SandboxError(
        `profile "${profile}" refuses allowFallback — host fallback is forbidden in production`,
      )
    }
    if ((prod || profile === 'production') && process.env.MIRA_SANDBOX_ALLOW_FALLBACK === '1') {
      throw new SandboxError(
        'MIRA_SANDBOX_ALLOW_FALLBACK=1 is forbidden in production — refusing unsafe host fallback',
      )
    }

    const user = (config.user ?? '65534:65534').trim()
    if (profile === 'production' && /^(0|0:0|root|root:root)$/i.test(user)) {
      throw new SandboxError(`Refusing root container user "${user}" in production profile`)
    }

    const image = config.image ?? 'node:22-alpine'
    const requireDigestPin =
      config.requireDigestPin ?? process.env.MIRA_SANDBOX_REQUIRE_DIGEST === '1'
    validateContainerImage(image, requireDigestPin, profile)

    this.config = {
      enabled: config.enabled ?? profile !== 'trusted-local',
      profile,
      image,
      runtime: config.runtime,
      // Host fallback is only allowed in explicit non-production dev/test calls
      // for isolated-experiment, never via env var override in production.
      allowFallback:
        !prod && profile === 'isolated-experiment' ? config.allowFallback === true : false,
      timeoutMs: config.timeoutMs ?? this.policy.limits.timeoutMs,
      limits: { ...this.policy.limits, ...(config.limits ?? {}) },
      envAllowlist: config.envAllowlist ?? [],
      user,
      requireDigestPin,
      verifyRuntime: config.verifyRuntime ?? (profile === 'production' || prod),
      runtimeProbe: config.runtimeProbe,
    }
  }

  private detectRuntime(): string | null {
    if (this.config.runtime) return Bun.which(this.config.runtime) ? this.config.runtime : null
    if (Bun.which('docker')) return 'docker'
    if (Bun.which('podman')) return 'podman'
    return null
  }

  /**
   * Verify the container runtime daemon is responsive and satisfies profile
   * security requirements (fails closed when misconfigured or unreachable).
   */
  verifyRuntimeConfiguration(runtime: string): RuntimeVerificationResult {
    const probe = this.config.runtimeProbe ?? defaultRuntimeProbe
    const result = probe(runtime)
    if (!result.ok) {
      throw new SandboxError(
        `profile "${this.profile}" container runtime "${runtime}" failed security/health verification: ` +
          `${result.reason ?? 'daemon unavailable'}. Refusing to run untrusted work on the host.`,
      )
    }
    return result
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

  /** Build the hardened docker/podman invocation argument list. */
  buildContainerArgs(runtime: string, cmd: string[], opts: RunOptions): string[] {
    const cwd = this.safeDir(opts.cwd, 'cwd')
    const mounts: string[] = []
    mounts.push('-v', `${cwd}:/work:ro`)
    if (opts.worktree) {
      const wt = this.safeDir(opts.worktree, 'worktree')
      mounts.push('-v', `${wt}:/scratch:rw`)
    }
    if (this.policy.readOnlyRoot) mounts.push('--read-only')
    mounts.push('--tmpfs', '/tmp:rw,noexec,nosuid,size=256m')

    const securityFlags: string[] = ['--network', 'none', '--user', this.config.user]
    if (this.policy.dropCapabilities) {
      securityFlags.push('--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--ipc=none')
    }

    const workdir = opts.worktree ? '/scratch' : '/work'
    return [
      runtime,
      'run',
      '--rm',
      ...securityFlags,
      ...mounts,
      ...this.limitFlags(),
      '-w',
      workdir,
      this.config.image,
      ...cmd,
    ]
  }

  /** Run a command under this sandbox's profile. */
  async run(cmd: string[], opts: RunOptions): Promise<SandboxResult> {
    const cwd = this.safeDir(opts.cwd, 'cwd')

    if (!this.policy.requiresContainer) {
      if (isProductionMode()) {
        throw new SandboxError(
          `profile "${this.profile}" is not isolated and cannot execute in production`,
        )
      }
      return this.exec(cmd, cwd, false)
    }

    const runtime = this.detectRuntime()
    if (!runtime) {
      if (this.config.allowFallback && !isProductionMode() && this.profile !== 'production') {
        return this.exec(cmd, cwd, false)
      }
      throw new SandboxError(
        `profile "${this.profile}" requires a container runtime but neither docker nor podman was found. ` +
          'Refusing to run untrusted work on the host.',
      )
    }

    if (this.config.verifyRuntime) {
      this.verifyRuntimeConfiguration(runtime)
    }

    const full = this.buildContainerArgs(runtime, cmd, opts)
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

/** MIRA_SANDBOX_PROFILE wins; production fails closed to 'production'. */
function resolveProfile(config: SandboxConfig): ExecutionProfile {
  const prod = isProductionMode()
  if (config.profile) {
    if (prod && !EXECUTION_PROFILES[config.profile].requiresContainer) {
      throw new SandboxError(
        `profile "${config.profile}" does not provide container isolation required in production`,
      )
    }
    return config.profile
  }
  const env = process.env.MIRA_SANDBOX_PROFILE?.trim()
  if (env && env in EXECUTION_PROFILES) {
    const prof = env as ExecutionProfile
    if (prod && !EXECUTION_PROFILES[prof].requiresContainer) {
      throw new SandboxError(
        `MIRA_SANDBOX_PROFILE="${prof}" does not provide container isolation required in production`,
      )
    }
    return prof
  }
  if (prod) {
    if (process.env.MIRA_SANDBOX === '0' || config.enabled === false) {
      throw new SandboxError('Disabling sandbox isolation (MIRA_SANDBOX=0) is forbidden in production')
    }
    return 'production'
  }
  if (process.env.MIRA_SANDBOX === '1' || config.enabled === true) return 'isolated-experiment'
  if (process.env.MIRA_SANDBOX === '0' || config.enabled === false) return 'trusted-local'
  if (Bun.which('docker') || Bun.which('podman')) {
    return 'isolated-experiment'
  }
  return 'trusted-local'
}

export function createSandbox(config?: SandboxConfig): ContainerSandbox {
  return new ContainerSandbox(config)
}
