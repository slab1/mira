export type InferencePrivacy = 'local_only' | 'cloud_allowed'

export interface InferencePolicy {
  privacy: InferencePrivacy
  localFirst: boolean
  allowCloudFallback: boolean
  maxRetries: number
  timeoutMs: number
}

export function validatePrivacyPolicy(policy: InferencePolicy, targetProvider: string): boolean {
  if (policy.privacy === 'local_only' && targetProvider !== 'ollama') {
    return false
  }
  return true
}
