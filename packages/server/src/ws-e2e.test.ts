/**
 * End-to-end WebSocket authentication tests against a real server process.
 *
 * The unit tests in `ws-auth.test.ts` / `ws-events.test.ts` cover the extracted
 * decision logic. These cover the *wiring* in index.ts — the Bun.serve upgrade
 * handler, `open`, and `message` — which no unit test can reach.
 *
 * Hermetic: MIRA_DIR points at an empty dir (so `provisionFirstRunToken` cannot
 * override MIRA_TOKEN with ~/.mira/mira.env) and MIRA_DB at a throwaway file.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TOKEN = 'e2e-master-token-9f3c1a'
const PORT = 4287
// The server rejects a null Origin header (anti-curl/websocat hardening), and
// Bun's WebSocket client sends none — so we present an allowed localhost origin.
const ORIGIN = 'http://127.0.0.1:5173'
let proc: ReturnType<typeof Bun.spawn> | undefined
let dir = ''
let base = ''
let logFile = ''

/**
 * Bun's WebSocket constructor accepts `{ headers }` at runtime (this is how the
 * TUI/web clients present their bearer token) but the bundled TS lib types the
 * second parameter as subprotocols only, hence the cast.
 */
function connect(path = '/', token?: string): WebSocket {
  const headers: Record<string, string> = { Origin: ORIGIN }
  if (token) headers.Authorization = `Bearer ${token}`
  return new WebSocket(`ws://127.0.0.1:${PORT}${path}`, { headers } as unknown as string)
}

async function waitForHealth(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/healthz`)
      if (res.status === 200) return
    } catch {}
    await Bun.sleep(300)
  }
  throw new Error('server did not become healthy in time')
}

/** Collect messages until `pred` matches or the deadline passes. */
function collect(
  ws: WebSocket,
  pred: (msg: { type?: string; payload?: unknown }) => boolean,
  timeoutMs = 8000,
): Promise<{ type?: string; payload?: unknown } | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMsg)
      resolve(null)
    }, timeoutMs)
    function onMsg(e: MessageEvent) {
      let parsed: { type?: string; payload?: unknown }
      try {
        parsed = JSON.parse(String(e.data))
      } catch {
        return
      }
      if (!pred(parsed)) return
      clearTimeout(timer)
      ws.removeEventListener('message', onMsg)
      resolve(parsed)
    }
    ws.addEventListener('message', onMsg)
  })
}

function connected(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ws open timeout')), 8000)
    ws.addEventListener('open', () => {
      clearTimeout(t)
      resolve()
    })
    ws.addEventListener('error', () => {
      clearTimeout(t)
      reject(new Error('ws error'))
    })
  })
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mira-ws-e2e-'))
  logFile = join(dir, 'server.log')
  const fd = openSync(logFile, 'w')
  proc = Bun.spawn(['bun', 'src/index.ts'], {
    cwd: new URL('../', import.meta.url).pathname,
    env: {
      ...process.env,
      MIRA_TOKEN: TOKEN,
      MIRA_DIR: join(dir, 'empty-mira-dir'),
      MIRA_DB: join(dir, 'e2e.db'),
      MIRA_NO_AUTOPROVISION: '1',
      HOST: '127.0.0.1',
      PORT: String(PORT),
      MIRA_STRICT_AUTH: '1',
      MIRA_TRUST_PROXY: '0',
      NODE_ENV: 'test',
    },
    stdout: fd,
    stderr: fd,
  })
  base = `http://127.0.0.1:${PORT}`
  await waitForHealth()
}, 90_000)

afterAll(async () => {
  try {
    proc?.kill()
  } catch {}
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('e2e WebSocket: header authentication', () => {
  test('valid bearer token activates the socket (heartbeat received)', async () => {
    const ws = connect('/', TOKEN)
    await connected(ws)
    const hb = await collect(ws, (m) => m.type === 'server.heartbeat')
    expect(hb).not.toBeNull()
    ws.close()
  })

  test('invalid bearer token does NOT activate the socket', async () => {
    const ws = connect('/', 'definitely-not-valid')
    await connected(ws)
    // No activation => no heartbeat. It stays open until the 20s auth timeout,
    // which we do not wait for here.
    const hb = await collect(ws, (m) => m.type === 'server.heartbeat', 2000)
    expect(hb).toBeNull()
    ws.close()
  })

  test('absent Authorization header does NOT activate the socket', async () => {
    const ws = connect()
    await connected(ws)
    const hb = await collect(ws, (m) => m.type === 'server.heartbeat', 2000)
    expect(hb).toBeNull()
    ws.close()
  })
})

describe('e2e WebSocket: in-band auth message', () => {
  test('pending socket activates on a valid {type:"auth"} message', async () => {
    const ws = connect()
    await connected(ws)
    ws.send(JSON.stringify({ type: 'auth', token: TOKEN }))
    const hb = await collect(ws, (m) => m.type === 'server.heartbeat')
    expect(hb).not.toBeNull()
    ws.close()
  })

  test('bad token in an auth message leaves the socket pending', async () => {
    const ws = connect()
    await connected(ws)
    ws.send(JSON.stringify({ type: 'auth', token: 'nope' }))
    const hb = await collect(ws, (m) => m.type === 'server.heartbeat', 2000)
    expect(hb).toBeNull()
    ws.close()
  })

  test('malformed auth payload does not crash or activate', async () => {
    const ws = connect()
    await connected(ws)
    ws.send('not json at all')
    ws.send(JSON.stringify({ type: 'auth', token: 12345 }))
    ws.send(JSON.stringify({ type: 'unrelated' }))
    const hb = await collect(ws, (m) => m.type === 'server.heartbeat', 2000)
    expect(hb).toBeNull()
    ws.close()
  })

  test('a later valid auth message still activates after junk', async () => {
    const ws = connect()
    await connected(ws)
    ws.send('garbage')
    ws.send(JSON.stringify({ type: 'auth', token: 'wrong' }))
    await Bun.sleep(200)
    ws.send(JSON.stringify({ type: 'auth', token: TOKEN }))
    const hb = await collect(ws, (m) => m.type === 'server.heartbeat')
    expect(hb).not.toBeNull()
    ws.close()
  })
})

describe('e2e /metrics access control', () => {
  test('unauthenticated /metrics is 401', async () => {
    const res = await fetch(`${base}/metrics`)
    expect(res.status).toBe(401)
  })

  test('/metrics with a valid token serves Prometheus text', async () => {
    const res = await fetch(`${base}/metrics`, { headers: { Authorization: `Bearer ${TOKEN}` } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/plain')
    const body = await res.text()
    expect(body).toContain('http_requests_total')
    expect(body).toContain('gateway_cost_total')
  })

  test('/healthz stays public for uptime probes', async () => {
    const res = await fetch(`${base}/healthz`)
    expect(res.status).toBe(200)
  })

  test('the issued-API-key load path is not silently failing', async () => {
    // Guards the 0ce8b03 regression where an un-migrated schema made the server
    // boot with an empty credential store while looking healthy.
    const out = await Bun.file(logFile).text()
    expect(out).not.toContain('no such column')
    expect(out).not.toContain('ALL issued API keys will be rejected')
  })

  test('the server booted with auth actually enforced', async () => {
    const out = await Bun.file(logFile).text()
    expect(out).toContain('listening on')
    // A server that silently lost its token would answer /metrics without one.
    const res = await fetch(`${base}/metrics`)
    expect(res.status).toBe(401)
  })
})
