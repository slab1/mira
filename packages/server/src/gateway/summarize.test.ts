import { describe, test, expect, mock } from 'bun:test'
import { extractiveFallback } from './summarize.js'
import type { GatewayMessage } from './types.js'

describe('extractiveFallback', () => {
  test('extracts first user message as Original task', () => {
    const messages: GatewayMessage[] = [
      { role: 'system', content: 'You are Mira' },
      { role: 'user', content: 'Fix the build errors in auth.ts' },
      { role: 'assistant', content: 'I found the issue and fixed it.' },
    ]
    const result = extractiveFallback(messages)
    expect(result).toContain('Original task: Fix the build errors in auth.ts')
  })

  test('extracts last assistant message as Last state', () => {
    const messages: GatewayMessage[] = [
      { role: 'user', content: 'Fix it' },
      { role: 'assistant', content: 'All tests passing now.' },
    ]
    const result = extractiveFallback(messages)
    expect(result).toContain('Last state: All tests passing now.')
  })

  test('counts tool calls', () => {
    const messages: GatewayMessage[] = [
      { role: 'user', content: 'Do stuff', toolCalls: [{ id: '1', name: 'edit' }] },
      { role: 'assistant', content: 'Done' },
    ]
    const result = extractiveFallback(messages)
    expect(result).toContain('Tool calls in this span: 1')
  })

  test('includes message count', () => {
    const messages: GatewayMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ]
    const result = extractiveFallback(messages)
    expect(result).toContain('3 messages condensed')
  })

  test('handles empty messages array', () => {
    const result = extractiveFallback([])
    expect(result).toContain('0 messages condensed')
  })

  test('handles messages with no user message', () => {
    const messages: GatewayMessage[] = [{ role: 'assistant', content: 'Only assistant' }]
    const result = extractiveFallback(messages)
    expect(result).toContain('1 messages condensed')
    expect(result).not.toContain('Original task')
  })

  test('truncates long user content at 300 chars', () => {
    const longContent = 'x'.repeat(300) + 'Z'.repeat(200)
    const messages: GatewayMessage[] = [{ role: 'user', content: longContent }]
    const result = extractiveFallback(messages)
    expect(result).toContain(longContent.slice(0, 300))
    expect(result).not.toContain('Z')
  })

  test('truncates long assistant content at 300 chars', () => {
    const longContent = 'y'.repeat(500)
    const messages: GatewayMessage[] = [
      { role: 'user', content: 'fix it' },
      { role: 'assistant', content: longContent },
    ]
    const result = extractiveFallback(messages)
    expect(result).toContain(longContent.slice(0, 300))
  })

  test('skips assistant messages with empty content', () => {
    const messages: GatewayMessage[] = [
      { role: 'user', content: 'fix it' },
      { role: 'assistant', content: '' },
      { role: 'assistant', content: 'real state' },
    ]
    const result = extractiveFallback(messages)
    expect(result).toContain('Last state: real state')
  })
})
