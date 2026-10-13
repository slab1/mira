/**
 * Loop Guard (§11) — failure fingerprint dedup, cooldown, attempt caps,
 * human escalation. Prevents Failure→Retry→Failure doom loops.
 */
import { describe, test, expect } from 'bun:test'
import { LoopGuard, failureFingerprint } from './loop-guard.js'

describe('failureFingerprint', () => {
  test('stable across whitespace/case/number noise, sensitive to shape', () => {
    const a = failureFingerprint('Circuit OPEN on lane default (port 8080)', {
      busType: 'server.error',
    })
    const b = failureFingerprint('circuit   open on lane default (port 9999)', {
      busType: 'server.error',
      extra: 1,
    })
    // numbers normalized, but evidence keys differ → distinct
    expect(a).not.toBe(b)
    const c = failureFingerprint('circuit   open on lane default (port 9999)', {
      busType: 'server.error',
    })
    expect(a).toBe(c)
    // raw failure text never leaks into the fingerprint
    expect(a).not.toContain('circuit')
  })
})

describe('LoopGuard — §11 controls', () => {
  const guard = (attempts = 3, cooldownMs = 60_000) =>
    new LoopGuard({ cooldownMs, maxAttempts: attempts })

  test('first occurrence allowed, duplicate inside cooldown blocked', () => {
    const g = guard()
    const d1 = g.check('timeout on lane default', { busType: 'server.error' })
    expect(d1.allowed).toBe(true)
    expect(d1.escalated).toBe(false)

    const d2 = g.check('timeout on lane default', { busType: 'server.error' })
    expect(d2.allowed).toBe(false)
    expect(d2.attempts).toBe(2)
    expect(d2.reason).toContain('cooldown')
    expect(d2.retryInMs).toBeGreaterThan(0)
  })

  test('cooldown expiry allows a new incident', () => {
    const g = guard()
    const t0 = 1_000_000
    expect(g.check('cost cap exceeded', { cost: true }, t0).allowed).toBe(true)
    expect(g.check('cost cap exceeded', { cost: true }, t0 + 1000).allowed).toBe(false)
    // past the cooldown window the old attempt is pruned
    const d3 = g.check('cost cap exceeded', { cost: true }, t0 + 61_000)
    expect(d3.allowed).toBe(true)
    expect(d3.attempts).toBe(1)
  })

  test('attempt cap escalates: blocked + human ack required', () => {
    const g = guard(2)
    const t0 = 2_000_000
    expect(g.check('edit hash anchor failed', undefined, t0).allowed).toBe(true)
    expect(g.check('edit hash anchor failed', undefined, t0 + 100).allowed).toBe(false)
    const d3 = g.check('edit hash anchor failed', undefined, t0 + 200)
    expect(d3.allowed).toBe(false)
    expect(d3.escalated).toBe(true)
    expect(d3.reason).toContain('human ack')
  })

  test('escalation persists inside window until acknowledged', () => {
    const g = guard(1)
    const t0 = 3_000_000
    g.check('rate limit 429', undefined, t0)
    const d2 = g.check('rate limit 429', undefined, t0 + 100)
    expect(d2.escalated).toBe(true)
    // long after cooldown, attempts pruned — escalation also expires
    const d3 = g.check('rate limit 429', undefined, t0 + 61_000)
    expect(d3.escalated).toBe(false)
    expect(d3.allowed).toBe(true)

    // but with an ack inside the window, escalation clears immediately
    const g2 = guard(1)
    g2.check('rate limit 429', undefined, t0)
    g2.check('rate limit 429', undefined, t0 + 100)
    const cleared = g2.acknowledge()
    expect(cleared).toBe(1)
    const d4 = g2.check('rate limit 429', undefined, t0 + 200)
    expect(d4.allowed).toBe(true)
    expect(d4.escalated).toBe(false)
  })

  test('stats() reports tracked and escalated counts', () => {
    const g = guard(1)
    g.check('failure A', undefined)
    g.check('failure A', undefined)
    g.check('failure B', undefined)
    const s = g.stats()
    expect(s.tracked).toBe(2)
    expect(s.escalated).toBe(1)
    expect(s.maxAttempts).toBe(1)
  })
})
