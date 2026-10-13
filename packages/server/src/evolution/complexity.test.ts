/**
 * Complexity Tracker (§20) — complexity as an engineering metric with
 * weighted score + risk bands + trend. Read-only providers, pure module.
 */
import { describe, test, expect } from 'bun:test'
import { ComplexityTracker } from './complexity.js'

describe('ComplexityTracker — §20 metrics', () => {
  test('providers feed the weighted score; missing providers report 0', () => {
    const t = new ComplexityTracker({ warnScore: 10, riskScore: 20 })
    t.registerProvider('engines', () => 9)
    t.registerProvider('tools', () => 22)
    const snap = t.snapshot()
    expect(snap.metrics.engines).toBe(9)
    expect(snap.metrics.tools).toBe(22)
    expect(snap.metrics.dependencies).toBe(0) // no provider
    // 9*1 + 22*0.5 = 20
    expect(snap.score).toBe(20)
    expect(snap.risk).toBe('high')
  })

  test('risk bands: low / warn / high', () => {
    const t = new ComplexityTracker({ warnScore: 10, riskScore: 20 })
    t.registerProvider('engines', () => 5)
    expect(t.snapshot().risk).toBe('low')
    t.registerProvider('engines', () => 15)
    expect(t.snapshot().risk).toBe('warn')
    t.registerProvider('engines', () => 25)
    expect(t.snapshot().risk).toBe('high')
  })

  test('provider errors are flagged, never thrown', () => {
    const t = new ComplexityTracker()
    t.registerProvider('engines', () => {
      throw new Error('registry exploded')
    })
    t.registerProvider('tools', () => 3)
    const snap = t.snapshot()
    expect(snap.metrics.engines).toBe(0)
    expect(snap.providerErrors[0]).toContain('registry exploded')
    expect(snap.metrics.tools).toBe(3)
  })

  test('trend computes score + metric deltas across the window', () => {
    const t = new ComplexityTracker()
    let engines = 9
    t.registerProvider('engines', () => engines)
    t.snapshot()
    engines = 12
    t.snapshot()
    const trend = t.trend()
    expect(trend).not.toBeNull()
    expect(trend!.scoreDelta).toBe(3)
    expect(trend!.metricsDelta.engines).toBe(3)
  })

  test('history is bounded and newest-first', () => {
    const t = new ComplexityTracker({ maxHistory: 3 })
    for (let i = 0; i < 5; i++) {
      t.registerProvider('tools', () => i)
      t.snapshot()
    }
    const h = t.history(10)
    expect(h.length).toBe(3)
    expect(h[0].metrics.tools).toBe(4)
    expect(h[2].metrics.tools).toBe(2)
  })
})
