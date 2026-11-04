import type { InferenceProvider, InferenceRequest, InferenceResponse } from './provider.interface.js'

export class CloudFallbackProvider implements InferenceProvider {
  name = 'cloud-fallback'
  private apiKey: string
  private baseURL: string
  private timeoutMs: number

  constructor(apiKey?: string, baseURL = 'https://integrate.api.nvidia.com/v1', timeoutMs = 120000) {
    this.apiKey = apiKey || process.env.NVIDIA_API_KEY || process.env.OPENROUTER_API_KEY || ''
    this.baseURL = baseURL
    this.timeoutMs = timeoutMs
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.apiKey)
  }

  async generate(request: InferenceRequest): Promise<InferenceResponse> {
    if (!this.apiKey) {
      throw new Error('Cloud fallback unavailable: No API key configured (NVIDIA_API_KEY or OPENROUTER_API_KEY)')
    }

    const start = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const messages = request.messages ?? (request.prompt ? [{ role: 'user', content: request.prompt }] : [])
      const res = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: request.model.replace(/^(nvidia|openrouter|cloud)\//, ''),
          messages,
          max_tokens: request.maxTokens ?? 1024,
          temperature: request.temperature ?? 0.7,
        }),
        signal: controller.signal,
      })

      clearTimeout(timer)

      if (!res.ok) {
        const errText = await res.text()
        throw new Error(`Cloud fallback error (${res.status}): ${errText}`)
      }

      const data = (await res.json()) as any
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
      clearTimeout(timer)
      throw new Error(`Cloud fallback generation failed: ${err.message}`)
    }
  }
}
