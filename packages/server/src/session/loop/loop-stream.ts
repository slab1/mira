import type { JsonValue } from '../types/index.js'

export class LoopStream {
  private readonly encoder = new TextEncoder()
  private streamClosed = false
  private heartbeat?: ReturnType<typeof setInterval>
  private writer: WritableStreamDefaultWriter<Uint8Array>
  public readonly readable: ReadableStream<Uint8Array>

  constructor() {
    const { readable, writable } = new TransformStream()
    this.readable = readable
    this.writer = writable.getWriter()
    this.startHeartbeat()
  }

  private startHeartbeat(): void {
    const HEARTBEAT_MS = 20_000
    this.heartbeat = setInterval(() => {
      if (this.streamClosed) return
      if ((this.writer.desiredSize ?? Infinity) <= 0) return
      this.writer.write(this.encoder.encode(': ping\n\n')).catch(() => {
        this.streamClosed = true
        this.clearHeartbeat()
      })
    }, HEARTBEAT_MS)
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = undefined
    }
  }

  send(event: string, data: JsonValue): void {
    const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    if ((this.writer.desiredSize ?? Infinity) <= 0) {
      return
    }
    this.writer.write(this.encoder.encode(line)).catch(() => {
      this.streamClosed = true
    })
  }

  markClosed(): void {
    if (this.streamClosed) return
    this.streamClosed = true
    this.clearHeartbeat()
  }

  async close(): Promise<void> {
    this.markClosed()
    try {
      await this.writer.close()
    } catch {
      // ignore close errors
    }
  }

  get writerHandle(): WritableStreamDefaultWriter<Uint8Array> {
    return this.writer
  }

  getResponse(): Response {
    return new Response(this.readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    })
  }
}
