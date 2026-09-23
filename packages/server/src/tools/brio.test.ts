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
    return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
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
      const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
      if (u.includes('127.0.0.1:8000')) return realFetch(u.replace('127.0.0.1:8000', `127.0.0.1:${PORT}`), init)
      return realFetch(input as RequestInfo, init)
    }) as typeof fetch

    const r = (await brioTool.execute(
      { state: 'PR 340 lines, 8 files, no tests. CI green.', question: 'What should reviewer do?', options: ['merge', 'request changes', 'close'] },
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
    // No mock on 8000 — should return ok:false with hint
    const r = (await brioTool.execute(
      { state: 'Ticket', question: 'Q?', options: ['yes', 'no'] },
      { sessionID: 's', messageID: 'm' },
    )) as Record<string, unknown>
    expect(r.ok).toBe(false)
    expect(String((r as Record<string, unknown>).hint ?? '')).toContain('colibri')
  })
})
