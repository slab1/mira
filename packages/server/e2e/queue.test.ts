/** E2E: queue-while-streaming — messages queue during a turn, drain as chained turns */
import { describe, test, beforeAll, afterAll, expect } from 'bun:test'

const PORT = 4790
const BASE = `http://localhost:${PORT}`
const TOKEN = "test-queue-token"
const AUTH = { Authorization: `Bearer ${TOKEN}` }
let serverProc: ReturnType<typeof Bun.spawn> | null = null

beforeAll(async () => {
  const { resolveBunBinary, safeTempFile } = await import("../../shared/src/utils/paths.js")
  const BUN_BIN = resolveBunBinary()
  const { MIRA_TOKEN: _mt, MIRA_API_KEYS: _mak, ...cleanEnv } = process.env as Record<string, string | undefined>
  serverProc = Bun.spawn([BUN_BIN, 'src/index.ts'], {
    cwd: import.meta.dir + '/..',
    env: { ...cleanEnv, PORT: String(PORT), MIRA_DB: safeTempFile('mira-e2e-queue.db'), MIRA_TOKEN: TOKEN },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break
    } catch {}
    await Bun.sleep(250)
  }
}, 30_000) // server boot here is slow (~9s); exceed bun's 5s default hook timeout
afterAll(() => serverProc?.kill())

describe('message queue', () => {
  test('queue → list → clear roundtrip + chained turn drains', async () => {
    const session = await (
      await fetch(`${BASE}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: JSON.stringify({ title: 'queue-test' }),
      })
    ).json()

    // Queue two while idle (valid — they run on next/chain turns)
    const q1 = await (
      await fetch(`${BASE}/session/${session.id}/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: JSON.stringify({ prompt: 'first queued' }),
      })
    ).json()
    expect(q1.position).toBe(1)
    await fetch(`${BASE}/session/${session.id}/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: JSON.stringify({ prompt: 'second queued' }),
    })
    expect(await (await fetch(`${BASE}/session/${session.id}/queue`, { headers: AUTH })).json()).toEqual([
      'first queued',
      'second queued',
    ])

    // Start a real turn — with real gateway may error if no key, else drains queue
    const promptRes = await fetch(`${BASE}/session/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: JSON.stringify({ prompt: 'kickoff' }),
    })
    const promptBody = await promptRes.text()
    const promptHadError = promptBody.includes('event: error')

    // Allow chained turn to start (if gateway succeeded)
    await Bun.sleep(1500)
    const remaining = (await (
      await fetch(`${BASE}/session/${session.id}/queue`, { headers: AUTH })
    ).json()) as string[]
    if (promptHadError) {
      // Real gateway without key: no drain, queue intact
      expect(remaining).toEqual(['first queued', 'second queued'])
    } else {
      expect(remaining).toEqual(['second queued'])
    }

    // Clear rest
    const cleared = await (
      await fetch(`${BASE}/session/${session.id}/queue`, { method: 'DELETE', headers: AUTH })
    ).json()
    expect(cleared.cleared).toBe(promptHadError ? 2 : 1)

    // If drained, chained turn persisted its own user+assistant messages
    if (!promptHadError) {
      const msgs = (await (await fetch(`${BASE}/session/${session.id}/message`, { headers: AUTH })).json()) as Array<{
        role?: string
        parts?: Array<{ type?: string; text?: string }>
      }>
      const userTexts = msgs
        .filter((m) => m.role === 'user')
        .flatMap((m) => (m.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text))
      expect(userTexts).toContain('first queued')
    }
  })
})
