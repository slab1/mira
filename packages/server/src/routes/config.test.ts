import { describe, expect, test, afterEach } from 'bun:test'
import { Hono } from 'hono'
import type { MiraConfig } from '../types/index.js'
import { redactConfig, mountConfigRoutes } from './config.js'
import { getConfig, resetConfigCache } from '../config/index.js'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('redactConfig', () => {
  test('redacts every rotated key and secret-bearing provider header', () => {
    const config = {
      provider: {
        test: {
          name: 'Test provider',
          options: {
            baseURL: 'https://api.example.test',
            apiKey: ['first-secret', 'second-secret'],
            headers: {
              Authorization: 'Bearer header-secret',
              'X-API-Key': 'header-api-key',
              'HTTP-Referer': 'https://mira.example.test',
            },
          },
          models: {},
        },
      },
    } as unknown as MiraConfig

    const redacted = redactConfig(config)
    const options = redacted.provider.test!.options

    expect(options.apiKey).toEqual(['***', '***'])
    expect(options.headers).toEqual({
      Authorization: '***',
      'X-API-Key': '***',
      'HTTP-Referer': 'https://mira.example.test',
    })
    expect(JSON.stringify(redacted)).not.toContain('secret')
    expect(JSON.stringify(config)).toContain('first-secret')
  })
})

// P2-7 regression: `google` lists two env fallbacks for apiKey, and the model
// discovery route expanded it as a string — `value.replace is not a function`,
// so GET /config/providers/google/models always 500'd.
describe('provider model discovery with an array apiKey', () => {
  let dir: string
  let server: { stop: (c?: boolean) => void; port: number | undefined }
  let BASE: string
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    resetConfigCache()
    try {
      server.stop(true)
    } catch {}
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })

  test('uses the first configured key instead of throwing', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mira-provmodels-'))
    process.env.MIRA_TEST_GKEY = 'gkey-value'
    writeFileSync(
      join(dir, 'mira.json'),
      JSON.stringify({
        provider: {
          gprov: {
            name: 'G',
            options: {
              baseURL: 'https://g.test/v1',
              apiKey: ['{env:MIRA_TEST_GKEY}', '{env:MIRA_TEST_OTHER_KEY}'],
            },
            models: {},
          },
        },
      }),
    )
    resetConfigCache()
    // sanity: the config really does carry an array
    const raw = getConfig(dir).provider.gprov!.options.apiKey
    expect(Array.isArray(raw)).toBe(true)

    const app = new Hono<{ Variables: { requestId: string } }>()
    mountConfigRoutes(app)
    server = Bun.serve({ port: 0, fetch: app.fetch })
    BASE = `http://127.0.0.1:${server.port}`

    // Only intercept the UPSTREAM call (g.test); let localhost reach the server.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('g.test')) {
        const auth = new Headers(init?.headers).get('authorization')
        expect(auth).toBe('Bearer gkey-value')
        return new Response(JSON.stringify({ data: [{ id: 'text-embedding-004' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return originalFetch(input as RequestInfo, init)
    }) as typeof fetch

    const res = await fetch(`${BASE}/providers/gprov/models?cwd=${encodeURIComponent(dir)}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; models?: Array<{ id: string }> }
    expect(body.ok).toBe(true)
    expect(body.models?.[0]?.id).toContain('text-embedding-004')
    delete process.env.MIRA_TEST_GKEY
  })
})
