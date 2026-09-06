/**
 * LSP Transport — Content-Length framing + id→promise correlation
 * Extracted from client.ts:176-242 for reuse across LSP clients.
 * Implements JSON-RPC 2.0 over stdio with bidirectional framing.
 */

import type { JsonValue } from '../types/index.js'

export class LSPError extends Error {
  code?: number
  constructor(message: string, code?: number) {
    super(message)
    this.name = 'LSPError'
    this.code = code
  }
}

export interface PendingRequest {
  resolve: (v: JsonValue) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Encode a JSON-RPC message with Content-Length framing (LSP spec).
 */
export function encodeMessage(msg: object): string {
  const body = JSON.stringify(msg)
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
}

/**
 * Try to extract complete Content-Length framed messages from a buffer.
 * Returns { messages, remaining } where messages are parsed bodies.
 */
export function extractMessages(buf: string): { messages: string[]; remaining: string } {
  const messages: string[] = []
  let remaining = buf
  while (true) {
    const headerEnd = remaining.indexOf('\r\n\r\n')
    if (headerEnd === -1) break
    const header = remaining.slice(0, headerEnd)
    const m = header.match(/Content-Length:\s*(\d+)/i)
    if (!m) {
      // Malformed header — drop it to avoid stalling forever
      remaining = remaining.slice(headerEnd + 4)
      continue
    }
    const len = parseInt(m[1], 10)
    const bodyStart = headerEnd + 4
    if (remaining.length < bodyStart + len) break // wait for more bytes
    const body = remaining.slice(bodyStart, bodyStart + len)
    remaining = remaining.slice(bodyStart + len)
    messages.push(body)
  }
  return { messages, remaining }
}

/**
 * FramedTransport — handles Content-Length framing and id→promise map.
 * Used by LSPClient for stdio communication.
 */
export class FramedTransport {
  private buf = ''
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private decoder = new TextDecoder()

  constructor(
    private readonly serverName: string,
    private readonly onMessage: (body: string) => void,
    private readonly onExit: (err: Error) => void,
  ) {}

  get pendingCount(): number {
    return this.pending.size
  }

  nextRequestId(): number {
    return this.nextId++
  }

  trackRequest(id: number, pending: PendingRequest): void {
    this.pending.set(id, pending)
  }

  hasPending(id: number): boolean {
    return this.pending.has(id)
  }

  resolvePending(id: number, result: JsonValue): void {
    const p = this.pending.get(id)
    if (p) {
      clearTimeout(p.timer)
      this.pending.delete(id)
      p.resolve(result)
    }
  }

  rejectPending(id: number, err: Error): void {
    const p = this.pending.get(id)
    if (p) {
      clearTimeout(p.timer)
      this.pending.delete(id)
      p.reject(err)
    }
  }

  rejectAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  /**
   * Feed raw bytes from stdout into the framing parser.
   * Extracts all complete messages and dispatches via onMessage.
   */
  feed(chunk: Uint8Array): void {
    this.buf += this.decoder.decode(chunk, { stream: true })
    const { messages, remaining } = extractMessages(this.buf)
    this.buf = remaining
    for (const body of messages) {
      this.onMessage(body)
    }
  }

  /**
   * Create a timeout-guarded promise for a request.
   * Returns { promise, id } where promise rejects on timeout.
   */
  createRequest<T = JsonValue>(
    method: string,
    timeoutMs: number,
  ): { id: number; promise: Promise<T> } {
    const id = this.nextRequestId()
    const timer = setTimeout(() => {
      const p = this.pending.get(id)
      if (p) {
        this.pending.delete(id)
        p.reject(new LSPError(`LSP ${method} timed out after ${timeoutMs}ms (${this.serverName})`))
      }
    }, timeoutMs)

    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      })
    })

    return { id, promise }
  }

  /**
   * Async read loop for a ReadableStream<Uint8Array> (Bun stdout).
   * Feeds chunks into the framer until stream ends.
   */
  async readLoop(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        this.feed(value)
      }
    } catch {
      // stream ended (server died)
    }
    this.rejectAllPending(new LSPError(`LSP server exited: ${this.serverName}`))
    this.onExit(new LSPError(`LSP server exited: ${this.serverName}`))
  }
}
