/**
 * Mira CLI smoke tests — offline-safe subprocess checks.
 *
 * Runs `bun src/cli.ts` with trivial args only (--version/--help/unknown).
 * Anything needing a server (session/agent/…) is covered by server E2E tests.
 */
import { describe, test, expect } from 'bun:test'

const CLI = `${import.meta.dir}/cli.ts`
const BUN = process.execPath

async function runCli(...args: string[]): Promise<{ code: number; out: string }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    MIRA_API_URL: 'http://127.0.0.1:1', // unroutable: no scan
  }
  delete env.MIRA_TOKEN // login test must see "no token"
  const proc = Bun.spawn([BUN, CLI, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out: `${out}${err}` }
}

// Bun cold-start + CLI import can take 6–8s under load (measured ~7s isolated,
// 5.8s under bun test). Default 5000ms kills the child (exit 143) before it
// finishes printing — raise the per-test ceiling for all spawn checks.
const CLI_TIMEOUT = 20_000

describe('mira CLI basics', () => {
  test('--version prints version', async () => {
    const r = await runCli('--version')
    expect(r.code).toBe(0)
    expect(r.out).toContain('mira 0.1.0')
  }, CLI_TIMEOUT)

  test('--help documents finding resolve + login/logout', async () => {
    const r = await runCli('--help')
    expect(r.code).toBe(0)
    expect(r.out).toContain('finding resolve <id>')
    expect(r.out).toContain('login --token')
    expect(r.out).toContain('logout')
    expect(r.out).toContain('[--daemon]')
  }, CLI_TIMEOUT)

  test('unknown command exits 1', async () => {
    const r = await runCli('frobnicate')
    expect(r.code).toBe(1)
    expect(r.out).toContain('unknown command')
  }, CLI_TIMEOUT)

  test('finding resolve without id exits 1 (no server needed)', async () => {
    const r = await runCli('finding', 'resolve')
    expect(r.code).toBe(1)
    expect(r.out).toContain('requires <id>')
  }, CLI_TIMEOUT)

  test('login without token exits 1 (no server needed)', async () => {
    const r = await runCli('login')
    expect(r.code).toBe(1)
    expect(r.out).toContain('requires a token')
  }, CLI_TIMEOUT)
})
