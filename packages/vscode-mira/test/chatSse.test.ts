import { describe, expect, test } from 'bun:test'
import { parseChatSseFrame } from '../src/chatSse'

describe('Mira chat SSE frames', () => {
  test('reads delta from the actual text_delta event/data shape', () => {
    expect(parseChatSseFrame('event: text_delta\ndata: {"delta":"hello Mira"}')).toEqual({
      type: 'delta',
      text: 'hello Mira',
    })
  })

  test('supports CRLF and multiple data lines', () => {
    expect(
      parseChatSseFrame('event: text_delta\r\ndata: {\r\ndata: "delta":"hello"\r\ndata: }\r\n'),
    ).toEqual({ type: 'delta', text: 'hello' })
  })
})
