import { afterEach, describe, expect, mock, test } from 'bun:test'
import { OllamaProvider } from '../src/providers/ollama.provider.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('OllamaProvider response deadlines', () => {
  test('parses successful responses before the deadline', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'local answer' } }] }), {
          headers: { 'Content-Type': 'application/json' },
        }),
    ) as unknown as typeof fetch

    const result = await new OllamaProvider('http://127.0.0.1:11434/v1', 1000).generate({
      model: 'ollama/test-model',
      prompt: 'hello',
    })
    expect(result.text).toBe('local answer')
    expect(result.provider).toBe('ollama')
  })

  test('times out and cancels a response body that stalls after headers', async () => {
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

    const provider = new OllamaProvider('http://127.0.0.1:11434/v1', 25)
    await expect(
      provider.generate({ model: 'ollama/test-model', prompt: 'hello' }),
    ).rejects.toThrow('timed out after 25ms')
    expect(canceled).toBe(true)
  })
})
