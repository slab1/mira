import type {
  InferenceProvider,
  InferenceRequest,
  InferenceResponse,
} from './provider.interface.js'

function envKeyForEndpoint(baseURL: string): string | undefined {
  try {
    const hostname = new URL(baseURL).hostname.toLowerCase()
    if (hostname === 'integrate.api.nvidia.com' || hostname.endsWith('.nvidia.com')) {
      return process.env.NVIDIA_API_KEY || undefined
    }
    if (hostname === 'openrouter.ai' || hostname.endsWith('.openrouter.ai')) {
      return process.env.OPENROUTER_API_KEY || undefined
    }
  } catch {
    // Invalid/custom endpoints may still be used with an explicitly supplied key;
    // do not guess which environment credential belongs to them.
  }
  return undefined
}

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

export class CloudFallbackProvider implements InferenceProvider {
  name = 'cloud-fallback'
  private apiKey: string
  private baseURL: string
  private timeoutMs: number

  constructor(
    apiKey?: string,
    baseURL = 'https://integrate.api.nvidia.com/v1',
    timeoutMs = 120000,
  ) {
    this.baseURL = baseURL
    // An explicit key is treated as deliberately paired with this endpoint.
    // Environment credentials are endpoint-specific; in particular, OpenRouter
    // credentials are never used for NVIDIA's API.
    this.apiKey = apiKey ?? envKeyForEndpoint(baseURL) ?? ''
    this.timeoutMs = timeoutMs
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.apiKey)
  }

  async generate(request: InferenceRequest): Promise<InferenceResponse> {
    if (!this.apiKey) {
      throw new Error('Cloud fallback unavailable: No API key configured for the selected endpoint')
    }

    const start = Date.now()
    const controller = new AbortController()
    let response: Response | undefined
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let rejectTimeout!: (error: Error) => void
    const timeout = new Promise<never>((_, reject) => {
      rejectTimeout = reject
    })
    const timer = setTimeout(() => {
      rejectTimeout(new Error(`Provider request timed out after ${this.timeoutMs}ms`))
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
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: request.model.replace(/^(nvidia|openrouter|cloud)\//, ''),
            messages,
            max_tokens: request.maxTokens ?? 1024,
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
        throw new Error(`Cloud fallback error (${response.status}): ${responseText}`)
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
        provider: 'cloud-fallback',
      }
    } catch (err: any) {
      throw new Error(`Cloud fallback generation failed: ${err.message}`)
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
