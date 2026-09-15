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
