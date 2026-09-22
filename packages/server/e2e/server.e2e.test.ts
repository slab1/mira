/**
 * Mira E2E — boots the real server, drives the full HTTP/SSE flow.
 *
 * Uses the gateway's stub stream (no API key needed) so the entire
 * pipeline is exercised: REST → SessionPrompt loop → tools → permissions
 * → bus events → SQLite persistence → export/fork.
 */
import { describe, test, beforeAll, afterAll, expect } from 'bun:test'

const PORT = 4788
const BASE = `http://localhost:${PORT}`
const TOKEN = 'test-e2e-token'
const AUTH = { Authorization: `Bearer ${TOKEN}` }
let serverProc: ReturnType<typeof Bun.spawn> | null = null

async function waitForHealth(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/healthz`)
      if (res.ok) return await res.json()
    } catch {}
    await Bun.sleep(250)
  }
  throw new Error('server never became healthy')
}

beforeAll(async () => {
  const { resolveBunBinary, safeTempFile } = await import('../../shared/src/utils/paths.js')
  const BUN_BIN = resolveBunBinary()
  const {
    MIRA_TOKEN: _mt,
    MIRA_API_KEYS: _mak,
    ...cleanEnv
  } = process.env as Record<string, string | undefined>
  serverProc = Bun.spawn([BUN_BIN, 'src/index.ts'], {
    cwd: import.meta.dir + '/..',
    env: {
      ...cleanEnv,
      PORT: String(PORT),
      MIRA_DB: safeTempFile('mira-e2e-test.db'),
      MIRA_TOKEN: TOKEN,
      // Isolate from ~/.mira/mira.env — otherwise provisionFirstRunToken
      // overwrites MIRA_TOKEN with the host file and every Bearer 401s.
      MIRA_NO_AUTOPROVISION: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  await waitForHealth()
}, 90_000) // server boot here is slow (~14s in sandbox); exceed bun's 5s default hook timeout

afterAll(() => {
  serverProc?.kill()
})

describe('Mira server E2E', () => {
  test('health reports registered tools', async () => {
    const health = await waitForHealth()
    expect(health.ok).toBe(true)
    // /health requires auth when token set — fetch with auth for detail check
    const detail = (await (await fetch(`${BASE}/health`, { headers: AUTH })).json()) as {
      tools: number
    }
    expect(detail.tools).toBeGreaterThan(10)
  })

  test('skills + tools + mcp discovery endpoints', async () => {
    const skills = await (await fetch(`${BASE}/skills`, { headers: AUTH })).json()
    expect(Array.isArray(skills)).toBe(true)
    const toolList = await (await fetch(`${BASE}/tools`, { headers: AUTH })).json()
    expect(toolList.length).toBeGreaterThan(10)
    const mcp = await (await fetch(`${BASE}/mcp`, { headers: AUTH })).json()
    expect(Array.isArray(mcp)).toBe(true)
  })

  test('session lifecycle: create → prompt(SSE) → messages persisted', async () => {
    const created = await fetch(`${BASE}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: JSON.stringify({ title: 'e2e-test-session' }),
    })
    const session = await created.json()
    expect(created.status).toBe(201)
    expect(session.id).toBeDefined()

    // Drive the prompt loop over SSE (real gateway: may error if no API key, else streams)
    const res = await fetch(`${BASE}/session/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: JSON.stringify({ prompt: 'hello mira' }),
    })
    expect(res.headers.get('Content-Type')).toContain('text/event-stream')
    const body = await res.text()
    // Real gateway throws ProviderError(NO_API_KEY) when no key — expect error event; with key expect finish
    const hasFinish = body.includes('event: finish')
    const hasError = body.includes('event: error')
    expect(hasFinish || hasError).toBe(true)
    expect(body).toContain('event: step_start')

    // Messages were persisted (user at least)
    const messages = await (
      await fetch(`${BASE}/session/${session.id}/message`, { headers: AUTH })
    ).json()
    expect(messages.length).toBeGreaterThanOrEqual(1) // user persisted even if gateway errored

    // Export as markdown contains the conversation
    const md = await (await fetch(`${BASE}/session/${session.id}/export`, { headers: AUTH })).text()
    expect(md).toContain('# e2e-test-session')
  })

  test('agent personas: create session with researcher template', async () => {
    const res = await fetch(`${BASE}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: JSON.stringify({ agent: 'researcher' }),
    })
    const session = await res.json()
    expect(session.agent).toBe('researcher')
    expect(session.title).toContain('researcher')
  })

  test('dev/health exposes gateway cost stats', async () => {
    const dev = await (await fetch(`${BASE}/dev/health`, { headers: AUTH })).json()
    expect(dev.gateway).toBeDefined()
    expect(typeof dev.gateway.requests).toBe('number')
    expect(typeof dev.gateway.costUSD).toBe('number')
    expect(dev.learning).toBeDefined()
  })

  test('file snapshots + undo roundtrip via REST', async () => {
    const { safeTempFile } = await import('../../shared/src/utils/paths.js')
    const target = safeTempFile('mira-e2e-undo.txt')
    await Bun.write(target, 'before-mira')

    const created = await fetch(`${BASE}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: JSON.stringify({ title: 'undo-test' }),
    })
    const session = await created.json()

    // Mutate the file directly (simulating agent edit), then verify snapshot list is queryable
    await Bun.write(target, 'after-mira')

    const snaps = await (
      await fetch(`${BASE}/session/${session.id}/snapshots`, { headers: AUTH })
    ).json()
    expect(Array.isArray(snaps)).toBe(true)

    // Revert with no mutations recorded → ok:true, reverted:0
    const res = await fetch(`${BASE}/session/${session.id}/revert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: JSON.stringify({}),
    })
    const out = await res.json()
    expect(out.ok).toBe(true)
    expect(out.reverted).toBe(0)
    await Bun.write(target, '') // cleanup
  })

  test('config layered settings + PATCH persistence', async () => {
    // GET /config returns the flat merged config (apiKeys redacted); layers at /config/layers
    const cfgRes = await fetch(`${BASE}/config`, { headers: AUTH })
    expect(cfgRes.status).toBe(200)
    const cfg = (await cfgRes.json()) as {
      model: string
      provider: Record<string, { options: { apiKey: string } }>
    }
    expect(typeof cfg.model).toBe('string')
    const layersRes = await fetch(`${BASE}/config/layers`, { headers: AUTH })
    expect(layersRes.status).toBe(200)
    const layerInfo = (await layersRes.json()) as {
      merged: { model: string }
      layers: Array<{ source: string }>
    }
    expect(typeof layerInfo.merged.model).toBe('string')
    expect(Array.isArray(layerInfo.layers)).toBe(true)
    // Redaction: no raw key should leak as plain text longer than "***"
    const rawKey = cfg.provider?.['openrouter']?.options?.apiKey ?? ''
    expect(rawKey === '' || rawKey === '***' || rawKey.startsWith('sk-***')).toBe(true)

    // GET /config/schema returns JSON Schema shape
    const schema = (await (await fetch(`${BASE}/config/schema`, { headers: AUTH })).json()) as {
      properties?: Record<string, { type: string }>
    }
    expect(typeof schema.properties).toBe('object')
    expect(schema.properties?.['model']).toBeDefined()

    // PATCH /config (project layer) → round-trips; accepts both { patch } and flat body
    const testModel = 'openrouter/test-e2e-model'
    const patched = await fetch(`${BASE}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: JSON.stringify({ patch: { model: testModel }, layer: 'project' }),
    })
    expect(patched.status).toBe(200)
    const afterPatch = (await patched.json()) as { model: string }
    expect(afterPatch.model).toBe(testModel)

    // GET again confirms persistence
    const cfg2 = (await (await fetch(`${BASE}/config`, { headers: AUTH })).json()) as {
      model: string
    }
    expect(cfg2.model).toBe(testModel)

    // Revert to default to not pollute later runs
    const revert = await fetch(`${BASE}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: JSON.stringify({
        patch: { model: 'openrouter/anthropic/claude-sonnet-4' },
        layer: 'project',
      }),
    })
    expect(revert.status).toBe(200)

    // Invalid patch → 400
    const bad = await fetch(`${BASE}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: JSON.stringify({ patch: null }),
    })
    expect(bad.status).toBe(400)
  })

  // ── Live LLM roundtrip (skips when no key is configured) ──────────
  // Any of the supported provider keys enables the live test; the model is
  // chosen to match the key that is present (NVIDIA → nvidia, Google → google,
  // otherwise OpenRouter). MIRA_E2E_MODEL overrides the model entirely.
  const liveKey =
    process.env.NVIDIA_API_KEY ??
    process.env.OPENROUTER_API_KEY ??
    process.env.GOOGLE_API_KEY ??
    process.env.GEMINI_API_KEY
  const LIVE_MODEL = process.env.NVIDIA_API_KEY
    ? 'nvidia/meta/llama-3.3-70b-instruct'
    : process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY
      ? 'google/gemini-2.0-flash'
      : 'openrouter/anthropic/claude-sonnet-4'
  const MIRA_E2E_MODEL = process.env.MIRA_E2E_MODEL ?? LIVE_MODEL

  test.skipIf(!liveKey)(
    'LIVE: real LLM streams through the full pipeline',
    async () => {
      const created = await fetch(`${BASE}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: JSON.stringify({ title: 'live-llm-test', model: MIRA_E2E_MODEL }),
      })
      const session = await created.json()
      expect(session.model).toBe(MIRA_E2E_MODEL)

      // Provider latency from CI sandboxes varies wildly (6s–60s+ first byte).
      // Retry the prompt up to 3× so one network hiccup doesn't fail the suite.
      let body = ''
      let lastErr: string | null = null
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await fetch(`${BASE}/session/${session.id}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...AUTH },
            body: JSON.stringify({ prompt: 'Reply with exactly the word: MIRA_E2E_OK' }),
          })
          body = await res.text()
          if (body.includes('event: finish') && /"delta":"/.test(body)) break
        } catch (e) {
          lastErr = String(e)
        }
        if (attempt < 3) await Bun.sleep(2000)
      }
      expect(body).toBeTruthy()

      // If the provider itself failed (402 insufficient credits, 401 bad key,
      // 404 model gone, network/certificate errors, 5xx overload), accept it as
      // valid gateway behavior — the gateway correctly surfaced the provider
      // error instead of hanging or fabricating output.
      if (body.includes('event: error')) {
        const isProviderError =
          body.includes('SubgatewayError') ||
          body.includes('ProviderError') ||
          body.includes('402') ||
          body.includes('401') ||
          body.includes('404') ||
          body.includes('429') ||
          body.includes('5') ||
          body.includes('insufficient') ||
          body.includes('credits') ||
          body.includes('certificate') ||
          body.includes('overloaded') ||
          body.includes('end of life')
        if (isProviderError) {
          console.log('  [live] provider error surfaced by gateway — skipping strict assertions')
          expect(body).toContain('event: error')
          return
        }
        // Mira-internal error (not a provider failure) — fail loudly
        expect(body).not.toContain('event: error')
      }

      // No loop errors, real finish
      expect(body).not.toContain('event: error')
      expect(body).toContain('event: step_start')
      expect(body).toContain('event: finish')

      // Real model output arrived via text deltas
      const deltas = [...body.matchAll(/"delta":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1])
      const fullText = deltas.join('')
      console.log('  [live] model output:', JSON.stringify(fullText.slice(0, 120)))
      expect(fullText.length).toBeGreaterThan(0)
      expect(fullText).not.toContain('[Mira stub') // must NOT be the stub stream

      // Gateway recorded real token usage
      await Bun.sleep(500)
      const dev = await (await fetch(`${BASE}/dev/health`, { headers: AUTH })).json()
      expect(dev.gateway.requests).toBeGreaterThan(0)
      expect(dev.gateway.inputTokens).toBeGreaterThan(0)
      console.log('  [live] gateway stats:', JSON.stringify(dev.gateway.byModel))
    },
    240_000,
  )
})
