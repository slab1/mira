/**
 * §3 regression detection integrity — a metric the classifier cannot name can
 * never regress, so the classifier is a safety surface.
 *
 * Regression lock for a defect found by execution: `classifyAxis` matched
 * /quality|pass|eval|score/, so `successRate` — the primary quality metric used
 * by evaluator.ts, shadow/comparison.ts and the longitudinal baseline — was
 * unclassified and therefore never compared. A candidate halving its success
 * rate passed regression detection cleanly, and the strict "quality must not
 * regress at all" tolerance was dead code for the most obvious quality metric.
 */
import { describe, test, expect } from 'bun:test'
import { RegressionDetector, classifyAxis } from './regression.js'

const pt = (value: number) => ({ value, unit: 'raw' })
const baseline = {
  successRate: pt(0.9),
  p95Ms: pt(100),
  costUsd: pt(0.2),
  heapMb: pt(50),
}
const d = new RegressionDetector()

describe('classifyAxis — quality metrics must be visible', () => {
  test('the metrics this system actually emits are classified', () => {
    for (const m of [
      'successRate',
      'success_rate',
      'accuracy',
      'taskSuccess',
      'toolSuccess',
      'editSuccess',
      'passRate',
      'evalScore',
      'quality',
      'taskCompletion',
      'completionRate',
      'resolutionRate',
      'winRate',
    ]) {
      expect(classifyAxis(m), `${m} must be classified as quality`).toBe('quality')
    }
    // error/failure rates are quality metrics that improve by FALLING, so they
    // get their own axis rather than being compared with the wrong direction.
    for (const m of [
      'errorRate',
      'error_rate',
      'failureRate',
      'regressionRate',
      'securityViolations',
    ]) {
      expect(classifyAxis(m), `${m} must be classified as inverseQuality`).toBe('inverseQuality')
    }
  })

  test('latency/cost/memory metrics keep their axis', () => {
    for (const m of ['p50', 'p95Ms', 'latencyMs', 'duration', 'ttft']) {
      expect(classifyAxis(m), m).toBe('latency')
    }
    for (const m of ['costUsd', 'tokensIn', 'price']) {
      expect(classifyAxis(m), m).toBe('cost')
    }
    for (const m of ['heapUsed', 'rssMb', 'memoryEntries']) {
      expect(classifyAxis(m), m).toBe('memory')
    }
  })

  test('sample metadata is excluded — count is evidence, not a quantity', () => {
    expect(classifyAxis('count')).toBeNull()
    expect(classifyAxis('samples')).toBeNull()
  })
})

describe('regression detection actually fires', () => {
  test('halving the success rate FAILS (was silently passing)', () => {
    const r = d.detect({ baseline, candidate: { successRate: pt(0.45) } })
    expect(r.passed).toBe(false)
    expect(r.findings.some((f) => f.metric === 'successRate')).toBe(true)
  })

  test('a small quality drop FAILS — quality tolerance is zero', () => {
    const r = d.detect({ baseline, candidate: { successRate: pt(0.89) } })
    expect(r.passed).toBe(false)
  })

  test('error rate rising FAILS', () => {
    const base = { errorRate: pt(0.01) }
    expect(d.detect({ baseline: base, candidate: { errorRate: pt(0.05) } }).passed).toBe(false)
    expect(d.detect({ baseline: base, candidate: { errorRate: pt(0.005) } }).passed).toBe(true)
  })

  test('direction is respected: improvements pass on every axis', () => {
    expect(d.detect({ baseline, candidate: { successRate: pt(0.95) } }).passed).toBe(true)
    expect(d.detect({ baseline, candidate: { p95Ms: pt(50) } }).passed).toBe(true)
    expect(d.detect({ baseline, candidate: { costUsd: pt(0.1) } }).passed).toBe(true)
  })

  test('regressions on every axis still fail', () => {
    expect(d.detect({ baseline, candidate: { p95Ms: pt(200) } }).passed).toBe(false)
    expect(d.detect({ baseline, candidate: { costUsd: pt(0.3) } }).passed).toBe(false)
    expect(d.detect({ baseline, candidate: { heapMb: pt(120) } }).passed).toBe(false)
  })
})
