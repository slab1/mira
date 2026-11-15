import { afterEach, describe, expect, mock, test } from 'bun:test'
import { CloudFallbackProvider } from '../src/providers/cloud.provider.js'

const originalFetch = globalThis.fetch
const originalNvidiaKey = process.env.NVIDIA_API_KEY
const originalOpenRouterKey = process.env.OPENROUTER_API_KEY

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalNvidiaKey === undefined) delete process.env.NVIDIA_API_KEY
  else process.env.NVIDIA_API_KEY = originalNvidiaKey
  if (originalOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY
  else process.env.OPENROUTER_API_KEY = originalOpenRouterKey
})

describe('CloudFallbackProvider credential and timeout safety', () => {
  test('does not treat OPENROUTER_API_KEY as a key for the default NVIDIA endpoint', async () => {
    delete process.env.NVIDIA_API_KEY
    process.env.OPENROUTER_API_KEY = 'openrouter-secret'
    const provider = new CloudFallbackProvider()

    expect(await provider.isAvailable()).toBe(false)
    await expect(provider.generate({ model: 'nvidia/llama', prompt: 'hello' })).rejects.toThrow(
      'No API key configured for the selected endpoint',
    )
  })

  test('uses OPENROUTER_API_KEY only for an OpenRouter endpoint', async () => {
    delete process.env.NVIDIA_API_KEY
    process.env.OPENROUTER_API_KEY = 'openrouter-secret'
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://openrouter.ai/api/v1/chat/completions')
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer openrouter-secret')
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        headers: { 'Content-Type': 'application/json' },
      })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new CloudFallbackProvider(undefined, 'https://openrouter.ai/api/v1', 1000)
    const result = await provider.generate({ model: 'openrouter/test-model', prompt: 'hello' })
    expect(result.text).toBe('ok')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('times out and cancels a response body that stalls after headers', async () => {
    process.env.NVIDIA_API_KEY = 'nvidia-secret'
    let canceled = false
    globalThis.fetch = mock(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start() {},
            cancel() {
              canceled = true
            },
          }),
        ),
    ) as unknown as typeof fetch

    const provider = new CloudFallbackProvider(undefined, undefined, 20)
    await expect(
      provider.generate({ model: 'nvidia/test-model', prompt: 'hello' }),
    ).rejects.toThrow('timed out after 20ms')
    expect(canceled).toBe(true)
  })
})
