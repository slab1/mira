import type { JsonValue } from "../types/index.js"
/**
 * Mira MCP HTTP Client — JSON-RPC 2.0 over HTTP, supporting both transports
 *
 * Implements the MCP HTTP specs without SDK deps, mirroring the hand-rolled
 * stdio client (stdio-client.ts):
 *   initialize → notifications/initialized → tools/list → tools/call
 *
 * Two transports are supported, negotiated automatically on connect:
 *
 *  1. Streamable HTTP (2025-06-18 — current spec)
 *     - POST {url} with `Accept: application/json, text/event-stream`
 *     - Response is EITHER a single JSON-RPC document OR an SSE stream whose
 *       `message` events carry JSON-RPC in their `data:` line.
 *     - Server assigns a session id via the `Mcp-Session-Id` HTTP header on
 *       the initialize response; the client MUST echo it on every subsequent
 *       request.
 *
 *  2. Legacy HTTP+SSE (2024-11-05 — deprecated transport, still widely deployed)
 *     - The endpoint URL is the SSE *listen* endpoint: client GETs it with
 *       `Accept: text/event-stream` to open a persistent stream that receives
 *       JSON-RPC messages/notifications AND responses to requests.
 *     - The server emits an `endpoint` SSE event whose `data` is the separate
 *       `/message` POST URL.
 *     - Client POSTs every request (initialize, tools/list, tools/call) to
 *       `/message`; the POST returns 202 Accepted with no body, and the actual
 *       JSON-RPC response arrives later on the GET stream, matched by id.
 *
 * A client that supports both tries the modern transport first and falls back
 * to legacy when the server reject the modern initialize with an HTTP error
 * (the MCP spec's backwards-compatibility guidance: "attempting to initialize
 * via the new transport and falling back to the legacy SSE stream if the
 * initial request fails with specific HTTP error codes").
 */

export interface MCPToolDef {
  name: string
  description?: string
  inputSchema?: Record<string, JsonValue>
}

export interface McpHttpOptions {
  url: string
  headers?: Record<string, string>
  /** Per-request abort signal (e.g. wired to cancelJob) */
  signal?: AbortSignal
  requestTimeoutMs?: number
}

interface Pending {
  resolve: (v: JsonValue) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type TransportMode = "streamable" | "legacy-sse"

export class McpHttpClient {
  public serverInfo: Record<string, JsonValue> = {}
  public capabilities: Record<string, JsonValue> = {}
  public name: string
  /** Which HTTP transport was negotiated (useful for diagnostics/UI). */
  public readonly transport: TransportMode
  private sessionId?: string
  private messageEndpoint?: string // set in legacy mode (the /message POST url)
  private readonly url: string
  private readonly headers: Record<string, string>
  private closed = false
  private nextId = 1
  private pending = new Map<number, Pending>()
  private sseReader?: ReadableStreamDefaultReader<Uint8Array>
  private sseBuf = ""
  private messageEndpointResolve!: (url: string) => void
  private messageEndpointReady: Promise<string> = new Promise((res) => { this.messageEndpointResolve = res })

  private constructor(name: string, opts: McpHttpOptions, transport: TransportMode) {
    this.name = name
    this.url = opts.url
    this.headers = opts.headers ?? {}
    this.transport = transport
  }

  static async connect(name: string, opts: McpHttpOptions): Promise<McpHttpClient> {
    // 1) Try the modern Streamable HTTP transport first (POST single endpoint).
    const streamable = new McpHttpClient(name, opts, "streamable")
    try {
      await streamable.handshakeStreamable()
      return streamable
    } catch {
      await streamable.shutdown()
      // 2) Fall back to the legacy HTTP+SSE transport (2024-11-05).
      const legacy = new McpHttpClient(name, opts, "legacy-sse")
      await legacy.handshakeLegacy(opts.signal)
      return legacy
    }
  }

  // ── Modern Streamable HTTP ───────────────────────────────────────────

  /** Real Streamable HTTP handshake: initialize → capture session id → initialized */
  private async handshakeStreamable(): Promise<void> {
    const result = await this.request<Record<string, JsonValue>>("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mira", version: "0.1.0" },
    }, undefined, new Set(["json"]))
    if (result?.serverInfo) this.serverInfo = result.serverInfo as Record<string, JsonValue>
    if (result?.capabilities) this.capabilities = result.capabilities as Record<string, JsonValue>
    // notifications/initialized — no response body expected; tolerate 204/empty
    await this.send(
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      { expectBody: false },
    ).catch(() => {}) // best-effort; some servers drop notifications without reply
  }

  // ── Legacy HTTP+SSE (2024-11-05) ─────────────────────────────────────

  /**
   * Legacy handshake:
   *   1. GET {url} with `Accept: text/event-stream` → opens the persistent
   *      listen stream. Responses to requests (incl. initialize) arrive here.
   *   2. Read the first data chunks: the server emits an `endpoint` event
   *      carrying the /message POST url, and may already stream the
   *      `initialize` response.
   *   3. POST initialize to /message (202 accepted; response arrives on stream).
   *   4. Once serverInfo is known, send notifications/initialized.
   */
  private async handshakeLegacy(signal?: AbortSignal): Promise<void> {
    // Open the persistent GET stream first so we can receive the initialize
    // response after we POST it to /message.
    await this.openSseStream(signal)

    const initP = this.requestLegacy<Record<string, JsonValue>>("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mira", version: "0.1.0" },
    }, 20_000, signal)
    // notifications/initialized is best-effort; send right after the stream is up.
    await this.postMessage({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }).catch(() => {})

    const result = await initP
    if (result?.serverInfo) this.serverInfo = result.serverInfo as Record<string, JsonValue>
    if (result?.capabilities) this.capabilities = result.capabilities as Record<string, JsonValue>
    if (!this.messageEndpoint) {
      throw new Error(`MCP legacy-SSE server ${this.name} sent no endpoint event`)
    }
  }

  /** GET the URL and keep reading the SSE stream, dispatching by request id. */
  private async openSseStream(signal?: AbortSignal): Promise<void> {
    const controller = new AbortController()
    const onOuterAbort = () => controller.abort()
    if (signal) {
      if (signal.aborted) throw new Error(`MCP request aborted: ${this.name}`)
      signal.addEventListener("abort", onOuterAbort, { once: true })
    }
    try {
      const res = await fetch(this.url, {
        method: "GET",
        headers: { Accept: "text/event-stream", ...this.headers },
        signal: controller.signal,
      })
      if (!res.ok || !res.body) {
        throw new Error(`Legacy SSE listen failed (HTTP ${res.status}) from MCP server ${this.name}`)
      }
      this.sseReader = res.body.getReader()
      void this.sseReadLoop()
    } finally {
      if (signal) signal.removeEventListener("abort", onOuterAbort)
    }
  }

  /** Consume the persistent GET stream: accumulate SSE frames, dispatch messages. */
  private async sseReadLoop(): Promise<void> {
    const decoder = new TextDecoder()
    try {
      while (!this.closed && this.sseReader) {
        const { done, value } = await this.sseReader.read()
        if (done) break
        this.sseBuf += decoder.decode(value, { stream: true })
        this.drainSseBuffer()
      }
    } catch {
      // stream closed/aborted — reject everything pending
    }
    if (!this.closed) this.closed = true
    const err = new Error(`MCP SSE stream closed: ${this.name}`)
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  /** Parse fully-buffered SSE frames out of sseBuf and dispatch each message event. */
  private drainSseBuffer(): void {
    let idx: number
    // SSE frames are separated by a blank line (\n\n)
    while ((idx = this.sseBuf.indexOf("\n\n")) !== -1) {
      const frame = this.sseBuf.slice(0, idx)
      this.sseBuf = this.sseBuf.slice(idx + 2)
      this.handleSseFrame(frame)
    }
  }

  private handleSseFrame(frame: string): void {
    let event = ""
    const dataLines: string[] = []
    for (const rawLine of frame.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (line.startsWith("event:")) { event = line.slice(6).trim(); continue }
      if (line.startsWith("data:")) { dataLines.push(line.slice(5).trimStart()); continue }
      // `id:`, `retry:`, `:` comment, and blank lines are ignored for dispatch.
    }
    if (dataLines.length === 0) return
    const data = dataLines.join("\n")
    if (event === "endpoint") {
      // The /message POST url for this session.
      this.messageEndpoint = data
      this.messageEndpointResolve(data)
      return
    }
    if (event !== "message") return
    let msg: Record<string, JsonValue | undefined>
    try { msg = JSON.parse(data) } catch { return }
    const id = msg.id
    if (typeof id !== "number") return // notification — not request-correlated
    const p = this.pending.get(id)
    if (!p) return
    clearTimeout(p.timer)
    this.pending.delete(id)
    const errObj = msg.error as { code?: JsonValue; message?: JsonValue } | undefined
    if (errObj) p.reject(new Error(`MCP error ${String(errObj.code)}: ${String(errObj.message)}`))
    else p.resolve(msg.result ?? (null as JsonValue))
  }

  /** POST a JSON-RPC request to /message; the response arrives on the GET stream. */
  private requestLegacy<T = Record<string, JsonValue>>(
    method: string,
    params: JsonValue,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`MCP server closed: ${this.name}`))
    const id = this.nextId++
    const timer = setTimeout(() => {
      const p = this.pending.get(id)
      if (p) {
        this.pending.delete(id)
        p.reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms (${this.name})`))
      }
    }, timeoutMs)
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, timer })
      this.postMessage({ jsonrpc: "2.0", id, method, params }, signal).catch((e) => {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(e as Error)
      })
    })
  }

  private async postMessage(body: object, signal?: AbortSignal): Promise<void> {
    // The /message endpoint is delivered asynchronously via the `endpoint`
    // SSE event on the GET stream. Wait for it before POSTing.
    const endpoint = await this.messageEndpointReady
    const controller = new AbortController()
    const onOuterAbort = () => controller.abort()
    if (signal) signal.addEventListener("abort", onOuterAbort, { once: true })
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...this.headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(`HTTP ${res.status} from MCP server ${this.name}: ${text.slice(0, 300)}`)
      }
      // 202 Accepted with empty body is expected; the response is delivered on
      // the GET stream, so we intentionally do NOT read/publish the body here.
    } finally {
      if (signal) signal.removeEventListener("abort", onOuterAbort)
    }
  }

  // ── Shared surface (transport-agnostic) ─────────────────────────────

  get alive(): boolean {
    return !this.closed
  }

  async listTools(timeoutMs = 20_000): Promise<MCPToolDef[]> {
    const r = this.transport === "legacy-sse"
      ? await this.requestLegacy<Record<string, JsonValue>>("tools/list", {}, timeoutMs)
      : await this.request<Record<string, JsonValue>>("tools/list", {}, timeoutMs)
    return this.mapTools(r)
  }

  async callTool(
    name: string,
    args: Record<string, JsonValue>,
    timeoutMs = 60_000,
    signal?: AbortSignal,
  ): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }> {
    return this.transport === "legacy-sse"
      ? await this.requestLegacy("tools/call", { name, arguments: args }, timeoutMs, signal)
      : await this.request("tools/call", { name, arguments: args }, timeoutMs, undefined, signal)
  }

  async shutdown(): Promise<void> {
    this.closed = true
    if (this.sseReader) {
      try { await this.sseReader.cancel() } catch {}
      this.sseReader = undefined
    }
    const err = new Error(`MCP server closed: ${this.name}`)
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  /** Expose the same `handle` shape as the stdio client (here: no process) */
  get handle(): null {
    return null
  }

  private mapTools(r: Record<string, JsonValue>): MCPToolDef[] {
    const tools = r?.tools
    if (!Array.isArray(tools)) return []
    return (tools as Array<Record<string, JsonValue>>).map(t => ({
      name: String(t.name ?? ""),
      description: typeof t.description === "string" ? t.description : undefined,
      inputSchema: t.inputSchema as Record<string, JsonValue> | undefined,
    })).filter(t => t.name.length > 0)
  }

  // ── Streamable HTTP protocol (POST single endpoint) ─────────────────

  request<T = Record<string, JsonValue>>(
    method: string,
    params: JsonValue,
    timeoutMs = 30_000,
    modes: Set<string> | undefined = undefined,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`MCP server closed: ${this.name}`))
    const id = Date.now() + Math.floor(Math.random() * 1_000_000)
    return this.send({ jsonrpc: "2.0", id, method, params }, { timeoutMs, modes, signal })
      .then(async (body) => {
        // Parse the (single-JSON or first-SSE) response message
        const msg = await this.parseResponse(body)
        const errObj = msg.error as { code?: JsonValue; message?: JsonValue } | undefined
        if (errObj) throw new Error(`MCP error ${String(errObj.code)}: ${String(errObj.message)}`)
        return msg.result as T
      })
  }

  /**
   * POST a JSON-RPC message and return the raw HTTP response body.
   *
   * `modes`: when "json" is present, the response is expected to be a single
   * JSON document ("application/json"). Otherwise it is an SSE stream.
   */
  private async send(
    message: object,
    opts: { timeoutMs?: number; modes?: Set<string>; signal?: AbortSignal; expectBody?: boolean } = {},
  ): Promise<string> {
    const timeoutMs = opts.timeoutMs ?? 30_000
    const modes = opts.modes ?? new Set(["json", "sse"])

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onOuterAbort = () => controller.abort()
    if (opts.signal) {
      if (opts.signal.aborted) {
        clearTimeout(timer)
        throw new Error(`MCP request aborted: ${this.name}`)
      }
      opts.signal.addEventListener("abort", onOuterAbort, { once: true })
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...this.headers,
    }
    // Echo the session id assigned during initialize on every request.
    // The initialize request itself is excluded from session (fresh session).
    const isInitialize = (message as { method?: string }).method === "initialize"
    if (this.sessionId && !isInitialize) headers["Mcp-Session-Id"] = this.sessionId
    // The handshake request sets no Mcp-Session-Id, so nothing to clear here.

    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: controller.signal,
      })

      // Capture session id from the initialize response header.
      if (isInitialize) {
        const sid = res.headers.get("mcp-session-id")
        if (sid) this.sessionId = sid
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(`HTTP ${res.status} from MCP server ${this.name}: ${text.slice(0, 300)}`)
      }

      // Notifications get no response body (204 or empty). Consumers that pass
      // expectBody work for plain requests too — we just return whatever.
      const body = await res.text()
      if (opts.expectBody === false && !body.trim()) return body
      void modes
      return body
    } finally {
      clearTimeout(timer)
      if (opts.signal) opts.signal.removeEventListener("abort", onOuterAbort)
    }
  }

  /**
   * Parse an HTTP response body into the first JSON-RPC message.
   * Handles both single-document JSON bodies and SSE streams where the
   * `message` event's `data:` holds the JSON-RPC payload.
   */
  private async parseResponse(body: string): Promise<Record<string, JsonValue | undefined>> {
    const trimmed = body.trim()
    if (!trimmed) {
      // Treated as a missing result — callers surface generic error.
      return {} as Record<string, JsonValue | undefined>
    }
    if (trimmed.startsWith("{")) {
      // Single JSON-RPC document
      try {
        return JSON.parse(trimmed) as Record<string, JsonValue | undefined>
      } catch {
        throw new Error(`Invalid JSON from MCP server ${this.name}`)
      }
    }
    // SSE stream: parse `event: message\n data: <json>\n\n` frames
    const dataLines: string[] = []
    const frames = trimmed.split(/\n\n+/)
    for (const frame of frames) {
      let inMessage = false
      for (const rawLine of frame.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (line === "event: message") { inMessage = true; continue }
        if (line.startsWith("event:")) { inMessage = false; continue }
        if (line.startsWith("id:")) continue // priming/event id — skip
        if (line.startsWith("data:")) {
          if (inMessage) dataLines.push(line.slice(5).trimStart())
          continue
        }
        if (line === "") { inMessage = false }
      }
      if (dataLines.length) break // first message event wins
    }
    if (!dataLines.length) {
      throw new Error(`No JSON-RPC message in SSE stream from MCP server ${this.name}`)
    }
    try {
      return JSON.parse(dataLines.join("")) as Record<string, JsonValue | undefined>
    } catch {
      throw new Error(`Invalid JSON in SSE message from MCP server ${this.name}`)
    }
  }
}
