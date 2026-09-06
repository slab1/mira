/**
 * Gateway — Spec-compliant SSE parser
 *
 * Handles:
 * - \r\n and \n line endings (normalize \r\n → \n, strip \r)
 * - Comments (lines starting with ":")
 * - event / data / retry / id fields
 * - Multi-line data (joined with \n)
 * - Blank line = dispatch event
 * - [DONE] sentinel
 */

export interface SSEEvent {
  event?: string
  data: string
  retry?: number
  id?: string
}

export interface SSEParserOptions {
  onEvent: (ev: SSEEvent) => void
  onDone?: () => void
}

/**
 * Create a streaming SSE parser that feeds raw bytes/text and emits events.
 * Usage:
 *   const parser = createSSEParser({ onEvent: ... })
 *   parser.feed(chunk)
 *   parser.flush() // at stream end
 */
export function createSSEParser(opts: SSEParserOptions) {
  let buffer = ''
  let currentEvent: string | undefined
  let currentData: string[] = []
  let currentRetry: number | undefined
  let currentId: string | undefined

  function dispatch() {
    if (
      currentData.length === 0 &&
      currentEvent === undefined &&
      currentRetry === undefined &&
      currentId === undefined
    )
      return
    const data = currentData.join('\n')
    // [DONE] is a data sentinel — signal completion
    if (data === '[DONE]') {
      opts.onDone?.()
      reset()
      return
    }
    // Empty data with no event is a heartbeat/comment — ignore
    if (data === '' && !currentEvent) {
      reset()
      return
    }
    opts.onEvent({
      event: currentEvent,
      data,
      retry: currentRetry,
      id: currentId,
    })
    reset()
  }

  function reset() {
    currentEvent = undefined
    currentData = []
    currentRetry = undefined
    currentId = undefined
  }

  function processLine(line: string) {
    // Comment line — ignore
    if (line.startsWith(':')) return
    // Blank line — dispatch
    if (line === '') {
      dispatch()
      return
    }
    // Parse field
    const colonIdx = line.indexOf(':')
    let field: string
    let value: string
    if (colonIdx === -1) {
      field = line
      value = ''
    } else {
      field = line.slice(0, colonIdx)
      // Per spec: if value starts with space, strip one leading space
      value = line.slice(colonIdx + 1)
      if (value.startsWith(' ')) value = value.slice(1)
    }

    switch (field) {
      case 'event':
        currentEvent = value
        break
      case 'data':
        currentData.push(value)
        break
      case 'retry': {
        const n = Number(value)
        if (Number.isFinite(n)) currentRetry = n
        break
      }
      case 'id':
        currentId = value
        break
      default:
        // Unknown field — ignore per spec
        break
    }
  }

  return {
    feed(chunk: string) {
      // Normalize \r\n → \n and lone \r → \n
      const normalized = chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      buffer += normalized
      // Split on \n, keep incomplete last line in buffer
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) processLine(line)
    },
    flush() {
      if (buffer.length) {
        processLine(buffer)
        buffer = ''
      }
      // Dispatch any pending event at stream end
      if (currentData.length || currentEvent) dispatch()
    },
  }
}

/**
 * Parse a complete SSE text into events (non-streaming helper for tests).
 */
export function parseSSEText(text: string): SSEEvent[] {
  const events: SSEEvent[] = []
  const parser = createSSEParser({
    onEvent: (ev) => events.push(ev),
  })
  parser.feed(text)
  parser.flush()
  return events
}
