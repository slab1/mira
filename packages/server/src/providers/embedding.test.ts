import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { embedText, embeddingsUrl } from './embedding.js'

// Provider-routed embeddings — the HTTP layer behind the gateway's embedding
// model. Exercised against a stub server, never a real provider.

let server!: { stop: (closeActiveConnections?: boolean) => void; port: number | undefined }
let BASE!: string
/** Last request the stub saw, for asserting what we actually sent. */
let last: { url: string; method: string; headers: Record<string, string>; body: unknown } | null =
  null
/** Lets a test make the stub answer with an arbitrary payload/status. */
let nextResponse: { status: number; body: unknown } = {
  status: 200,
  body: { data: [{ embedding: [0.1, 0.2, 0.3] }] },
}

beforeEach(() => {
  last = null
  nextResponse = { status: 200, body: { data: [{ embedding: [0.1, 0.2, 0.3] }] } }
})

afterAll(() => {
  try {
    server.stop(true)
  } catch {}
})

function start(): void {
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      last = {
        url: req.url,
        method: req.method,
        headers: Object.fromEntries(req.headers.entries()),
        body: await req.json().catch(() => null),
      }
      return new Response(JSON.stringify(nextResponse.body), { status: nextResponse.status })
    },
  })
  BASE = `http://127.0.0.1:${server.port}`
}

describe('embeddingsUrl', () => {
  test('joins without doubling or dropping slashes', () => {
    expect(embeddingsUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/embeddings')
    expect(embeddingsUrl('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1/embeddings')
    expect(embeddingsUrl('https://api.openai.com/v1///')).toBe(
      'https://api.openai.com/v1/embeddings',
    )
  })
})

describe('embedText', () => {
  test('returns the vector and sends an OpenAI-compatible request', async () => {
    start()
    const vec = await embedText({
      baseURL: BASE,
      apiKey: 'sk-test',
      modelID: 'text-embedding-3-small',
      input: 'hello',
    })
    expect(vec).toEqual([0.1, 0.2, 0.3])
    expect(last!.method).toBe('POST')
    expect(last!.url).toBe(`${BASE}/embeddings`)
    expect(last!.headers.authorization).toBe('Bearer sk-test')
    expect(last!.body).toEqual({ model: 'text-embedding-3-small', input: 'hello' })
  })

  test('passes configured headers through', async () => {
    start()
    await embedText({
      baseURL: BASE,
      apiKey: 'sk-test',
      modelID: 'm',
      input: 'x',
      headers: { 'x-nvidia': 'n' },
    })
    expect(last!.headers['x-nvidia']).toBe('n')
  })

  test('no API key → null without touching the network', async () => {
    start()
    const vec = await embedText({ baseURL: BASE, apiKey: '', modelID: 'm', input: 'x' })
    expect(vec).toBeNull()
    expect(last).toBeNull()
  })

  test('HTTP error → null (never a fabricated vector)', async () => {
    start()
    nextResponse = { status: 429, body: { error: 'rate limited' } }
    const vec = await embedText({ baseURL: BASE, apiKey: 'k', modelID: 'm', input: 'x' })
    expect(vec).toBeNull()
  })

  test('unreachable host → null, not a throw', async () => {
    const vec = await embedText({
      baseURL: 'http://127.0.0.1:1',
      apiKey: 'k',
      modelID: 'm',
      input: 'x',
      timeoutMs: 500,
    })
    expect(vec).toBeNull()
  })

  test('rejects malformed payloads', async () => {
    start()
    for (const body of [
      {},
      { data: [] },
      { data: [{ embedding: [] }] },
      { data: [{ embedding: 'nope' }] },
      { data: [{ embedding: [1, 'x', 3] }] },
      { data: [{ embedding: [1, null] }] },
      { data: [{ embedding: [1, NaN] }] },
    ]) {
      nextResponse = { status: 200, body }
      const vec = await embedText({ baseURL: BASE, apiKey: 'k', modelID: 'm', input: 'x' })
      expect(vec).toBeNull()
    }
  })
})
