import type { JsonValue } from "../types/index.js"
/**
 * Mira MCP HTTP Client — Streamable HTTP transport, JSON-RPC 2.0 over HTTP
 *
 * Implements the MCP Streamable HTTP spec without SDK deps, mirroring the
 * hand-rolled stdio client (stdio-client.ts):
 *   initialize → notifications/initialized → tools/list → tools/call
 *
 * Protocol notes (MCP spec, 2025-06-18 transports):
 *   - POST {url} with `Accept: application/json, text/event-stream`
 *   - The response is EITHER a single JSON-RPC document OR an SSE stream whose
 *     `message` events carry JSON-RPC in their `data:` line.
 *   - The server assigns a session id via the `Mcp-Session-Id` HTTP header on
 *     the initialize response; the client MUST echo it on every subsequent
 *     request (as `Mcp-Session-Id`).
 *   - Notifications (e.g. notifications/initialized) expect no response body.
 *
 * Timeout-guarded per request via AbortController, like the LSP/stdio clients.
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

export class McpHttpClient {
  public serverInfo: Record<string, JsonValue> = {}
  public capabilities: Record<string, JsonValue> = {}
  public name: string
  private sessionId?: string
  private readonly url: string
  private readonly headers: Record<string, string>
  private closed = false

  private constructor(name: string, opts: McpHttpOptions) {
    this.name = name
    this.url = opts.url
    this.headers = opts.headers ?? {}
  }

  static async connect(name: string, opts: McpHttpOptions): Promise<McpHttpClient> {
    const client = new McpHttpClient(name, opts)
    await client.handshake()
    return client
  }

  /** Real MCP handshake: initialize → capture session id → initialized notification */
  private async handshake(): Promise<void> {
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

  get alive(): boolean {
    return !this.closed
  }

  async listTools(timeoutMs = 20_000): Promise<MCPToolDef[]> {
    const r = await this.request<Record<string, JsonValue>>("tools/list", {}, timeoutMs)
    const tools = r?.tools
    if (!Array.isArray(tools)) return []
    return (tools as Array<Record<string, JsonValue>>).map(t => ({
      name: String(t.name ?? ""),
      description: typeof t.description === "string" ? t.description : undefined,
      inputSchema: t.inputSchema as Record<string, JsonValue> | undefined,
    })).filter(t => t.name.length > 0)
  }

  async callTool(
    name: string,
    args: Record<string, JsonValue>,
    timeoutMs = 60_000,
    signal?: AbortSignal,
  ): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }> {
    return await this.request("tools/call", { name, arguments: args }, timeoutMs, undefined, signal)
  }

  async shutdown(): Promise<void> {
    // Streamable HTTP has no explicit client shutdown message; sessions are
    // server-timed. Just mark closed so no further requests are issued.
    this.closed = true
  }

  /** Expose the same `handle` shape as the stdio client (here: no process) */
  get handle(): null {
    return null
  }

  // ── Protocol ───────────────────────────────────────────────────────

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
      const contentType = res.headers.get("content-type") ?? ""
      const body = await res.text()
      if (opts.expectBody === false && !body.trim()) return body
      void contentType
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
