import { describe, test, expect } from 'bun:test'
import { DoomLoopDetector } from './doom-loop-detector.js'

describe('DoomLoopDetector', () => {
  test('passes when tool calls vary', () => {
    const d = new DoomLoopDetector()
    expect(d.check({ name: 'read', args: { path: '/a' } }).detected).toBe(false)
    expect(d.check({ name: 'read', args: { path: '/b' } }).detected).toBe(false)
    expect(d.check({ name: 'grep', args: { pattern: 'x' } }).detected).toBe(false)
  })

  test('detects identical call repeated 3x consecutively', () => {
    const d = new DoomLoopDetector()
    d.check({ name: 'bash', args: { command: 'ls' } })
    d.check({ name: 'bash', args: { command: 'ls' } })
    const third = d.check({ name: 'bash', args: { command: 'ls' } })
    expect(third.detected).toBe(true)
    expect(third.reason).toContain('Identical')
  })

  test('does not false-positive on two identical calls', () => {
    const d = new DoomLoopDetector()
    d.check({ name: 'bash', args: { command: 'ls' } })
    expect(d.check({ name: 'bash', args: { command: 'ls' } }).detected).toBe(false)
  })

  test('detects repeating A,B,A,B cycle', () => {
    const d = new DoomLoopDetector()
    d.check({ name: 'read', args: { path: '/a' } })
    d.check({ name: 'edit', args: { path: '/a' } })
    d.check({ name: 'read', args: { path: '/a' } })
    d.check({ name: 'edit', args: { path: '/a' } })
    const fifth = d.check({ name: 'read', args: { path: '/a' } })
    expect(fifth.detected).toBe(true)
    expect(fifth.reason).toContain('Repeating')
  })

  test('reset clears history', () => {
    const d = new DoomLoopDetector()
    d.check({ name: 'bash', args: { command: 'ls' } })
    d.reset()
    expect(d.getStats().historyLength).toBe(0)
    expect(d.check({ name: 'bash', args: { command: 'ls' } }).detected).toBe(false)
  })

  test('handles primitive args without crashing', () => {
    const d = new DoomLoopDetector()
    expect(d.check({ name: 'bash', args: 'string-args' }).detected).toBe(false)
    expect(d.check({ name: 'bash', args: null }).detected).toBe(false)
  })

  test('detects repeated errors', () => {
    const d = new DoomLoopDetector()
    expect(d.checkError('bash', { error: 'E1' }).detected).toBe(false)
    expect(d.checkError('bash', { error: 'E1' }).detected).toBe(false)
    const third = d.checkError('bash', { error: 'E1' })
    expect(third.detected).toBe(true)
    expect(third.reason).toContain('Repeated error')
  })

  test('detects repeated LLM outputs', () => {
    const d = new DoomLoopDetector()
    expect(d.checkLLMOutput('same output').detected).toBe(false)
    expect(d.checkLLMOutput('same output').detected).toBe(false)
    const third = d.checkLLMOutput('same output')
    expect(third.detected).toBe(true)
    expect(third.reason).toContain('Repeated LLM output')
  })

  test('poll_no_progress: same tool+args 3x with SAME resultHash fires', () => {
    const d = new DoomLoopDetector()
    const call = { name: 'bash', args: { command: 'curl /health' }, result: { status: 503 } }
    expect(d.check(call).detected).toBe(false)
    expect(d.check(call).detected).toBe(false)
    const third = d.check(call)
    expect(third.detected).toBe(true)
    expect(third.reason).toBe('poll_no_progress')
    expect(third.tool).toBe('bash')
    expect(third.pattern).toHaveLength(3)
  })

  test('poll does NOT fire mid-sequence (needs pollThreshold=3)', () => {
    const d = new DoomLoopDetector()
    const call = { name: 'bash', args: { command: 'curl /health' }, result: 'same' }
    d.check(call)
    // call 2: poll history only has 2 entries — below default pollThreshold (3)
    expect(d.check(call).detected).toBe(false)
  })

  test('same tool+args 3x with DIFFERENT resultHash → no poll_no_progress', () => {
    const prev = process.env.MIRA_DOOM_THRESHOLD
    process.env.MIRA_DOOM_THRESHOLD = '99' // suppress the generic identical-call check
    try {
      const d = new DoomLoopDetector()
      const args = { command: 'curl /health' }
      expect(d.check({ name: 'bash', args, result: { n: 1 } }).detected).toBe(false)
      expect(d.check({ name: 'bash', args, result: { n: 2 } }).detected).toBe(false)
      const third = d.check({ name: 'bash', args, result: { n: 3 } })
      expect(third.detected).toBe(false) // results differ → progress is being made
    } finally {
      if (prev === undefined) delete process.env.MIRA_DOOM_THRESHOLD
      else process.env.MIRA_DOOM_THRESHOLD = prev
    }
  })

  test('still identical-hash polls are suppressed when hashes merely absent (no result)', () => {
    // poll_no_progress requires firstHash truthy; no result → no poll signal,
    // but the generic identical-call detector still fires (documented behavior).
    const d = new DoomLoopDetector()
    d.check({ name: 'bash', args: { command: 'date' } })
    d.check({ name: 'bash', args: { command: 'date' } })
    const third = d.check({ name: 'bash', args: { command: 'date' } })
    expect(third.detected).toBe(true)
    expect(third.reason).not.toBe('poll_no_progress')
  })

  test('ping_pong: strict A-B-A-B alternation of distinct fingerprints fires', () => {
    const prev = process.env.MIRA_DOOM_PINGPONG_THRESHOLD
    // threshold 3 lets ping_pong fire on the third call, before the generic
    // repeating-sequence detector (which needs history >= 4) can preempt it
    process.env.MIRA_DOOM_PINGPONG_THRESHOLD = '3'
    try {
      const d = new DoomLoopDetector()
      const A = { name: 'read', args: { path: '/a' }, result: 'x' }
      const B = { name: 'read', args: { path: '/b' }, result: 'y' }
      expect(d.check(A).detected).toBe(false)
      expect(d.check(B).detected).toBe(false)
      const third = d.check({ name: 'read', args: { path: '/a' }, result: 'x2' }) // differ hash to dodge poll
      expect(third.detected).toBe(true)
      expect(third.reason).toBe('ping_pong')
    } finally {
      if (prev === undefined) delete process.env.MIRA_DOOM_PINGPONG_THRESHOLD
      else process.env.MIRA_DOOM_PINGPONG_THRESHOLD = prev
    }
  })

  test('MIRA_DOOM_POLL_THRESHOLD env override is respected (threshold=2 fires on 2nd call)', () => {
    const prev = process.env.MIRA_DOOM_POLL_THRESHOLD
    process.env.MIRA_DOOM_POLL_THRESHOLD = '2'
    try {
      const d = new DoomLoopDetector()
      const call = { name: 'bash', args: { command: 'curl /x' }, result: 'unchanged' }
      expect(d.check(call).detected).toBe(false)
      const second = d.check(call)
      expect(second.detected).toBe(true)
      expect(second.reason).toBe('poll_no_progress')
    } finally {
      if (prev === undefined) delete process.env.MIRA_DOOM_POLL_THRESHOLD
      else process.env.MIRA_DOOM_POLL_THRESHOLD = prev
    }
  })

  test('poll_no_progress does not cross-contaminate after reset', () => {
    const d = new DoomLoopDetector()
    const call = { name: 'bash', args: { command: 'curl /h' }, result: 's' }
    d.check(call)
    d.check(call)
    d.reset()
    expect(d.check(call).detected).toBe(false)
    expect(d.check(call).detected).toBe(false) // reset → below threshold again
  })

  test('reset clears error and LLM history', () => {
    const d = new DoomLoopDetector()
    d.checkError('bash', { error: 'E1' })
    d.checkLLMOutput('out')
    d.reset()
    const stats = d.getStats()
    expect(stats.errorHistoryLength).toBe(0)
    expect(stats.llmOutputHistoryLength).toBe(0)
  })
})
