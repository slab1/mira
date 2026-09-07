import { describe, test, expect } from 'bun:test'
import { createSSEParser, parseSSEText } from './sse.js'

describe('parseSSEText', () => {
  test('parses a simple data-only event', () => {
    const events = parseSSEText('data: hello\n\n')
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe('hello')
  })

  test('parses event type', () => {
    const events = parseSSEText('event: message\ndata: hello\n\n')
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('message')
    expect(events[0].data).toBe('hello')
  })

  test('parses id field', () => {
    const events = parseSSEText('id: 42\ndata: hello\n\n')
    expect(events).toHaveLength(1)
    expect(events[0].id).toBe('42')
  })

  test('parses retry field', () => {
    const events = parseSSEText('retry: 5000\ndata: hello\n\n')
    expect(events).toHaveLength(1)
    expect(events[0].retry).toBe(5000)
  })

  test('joins multi-line data', () => {
    const events = parseSSEText('data: line1\ndata: line2\ndata: line3\n\n')
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe('line1\nline2\nline3')
  })

  test('ignores comment lines (starting with colon)', () => {
    const events = parseSSEText(': this is a comment\ndata: hello\n\n')
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe('hello')
  })

  test('[DONE] sentinel triggers onDone, not an event', () => {
    const events = parseSSEText('data: [DONE]\n\n')
    expect(events).toHaveLength(0)
  })

  test('strips leading space from field value (SSE spec)', () => {
    const events = parseSSEText('data: hello\n\n')
    expect(events[0].data).toBe('hello')
  })

  test('emits event with empty data for bare data field (SSE spec)', () => {
    const events = parseSSEText('data:\n\n')
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe('')
  })

  test('parses multiple events', () => {
    const events = parseSSEText('data: first\n\ndata: second\n\n')
    expect(events).toHaveLength(2)
    expect(events[0].data).toBe('first')
    expect(events[1].data).toBe('second')
  })

  test('handles \\r\\n line endings', () => {
    const events = parseSSEText('data: hello\r\n\r\n')
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe('hello')
  })

  test('field with no colon', () => {
    const events = parseSSEText('data\n\n')
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe('')
  })
})

describe('createSSEParser (streaming)', () => {
  test('feeds partial data and dispatches on blank line', () => {
    const events: ReturnType<typeof parseSSEText>[number][] = []
    const parser = createSSEParser({ onEvent: (ev) => events.push(ev) })
    parser.feed('data: hel')
    expect(events).toHaveLength(0)
    parser.feed('lo\n\n')
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe('hello')
  })

  test('flush dispatches pending event without trailing blank line', () => {
    const events: ReturnType<typeof parseSSEText>[number][] = []
    const parser = createSSEParser({ onEvent: (ev) => events.push(ev) })
    parser.feed('data: pending')
    expect(events).toHaveLength(0)
    parser.flush()
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe('pending')
  })

  test('flush does nothing if buffer is empty', () => {
    const events: ReturnType<typeof parseSSEText>[number][] = []
    const parser = createSSEParser({ onEvent: (ev) => events.push(ev) })
    parser.flush()
    expect(events).toHaveLength(0)
  })

  test('onDone is called for [DONE]', () => {
    let done = false
    const events: ReturnType<typeof parseSSEText>[number][] = []
    const parser = createSSEParser({
      onEvent: (ev) => events.push(ev),
      onDone: () => {
        done = true
      },
    })
    parser.feed('data: [DONE]\n\n')
    expect(done).toBe(true)
    expect(events).toHaveLength(0)
  })

  test('handles interleaved fields in one event', () => {
    const events: ReturnType<typeof parseSSEText>[number][] = []
    const parser = createSSEParser({ onEvent: (ev) => events.push(ev) })
    parser.feed('event: ping\nid: 1\ndata: body\n\n')
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('ping')
    expect(events[0].id).toBe('1')
    expect(events[0].data).toBe('body')
  })

  test('ignores unknown fields', () => {
    const events: ReturnType<typeof parseSSEText>[number][] = []
    const parser = createSSEParser({ onEvent: (ev) => events.push(ev) })
    parser.feed('foo: bar\ndata: hello\n\n')
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe('hello')
  })
})
