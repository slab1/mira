import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ToolContext } from './registry.js'
import type { ContainerSandbox, SandboxResult } from '../sandbox/isolation.js'
import { SandboxError } from '../sandbox/isolation.js'
import { bashTool, __setSandbox } from './bash.js'

/**
 * The bash tool holds a module-level ContainerSandbox. These tests swap in a
 * fake via the __setSandbox test hook — no docker/podman required, and no
 * dependency on module-load order (index.test.ts imports bash.js via
 * registerAll, so mock.module interception would be racy).
 */

let sandboxEnabled = true
let lastRunArgs: { cmd: string[]; cwd: string } | null = null

const defaultRun = async (cmd: string[], opts: { cwd: string }): Promise<SandboxResult> => {
  lastRunArgs = { cmd, cwd: opts.cwd }
  return { code: 0, out: 'hello from container', isolated: true, runtime: 'docker' }
}
const mockRun = mock(defaultRun)

function fakeSandbox(): ContainerSandbox {
  return {
    run: mockRun,
    status: () => ({ enabled: sandboxEnabled, runtime: 'docker', image: 'node:22-alpine' }),
  } as unknown as ContainerSandbox
}

type BashResult = {
  stdout?: string
  stderr?: string
  exitCode?: number
  isolated?: boolean
  runtime?: string
}

function baseCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { sessionID: 'session-sandbox', messageID: 'msg-1', ...overrides } as ToolContext
}

describe('bash tool — ContainerSandbox wiring', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mira-bash-sandbox-'))
    sandboxEnabled = true
    lastRunArgs = null
    mockRun.mockReset()
    mockRun.mockImplementation(defaultRun)
    __setSandbox(fakeSandbox())
  })

  afterEach(() => {
    // Reset to the real sandbox (MIRA_SANDBOX unset → host execution path)
    __setSandbox(null)
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })

  test('MIRA_SANDBOX enabled: runs command inside the container, mounting session cwd', async () => {
    const res = (await bashTool.execute(
      { command: 'echo hi' },
      baseCtx({ cwd: dir }),
    )) as BashResult
    expect(mockRun).toHaveBeenCalledTimes(1)
    expect(lastRunArgs?.cmd).toEqual(['bash', '-c', 'echo hi'])
    expect(lastRunArgs?.cwd).toBe(dir)
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toBe('hello from container')
    expect(res.isolated).toBe(true)
    expect(res.runtime).toBe('docker')
  })

  test('sandbox disabled: falls back to host execution (sandbox not invoked)', async () => {
    sandboxEnabled = false
    const res = (await bashTool.execute(
      { command: 'echo host-hello' },
      baseCtx({ cwd: dir }),
    )) as BashResult
    expect(mockRun).not.toHaveBeenCalled()
    expect(res.stdout).toContain('host-hello')
    expect(res.exitCode).toBe(0)
  })

  test('SandboxError fails closed: error returned to agent, no host fallback', async () => {
    mockRun.mockImplementation(async () => {
      throw new SandboxError(
        'MIRA_SANDBOX=1 requested but no container runtime (docker/podman) found.',
      )
    })
    const res = (await bashTool.execute(
      { command: 'echo hi' },
      baseCtx({ cwd: dir }),
    )) as BashResult
    expect(res.exitCode).toBe(1)
    expect(res.stdout).toBe('')
    expect(res.stderr).toContain('no container runtime')
  })

  test('dangerous command rejected before reaching the sandbox', async () => {
    const res = (await bashTool.execute(
      { command: 'rm -rf /' },
      baseCtx({ cwd: dir }),
    )) as BashResult
    expect(mockRun).not.toHaveBeenCalled()
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain('Command rejected')
  })
})
