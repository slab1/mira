export interface InferenceRequest {
  model: string
  prompt?: string
  messages?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
  maxTokens?: number
  temperature?: number
}

export interface InferenceResponse {
  text: string
  model: string
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  latencyMs: number
  provider: string
}

export interface InferenceProvider {
  name: string
  isAvailable(): Promise<boolean>
  generate(request: InferenceRequest): Promise<InferenceResponse>
}
