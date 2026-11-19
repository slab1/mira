import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { brioTool } from './brio.js'

let server: ReturnType<typeof Bun.serve> | null = null
const PORT = 18080
const BASE = `http://127.0.0.1:${PORT}`

function mockBrioHandler(req: Request): Response {
  const url = new URL(req.url)
  if (req.method === 'POST' && url.pathname === '/v1/brio') {
    return new Response(
      JSON.stringify({
        object: 'brio.choice',
        answer: 'request changes',
        entropy: 0.12,
        normalize: 'mean',
        choices: [
          { option: 'request changes', p: 0.97, logprob: -0.02, mean_logprob: -0.02, tokens: 2 },
          { option: 'merge', p: 0.02, logprob: -4.0, mean_logprob: -4.0, tokens: 1 },
          { option: 'close', p: 0.01, logprob: -5.8, mean_logprob: -5.8, tokens: 1 },
        ],
        usage: { prompt_tokens: 88, completion_tokens: 0, read_tokens: 2, total_tokens: 90 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }
  if (url.pathname === '/v1/models') {
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return new Response('not found', { status: 404 })
}

describe('brio tool (colibri)', () => {
  beforeAll(() => {
    server = Bun.serve({ port: PORT, fetch: mockBrioHandler })
  })
  afterAll(() => {
    server?.stop(true)
  })

  test('single question: state + options → ok + entropy', async () => {
    const orig = process.env.COLI_API_KEY
    process.env.COLI_API_KEY = 'local'
    // Point brio at mock by overriding base via env — provider config default is http://127.0.0.1:8000/v1
    // We temporarily patch fetch to hit mock port: set COLI_API_BASE via provider override is not exposed,
    // so we monkey the global fetch for this test to redirect 8000 → mock.
    const realFetch = globalThis.fetch
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const u =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url
      if (u.includes('127.0.0.1:8000'))
        return realFetch(u.replace('127.0.0.1:8000', `127.0.0.1:${PORT}`), init)
      return realFetch(input as RequestInfo, init)
    }) as typeof fetch

    const r = (await brioTool.execute(
      {
        state: 'PR 340 lines, 8 files, no tests. CI green.',
        question: 'What should reviewer do?',
        options: ['merge', 'request changes', 'close'],
      },
      { sessionID: 's', messageID: 'm' },
    )) as Record<string, unknown>

    globalThis.fetch = realFetch
    if (orig === undefined) delete process.env.COLI_API_KEY
    else process.env.COLI_API_KEY = orig

    expect(r.ok).toBe(true)
    const result = r.result as Record<string, unknown>
    expect(result.answer).toBe('request changes')
    expect(typeof result.entropy).toBe('number')
    expect((result as Record<string, unknown>).entropy_reading).toBeDefined()
  })

  test('offline hint when colibri not running', async () => {
    // With cloud fallback disabled and no colibri, should return ok:false with hint
    process.env.BRIO_DISABLE_CLOUD_FALLBACK = '1'
    try {
      const r = (await brioTool.execute(
        { state: 'Ticket', question: 'Q?', options: ['yes', 'no'] },
        { sessionID: 's', messageID: 'm' },
      )) as Record<string, unknown>
      expect(r.ok).toBe(false)
      expect(String((r as Record<string, unknown>).hint ?? '').toLowerCase()).toContain('colibri')
    } finally {
      delete process.env.BRIO_DISABLE_CLOUD_FALLBACK
    }
  })

  test('cloud scoring fallback parses options and computes entropy', async () => {
    const origNv = process.env.NVIDIA_API_KEY
    process.env.NVIDIA_API_KEY = 'test-nv-key'
    const realFetch = globalThis.fetch
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/v1/brio')) {
        return Promise.reject(new Error('Connection refused'))
      }
      if (url.includes('chat/completions')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      answer: 'merge',
                      probabilities: { merge: 0.85, 'request changes': 0.15 },
                    }),
                  },
                },
              ],
              usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        )
      }
      return realFetch(input as RequestInfo, init)
    }) as typeof fetch

    try {
      const r = (await brioTool.execute(
        {
          state: 'PR 42 is tested and clean',
          question: 'Decision?',
          options: ['merge', 'request changes'],
        },
        { sessionID: 's', messageID: 'm' },
      )) as Record<string, unknown>

      expect(r.ok).toBe(true)
      const res = r.result as Record<string, unknown>
      expect(res.answer).toBe('merge')
      expect(typeof res.entropy).toBe('number')
      expect((res as Record<string, unknown>).entropy_reading).toBeDefined()
      expect(Array.isArray(res.choices)).toBe(true)
      expect((res.choices as Array<{ option: string }>)[0].option).toBe('merge')
    } finally {
      globalThis.fetch = realFetch
      if (origNv === undefined) {
        delete process.env.NVIDIA_API_KEY
      } else {
        process.env.NVIDIA_API_KEY = origNv
      }
    }
  })
})
