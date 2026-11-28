/**
 * Phase 2 Acceptance Tests (Criteria 8–9):
 *  8. Production refuses host fallback (even with MIRA_SANDBOX_ALLOW_FALLBACK=1, MIRA_SANDBOX=0,
 *     trusted-local profile, or missing/unhealthy runtime daemon).
 *  9. Container runtime verification checks daemon health + image digest pinning + non-root /
 *     least-privilege flags (--cap-drop=ALL, --security-opt=no-new-privileges, --network=none, --read-only).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContainerSandbox, SandboxError } from './isolation.js'
import { bashTool, __setSandbox } from '../tools/bash.js'
import type { ToolContext } from '../tools/registry.js'

let dir = ''
const savedEnv: Record<string, string | undefined> = {}

function setEnv(k: string, v: string | undefined) {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k]
  if (v === undefined) delete process.env[k]
  else process.env[k] = v
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mira-sandbox-p2-'))
})

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k]
  __setSandbox(null)
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
})

describe('Phase 2 AC8: Production refuses host fallback fail-closed', () => {
  test('production NODE_ENV defaults to production profile (never trusted-local)', () => {
    setEnv('NODE_ENV', 'production')
    setEnv('MIRA_SANDBOX', undefined)
    setEnv('MIRA_SANDBOX_PROFILE', undefined)
    const s = new ContainerSandbox()
    expect(s.profile).toBe('production')
    expect(s.status().requiresContainer).toBe(true)
  })

  test('production refuses trusted-local, restricted, MIRA_SANDBOX=0, and MIRA_SANDBOX_ALLOW_FALLBACK=1', () => {
    setEnv('NODE_ENV', 'production')
    expect(() => new ContainerSandbox({ profile: 'trusted-local' })).toThrow(SandboxError)
    expect(() => new ContainerSandbox({ profile: 'restricted' })).toThrow(SandboxError)
    expect(() => new ContainerSandbox({ profile: 'production', allowFallback: true })).toThrow(
      SandboxError,
    )

    setEnv('MIRA_SANDBOX', '0')
    expect(() => new ContainerSandbox()).toThrow(SandboxError)
    setEnv('MIRA_SANDBOX', undefined)

    setEnv('MIRA_SANDBOX_ALLOW_FALLBACK', '1')
    expect(() => new ContainerSandbox({ profile: 'isolated-experiment' })).toThrow(SandboxError)
  })

  test('bashTool dynamically refuses host fallback in production', async () => {
    setEnv('NODE_ENV', 'production')
    __setSandbox(
      new ContainerSandbox({
        profile: 'production',
        runtime: 'nonexistent-runtime-xyz' as 'docker',
      }),
    )
    const res = (await bashTool.execute(
      { command: 'echo should-not-run-on-host' },
      { sessionID: 's1', messageID: 'm1', cwd: dir } as ToolContext,
    )) as { exitCode: number; stderr: string; stdout: string }
    expect(res.exitCode).toBe(1)
    expect(res.stdout).toBe('')
    expect(res.stderr).toContain('Refusing to run untrusted work on the host')
  })
})

describe('Phase 2 AC9: Container runtime security verification & least-privilege flags', () => {
  test('runtime daemon failure fails closed even if binary is configured', async () => {
    const s = new ContainerSandbox({
      profile: 'production',
      runtime: 'bash' as 'docker', // Bun.which('bash') resolves on Linux, simulating binary present
      verifyRuntime: true,
      runtimeProbe: () => ({ ok: false, reason: 'Cannot connect to container daemon' }),
    })
    await expect(s.run(['echo', 'hi'], { cwd: dir })).rejects.toThrow(
      'Cannot connect to container daemon',
    )
  })

  test('production rejects mutable :latest image, root user, and unpinned digests when enforced', () => {
    expect(() => new ContainerSandbox({ profile: 'production', image: 'node:latest' })).toThrow(
      SandboxError,
    )
    expect(() => new ContainerSandbox({ profile: 'production', user: 'root' })).toThrow(SandboxError)
    expect(() => new ContainerSandbox({ profile: 'production', user: '0:0' })).toThrow(SandboxError)
    expect(
      () =>
        new ContainerSandbox({
          profile: 'production',
          image: 'node:22-alpine',
          requireDigestPin: true,
        }),
    ).toThrow(SandboxError)

    const pinned = new ContainerSandbox({
      profile: 'production',
      image: 'node@sha256:' + 'a'.repeat(64),
      requireDigestPin: true,
    })
    const args = pinned.buildContainerArgs('docker', ['node', '-v'], { cwd: dir })
    expect(args).toContain('--network')
    expect(args).toContain('none')
    expect(args).toContain('--read-only')
    expect(args).toContain('--cap-drop=ALL')
    expect(args).toContain('--security-opt=no-new-privileges:true')
    expect(args).toContain('--ipc=none')
    expect(args).toContain('65534:65534')
  })
})
