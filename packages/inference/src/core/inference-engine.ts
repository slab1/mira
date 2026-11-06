import { OllamaProvider } from '../providers/ollama.provider.js'
import { CloudFallbackProvider } from '../providers/cloud.provider.js'
import type { InferenceRequest, InferenceResponse } from '../providers/provider.interface.js'
import { ConcurrencyManager } from '../resources/concurrency-manager.js'
import { evaluateRouting } from '../routing/routing-policy.js'
import type { InferencePolicy } from '../security/privacy-policy.js'
import { validatePrivacyPolicy } from '../security/privacy-policy.js'
import { InferenceMetrics } from '../telemetry/inference-metrics.js'

export class InferenceEngine {
  private ollama: OllamaProvider
  private cloud: CloudFallbackProvider
  private concurrency: ConcurrencyManager
  private metrics: InferenceMetrics
  private defaultPolicy: InferencePolicy

  constructor(policy?: Partial<InferencePolicy>, ollamaBaseURL?: string, cloudApiKey?: string) {
    this.ollama = new OllamaProvider(ollamaBaseURL, policy?.timeoutMs ?? 120000)
    this.cloud = new CloudFallbackProvider(cloudApiKey, undefined, policy?.timeoutMs ?? 120000)
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

    const provider = routing.provider === 'ollama' ? this.ollama : this.cloud
    const providerName = routing.provider === 'ollama' ? 'ollama' : 'cloud-fallback'

    // If local was routed but fails with retryable error / timeout / unavailable, check cloud fallback if allowed
    if (providerName === 'ollama') {
      if (!this.concurrency.acquire()) {
        throw new Error('Local concurrency limit reached (max 1 local request)')
      }
      try {
        const response = await this.executeWithRetry(this.ollama, request, policy.maxRetries)
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

        // If cloud fallback is permitted and privacy permits, attempt fallback
        if (policy.allowCloudFallback && validatePrivacyPolicy(policy, 'cloud-fallback')) {
          const cloudAvailable = await this.cloud.isAvailable()
          if (cloudAvailable) {
            try {
              const cloudResponse = await this.executeWithRetry(this.cloud, request, policy.maxRetries)
              this.metrics.record({
                model: request.model,
                provider: 'cloud-fallback',
                latencyMs: cloudResponse.latencyMs,
                success: true,
                tokensTotal: cloudResponse.usage?.totalTokens,
              })
              return cloudResponse
            } catch (cloudErr: any) {
              throw new Error(`Local inference failed (${err.message}) and cloud fallback failed (${cloudErr.message})`)
            }
          }
        }
        throw err
      } finally {
        this.concurrency.release()
      }
    } else {
      if (!validatePrivacyPolicy(policy, 'cloud-fallback')) {
        throw new Error('Privacy policy violation: local_only cannot route to cloud provider')
      }
      const response = await this.executeWithRetry(this.cloud, request, policy.maxRetries)
      this.metrics.record({
        model: request.model,
        provider: 'cloud-fallback',
        latencyMs: response.latencyMs,
        success: true,
        tokensTotal: response.usage?.totalTokens,
      })
      return response
    }
  }

  private async executeWithRetry(provider: OllamaProvider | CloudFallbackProvider, request: InferenceRequest, maxRetries: number): Promise<InferenceResponse> {
    let attempts = 0
    let lastError: any = null

    while (attempts <= maxRetries) {
      try {
        return await provider.generate(request)
      } catch (err) {
        lastError = err
        attempts++
        if (attempts > maxRetries) break
        // exponential backoff jitter
        const delay = Math.min(1000 * Math.pow(2, attempts), 10000)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
    throw lastError ?? new Error('Inference retries exhausted')
  }

  getMetrics() {
    return this.metrics.getSummary()
  }
}
