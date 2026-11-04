import { OllamaProvider } from '../providers/ollama.provider.js'
import type { InferenceRequest, InferenceResponse, InferenceProvider } from '../providers/provider.interface.js'
import { ConcurrencyManager } from '../resources/concurrency-manager.js'
import { evaluateRouting } from '../routing/routing-policy.js'
import type { InferencePolicy } from '../security/privacy-policy.js'
import { InferenceMetrics } from '../telemetry/inference-metrics.js'

export class InferenceEngine {
  private ollama: OllamaProvider
  private concurrency: ConcurrencyManager
  private metrics: InferenceMetrics
  private defaultPolicy: InferencePolicy

  constructor(policy?: Partial<InferencePolicy>, ollamaBaseURL?: string) {
    this.ollama = new OllamaProvider(ollamaBaseURL)
    this.concurrency = new ConcurrencyManager(1)
    this.metrics = new InferenceMetrics()
    this.defaultPolicy = {
      privacy: policy?.privacy ?? 'local_only',
      localFirst: policy?.localFirst ?? true,
      allowCloudFallback: policy?.allowCloudFallback ?? false,
      maxRetries: policy?.maxRetries ?? 2,
      timeoutMs: policy?.timeoutMs ?? 120000,
    }
  }

  async execute(request: InferenceRequest, overridePolicy?: Partial<InferencePolicy>): Promise<InferenceResponse> {
    const policy: InferencePolicy = { ...this.defaultPolicy, ...overridePolicy }
    const localAvailable = await this.ollama.isAvailable()
    const routing = evaluateRouting(policy, localAvailable)

    if (routing.provider === 'ollama') {
      if (!this.concurrency.acquire()) {
        throw new Error('Local concurrency limit reached (max 1 local request)')
      }
      try {
        const response = await this.ollama.generate(request)
        this.metrics.record({
          model: request.model,
          provider: 'ollama',
          latencyMs: response.latencyMs,
          success: true,
          tokensTotal: response.usage?.totalTokens,
        })
        return response
      } catch (err: any) {
        this.metrics.record({
          model: request.model,
          provider: 'ollama',
          latencyMs: 0,
          success: false,
        })
        throw err
      } finally {
        this.concurrency.release()
      }
    } else {
      if (policy.privacy === 'local_only') {
        throw new Error('Privacy policy violation: local_only cannot fallback to cloud')
      }
      throw new Error('Cloud fallback provider not configured in this inference engine instance')
    }
  }

  getMetrics() {
    return this.metrics.getSummary()
  }
}
