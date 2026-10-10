import { describe, test, expect } from 'bun:test'
import {
  checkSelfModificationGate,
  gateByConfidence,
  DEFAULT_CONFIDENCE_THRESHOLD,
} from './modification-gate.js'

describe('checkSelfModificationGate — unified fail-closed policy', () => {
  test('allows when confidence, validation, and rollback all pass', () => {
    const r = checkSelfModificationGate({
      confidence: 0.85,
      validationPassed: true,
      rollbackAvailable: true,
    })
    expect(r.allowed).toBe(true)
    expect(r.reasons).toEqual([])
    expect(r.checks).toEqual({ confidence: true, validation: true, rollback: true })
  })

  test('denies when confidence is below threshold', () => {
    const r = checkSelfModificationGate({
      confidence: 0.45,
      validationPassed: true,
      rollbackAvailable: true,
    })
    expect(r.allowed).toBe(false)
    expect(r.checks.confidence).toBe(false)
    expect(r.reasons.some((s) => s.includes('confidence'))).toBe(true)
  })

  test('denies when validation failed', () => {
    const r = checkSelfModificationGate({
      confidence: 0.9,
      validationPassed: false,
      rollbackAvailable: true,
    })
    expect(r.allowed).toBe(false)
    expect(r.checks.validation).toBe(false)
    expect(r.reasons.some((s) => s.includes('validation'))).toBe(true)
  })

  test('denies when no rollback point', () => {
    const r = checkSelfModificationGate({
      confidence: 0.9,
      validationPassed: true,
      rollbackAvailable: false,
    })
    expect(r.allowed).toBe(false)
    expect(r.checks.rollback).toBe(false)
    expect(r.reasons.some((s) => s.includes('rollback'))).toBe(true)
  })

  test('denies on multiple failures with all reasons listed', () => {
    const r = checkSelfModificationGate({
      confidence: 0.2,
      validationPassed: false,
      rollbackAvailable: false,
    })
    expect(r.allowed).toBe(false)
    expect(r.reasons.length).toBe(3)
  })

  test('fails closed on invalid confidence (NaN / undefined)', () => {
    expect(
      checkSelfModificationGate({
        confidence: Number.NaN,
        validationPassed: true,
        rollbackAvailable: true,
      }).allowed,
    ).toBe(false)
    expect(
      checkSelfModificationGate({
        confidence: undefined as unknown as number,
        validationPassed: true,
        rollbackAvailable: true,
      }).allowed,
    ).toBe(false)
  })

  test('respects custom threshold', () => {
    expect(
      checkSelfModificationGate(
        { confidence: 0.6, validationPassed: true, rollbackAvailable: true },
        0.5,
      ).allowed,
    ).toBe(true)
    expect(
      checkSelfModificationGate(
        { confidence: 0.6, validationPassed: true, rollbackAvailable: true },
        0.7,
      ).allowed,
    ).toBe(false)
  })

  test('exposes threshold and confidence in result', () => {
    const r = checkSelfModificationGate(
      { confidence: 0.75, validationPassed: true, rollbackAvailable: true },
      0.8,
    )
    expect(r.confidence).toBe(0.75)
    expect(r.threshold).toBe(0.8)
    expect(r.allowed).toBe(false)
  })
})

describe('gateByConfidence — early arm', () => {
  test('passes at or above default threshold', () => {
    expect(gateByConfidence(DEFAULT_CONFIDENCE_THRESHOLD).passed).toBe(true)
    expect(gateByConfidence(0.9).passed).toBe(true)
  })

  test('fails below default threshold', () => {
    const r = gateByConfidence(0.45)
    expect(r.passed).toBe(false)
    expect(r.reason).toContain('threshold')
  })

  test('fails closed on invalid input', () => {
    expect(gateByConfidence(Number.NaN).passed).toBe(false)
    expect(gateByConfidence(Infinity).passed).toBe(false)
  })
})
