import type {
  InferenceProvider,
  InferenceRequest,
  InferenceResponse,
} from './provider.interface.js'

async function readResponseText(
  response: Response,
  timeout: Promise<never>,
  onReader: (reader: ReadableStreamDefaultReader<Uint8Array>) => void,
): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  onReader(reader)
  const decoder = new TextDecoder()
  let text = ''
  while (true) {
    const result = await Promise.race([reader.read(), timeout])
    if (result.done) break
    text += decoder.decode(result.value, { stream: true })
  }
  return text + decoder.decode()
}

export class OllamaProvider implements InferenceProvider {
  name = 'ollama'
  baseURL: string
  timeoutMs: number

  constructor(baseURL = 'http://127.0.0.1:11434/v1', timeoutMs = 120000) {
    this.baseURL = baseURL
    this.timeoutMs = timeoutMs
  }

  async isAvailable(): Promise<boolean> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2000)
    let response: Response | undefined
    try {
      response = await fetch(`${this.baseURL.replace(/\/$/, '')}/models`, {
        signal: controller.signal,
      })
      return response.ok
    } catch {
      return false
    } finally {
      clearTimeout(timer)
      if (response?.body && !response.bodyUsed) void response.body.cancel().catch(() => {})
    }
  }

  async generate(request: InferenceRequest): Promise<InferenceResponse> {
    const start = Date.now()
    const controller = new AbortController()
    let response: Response | undefined
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let rejectTimeout!: (error: Error) => void
    const timeout = new Promise<never>((_, reject) => {
      rejectTimeout = reject
    })
    const timer = setTimeout(() => {
      rejectTimeout(new Error(`Ollama request timed out after ${this.timeoutMs}ms`))
      controller.abort()
      if (reader) void reader.cancel().catch(() => {})
      else if (response?.body) void response.body.cancel().catch(() => {})
    }, this.timeoutMs)

    try {
      const messages =
        request.messages ?? (request.prompt ? [{ role: 'user', content: request.prompt }] : [])
      response = await Promise.race([
        fetch(`${this.baseURL.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ollama-local',
          },
          body: JSON.stringify({
            model: request.model.replace(/^ollama\//, ''),
            messages,
            max_tokens: request.maxTokens ?? 512,
            temperature: request.temperature ?? 0.7,
          }),
          signal: controller.signal,
        }),
        timeout,
      ])
      const responseText = await readResponseText(response, timeout, (bodyReader) => {
        reader = bodyReader
      })

      if (!response.ok) {
        throw new Error(`Ollama error (${response.status}): ${responseText}`)
      }

      const data = JSON.parse(responseText) as any
      const text = data.choices?.[0]?.message?.content ?? ''
      const usage = data.usage
        ? {
            promptTokens: data.usage.prompt_tokens ?? 0,
            completionTokens: data.usage.completion_tokens ?? 0,
            totalTokens: data.usage.total_tokens ?? 0,
          }
        : undefined

      return {
        text,
        model: request.model,
        usage,
        latencyMs: Date.now() - start,
        provider: 'ollama',
      }
    } catch (err: any) {
      throw new Error(`Ollama generation failed: ${err.message}`)
    } finally {
      clearTimeout(timer)
      if (reader) {
        try {
          reader.releaseLock()
        } catch {}
      }
    }
  }
}
