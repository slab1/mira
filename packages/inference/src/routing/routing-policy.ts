import type { InferencePolicy } from '../security/privacy-policy.js'

export const DEFAULT_INFERENCE_POLICY: InferencePolicy = {
  privacy: 'local_only',
  localFirst: true,
  allowCloudFallback: false,
  maxRetries: 2,
  timeoutMs: 120000,
}

export function evaluateRouting(policy: InferencePolicy, localAvailable: boolean): { provider: 'ollama' | 'cloud'; reason: string } {
  if (policy.privacy === 'local_only') {
    return { provider: 'ollama', reason: 'privacy policy mandates local execution (local_only)' }
  }

  if (policy.localFirst && localAvailable) {
    return { provider: 'ollama', reason: 'local runtime available and localFirst enabled' }
  }

  if (policy.allowCloudFallback) {
    return { provider: 'cloud', reason: 'local unavailable or cloud fallback allowed' }
  }

  return { provider: 'ollama', reason: 'default local routing' }
}
