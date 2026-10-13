/**
 * §4 acceptance — execution profiles, enforced limits, no silent host fallback.
 *
 * docs/LONG_TERM_RISK_AND_SCALABILITY_PLAN.md §4:
 *   "Fail closed when the required runtime or isolation capability is
 *    unavailable." and "Keep production secrets, credentials, and host sockets
 *    outside the experiment environment."
 *
 * The previous implementation was a single `enabled` boolean, spawned host
 * fallbacks with inherited process.env, and interpolated cwd straight into a
 * `-v` mount flag with no validation.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ContainerSandbox,
  SandboxError,
  EXECUTION_PROFILES,
  type ExecutionProfile,
} from './isolation.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mira-sandbox-'))
})
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
})

describe('§4.1: execution profiles', () => {
  test('the four required profiles exist with the right strength', () => {
    expect(Object.keys(EXECUTION_PROFILES).sort()).toEqual([
      'isolated-experiment',
      'production',
      'restricted',
      'trusted-local',
    ])
    // only the two local profiles may run without a container
    expect(EXECUTION_PROFILES['trusted-local'].requiresContainer).toBe(false)
    expect(EXECUTION_PROFILES.restricted.requiresContainer).toBe(false)
    expect(EXECUTION_PROFILES['isolated-experiment'].requiresContainer).toBe(true)
    expect(EXECUTION_PROFILES.production.requiresContainer).toBe(true)
  })

  test('MIRA_SANDBOX=1 maps to an isolated experiment, not a bare boolean', () => {
    const prev = process.env.MIRA_SANDBOX
    process.env.MIRA_SANDBOX = '1'
    try {
      const s = new ContainerSandbox()
      expect(s.profile).toBe('isolated-experiment')
      expect(s.status().requiresContainer).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.MIRA_SANDBOX
      else process.env.MIRA_SANDBOX = prev
    }
  })

  test('MIRA_SANDBOX_PROFILE selects the profile', () => {
    const prev = process.env.MIRA_SANDBOX_PROFILE
    process.env.MIRA_SANDBOX_PROFILE = 'production'
    try {
      expect(new ContainerSandbox().profile).toBe('production')
    } finally {
      if (prev === undefined) delete process.env.MIRA_SANDBOX_PROFILE
      else process.env.MIRA_SANDBOX_PROFILE = prev
    }
  })

  test('explicit config wins over env', () => {
    expect(new ContainerSandbox({ profile: 'restricted' as ExecutionProfile }).profile).toBe(
      'restricted',
    )
  })
})

describe('§4.3: fails closed when isolation is unavailable', () => {
  test('an isolated profile with no runtime throws instead of running on the host', async () => {
    const s = new ContainerSandbox({
      profile: 'isolated-experiment',
      runtime: 'definitely-not-a-runtime' as 'docker',
    })
    await expect(s.run(['echo', 'hi'], { cwd: dir })).rejects.toBeInstanceOf(SandboxError)
  })

  test('the error names the profile and refuses the host explicitly', async () => {
    const s = new ContainerSandbox({ profile: 'production', runtime: 'nope' as 'docker' })
    const err = (await s.run(['echo', 'hi'], { cwd: dir }).catch((e) => e)) as Error
    expect(err).toBeInstanceOf(SandboxError)
    expect(err.message).toContain('production')
    expect(err.message).toContain('Refusing to run untrusted work on the host')
  })

  test('allowFallback is the only way to accept host execution', async () => {
    const s = new ContainerSandbox({
      profile: 'isolated-experiment',
      runtime: 'nope' as 'docker',
      allowFallback: true,
    })
    const r = await s.run(['echo', 'fallback'], { cwd: dir })
    // it ran, and it says plainly that it was NOT isolated
    expect(r.isolated).toBe(false)
    expect(r.out).toContain('fallback')
  })
})

describe('§4.5: secrets stay out of the child environment', () => {
  test('the host path does not leak API keys or tokens', async () => {
    const prevKey = process.env.MIRA_TOKEN
    const prevProvider = process.env.OPENAI_API_KEY
    process.env.MIRA_TOKEN = 'super-secret-token'
    process.env.OPENAI_API_KEY = 'sk-should-never-appear'
    try {
      const s = new ContainerSandbox({ profile: 'trusted-local' })
      const r = await s.run(
        [
          'bash',
          '-c',
          'echo "tok=[$MIRA_TOKEN] key=[$OPENAI_API_KEY] path_has_home=[${PATH:+yes}]"',
        ],
        { cwd: dir },
      )
      expect(r.out).not.toContain('super-secret-token')
      expect(r.out).not.toContain('sk-should-never-appear')
      // allowlisted vars still work, so the child is not left broken
      expect(r.out).toContain('path_has_home=[yes]')
    } finally {
      if (prevKey === undefined) delete process.env.MIRA_TOKEN
      else process.env.MIRA_TOKEN = prevKey
      if (prevProvider === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prevProvider
    }
  })

  test('an explicitly allowlisted extra var does pass through', async () => {
    const prev = process.env.MIRA_SANDBOX_TEST_PROXY
    process.env.MIRA_SANDBOX_TEST_PROXY = 'http://proxy.test'
    try {
      const s = new ContainerSandbox({
        profile: 'trusted-local',
        envAllowlist: ['MIRA_SANDBOX_TEST_PROXY'],
      })
      const r = await s.run(['bash', '-c', 'echo "p=$MIRA_SANDBOX_TEST_PROXY"'], { cwd: dir })
      expect(r.out).toContain('http://proxy.test')
    } finally {
      if (prev === undefined) delete process.env.MIRA_SANDBOX_TEST_PROXY
      else process.env.MIRA_SANDBOX_TEST_PROXY = prev
    }
  })
})

describe('§4.1/§4.7: cwd and worktree validation', () => {
  test('a relative cwd is refused', async () => {
    const s = new ContainerSandbox({ profile: 'trusted-local' })
    await expect(s.run(['echo', 'x'], { cwd: 'relative/path' })).rejects.toBeInstanceOf(
      SandboxError,
    )
  })

  test('a cwd that would corrupt a mount spec is refused', async () => {
    const s = new ContainerSandbox({ profile: 'isolated-experiment', runtime: 'nope' as 'docker' })
    for (const bad of ['/tmp/a:/host/etc', '/tmp/a\nb', '']) {
      await expect(s.run(['echo', 'x'], { cwd: bad })).rejects.toBeInstanceOf(SandboxError)
    }
  })

  test('a non-existent cwd is refused before any process starts', async () => {
    const s = new ContainerSandbox({ profile: 'trusted-local' })
    await expect(s.run(['echo', 'x'], { cwd: join(dir, 'nope', 'deeper') })).rejects.toBeInstanceOf(
      SandboxError,
    )
  })

  test('an unsafe worktree path is refused', async () => {
    const s = new ContainerSandbox({ profile: 'isolated-experiment', runtime: 'nope' as 'docker' })
    await expect(
      s.run(['echo', 'x'], { cwd: dir, worktree: '/tmp/a:/etc' }),
    ).rejects.toBeInstanceOf(SandboxError)
  })
})

describe('§4.4: resource limits are declared', () => {
  test('isolated profiles carry memory, cpu and pid ceilings', () => {
    for (const p of ['isolated-experiment', 'production'] as ExecutionProfile[]) {
      const l = EXECUTION_PROFILES[p].limits
      expect(l.memory, p).toBeTruthy()
      expect(l.cpus, p).toBeTruthy()
      expect(l.pids, p).toBeGreaterThan(0)
      expect(l.timeoutMs, p).toBeGreaterThan(0)
    }
  })

  test('status() reports the effective limits and profile', () => {
    const s = new ContainerSandbox({ profile: 'production' })
    const st = s.status()
    expect(st.profile).toBe('production')
    expect(st.requiresContainer).toBe(true)
    expect(st.limits.memory).toBeTruthy()
    expect(st.limits.timeoutMs).toBeGreaterThan(0)
  })

  test('explicit limit overrides are honoured', () => {
    const s = new ContainerSandbox({
      profile: 'production',
      limits: { memory: '8g', timeoutMs: 5000 },
    })
    expect(s.status().limits.memory).toBe('8g')
    expect(s.status().limits.timeoutMs).toBe(5000)
  })

  test('a command exceeding the wall clock is killed', async () => {
    const s = new ContainerSandbox({ profile: 'trusted-local', limits: { timeoutMs: 300 } })
    const start = Date.now()
    const r = await s.run(['bash', '-c', 'sleep 10'], { cwd: dir })
    expect(Date.now() - start).toBeLessThan(5000)
    expect(r.code).not.toBe(0)
  })
})

describe('§4.1: result reports the effective profile', () => {
  test('host execution reports isolated:false and the profile', async () => {
    const s = new ContainerSandbox({ profile: 'trusted-local' })
    const r = await s.run(['bash', '-c', 'echo ok'], { cwd: dir })
    expect(r.isolated).toBe(false)
    expect(r.profile).toBe('trusted-local')
    expect(r.out).toContain('ok')
  })
})
