import type { InferenceProvider, InferenceRequest, InferenceResponse } from './provider.interface.js'

export class OllamaProvider implements InferenceProvider {
  name = 'ollama'
  baseURL: string
  timeoutMs: number

  constructor(baseURL = 'http://127.0.0.1:11434/v1', timeoutMs = 120000) {
    this.baseURL = baseURL
    this.timeoutMs = timeoutMs
  }

  async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 2000)
      const res = await fetch(`${this.baseURL}/models`, {
        signal: controller.signal,
      })
      clearTimeout(timer)
      return res.ok
    } catch {
      return false
    }
  }

  async generate(request: InferenceRequest): Promise<InferenceResponse> {
    const start = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const messages = request.messages ?? (request.prompt ? [{ role: 'user', content: request.prompt }] : [])
      const res = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ollama-local',
        },
        body: JSON.stringify({
          model: request.model.replace(/^ollama\//, ''),
          messages,
          max_tokens: request.maxTokens ?? 512,
          temperature: request.temperature ?? 0.7,
        }),
        signal: controller.signal,
      })

      clearTimeout(timer)

      if (!res.ok) {
        const errText = await res.text()
        throw new Error(`Ollama error (${res.status}): ${errText}`)
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
        provider: 'ollama',
      }
    } catch (err: any) {
      clearTimeout(timer)
      throw new Error(`Ollama generation failed: ${err.message}`)
    }
  }
}
