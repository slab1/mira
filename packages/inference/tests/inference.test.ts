import { describe, test, expect } from 'bun:test'
import { ConcurrencyManager } from '../src/resources/concurrency-manager.js'
import { evaluateRouting } from '../src/routing/routing-policy.js'
import { InferenceEngine } from '../src/core/inference-engine.js'
import { validatePrivacyPolicy } from '../src/security/privacy-policy.js'
import { InferenceMetrics } from '../src/telemetry/inference-metrics.js'

describe('ConcurrencyManager', () => {
  test('enforces concurrency limit of 1', () => {
    const cm = new ConcurrencyManager(1)
    expect(cm.canAcquire()).toBe(true)
    expect(cm.acquire()).toBe(true)
    expect(cm.canAcquire()).toBe(false)
    expect(cm.acquire()).toBe(false)
    cm.release()
    expect(cm.canAcquire()).toBe(true)
  })
})

describe('RoutingPolicy', () => {
  test('local_only policy always selects ollama', () => {
    const routing = evaluateRouting({ privacy: 'local_only', localFirst: true, allowCloudFallback: true, maxRetries: 1, timeoutMs: 1000 }, false)
    expect(routing.provider).toBe('ollama')
  })

  test('cloud_allowed selects cloud when local unavailable and fallback allowed', () => {
    const routing = evaluateRouting({ privacy: 'cloud_allowed', localFirst: true, allowCloudFallback: true, maxRetries: 1, timeoutMs: 1000 }, false)
    expect(routing.provider).toBe('cloud')
  })
})

describe('InferenceEngine Cloud Fallback & Retry', () => {
  test('respects local_only privacy policy when local fails', async () => {
    const engine = new InferenceEngine({ privacy: 'local_only', allowCloudFallback: true, maxRetries: 0 })
    let thrown = false
    try {
      await engine.execute({ model: 'qwen2.5', prompt: 'hello' })
    } catch (e: any) {
      thrown = true
      expect(e.message).toContain('Ollama generation failed')
    }
    expect(thrown).toBe(true)
  })
})

describe('InferenceEngine Privacy & Fallback Mock Tests', () => {
  test('validatePrivacyPolicy isolates local_only from cloud providers', () => {
    const policy = { privacy: 'local_only' as const, localFirst: true, allowCloudFallback: true, maxRetries: 1, timeoutMs: 1000 }
    expect(validatePrivacyPolicy(policy, 'ollama')).toBe(true)
    expect(validatePrivacyPolicy(policy, 'cloud-fallback')).toBe(false)
  })

  test('validatePrivacyPolicy permits cloud when cloud_allowed', () => {
    const policy = { privacy: 'cloud_allowed' as const, localFirst: true, allowCloudFallback: true, maxRetries: 1, timeoutMs: 1000 }
    expect(validatePrivacyPolicy(policy, 'cloud-fallback')).toBe(true)
  })
})

describe('InferenceMetrics Bounded Ring Buffer', () => {
  test('respects maxRecords limit', () => {
    const metrics = new InferenceMetrics(5)
    for (let i = 0; i < 10; i++) {
      metrics.record({ model: 'test', provider: 'ollama', latencyMs: 10, success: true })
    }
    const summary = metrics.getSummary()
    expect(summary.total).toBe(5)
  })
})
