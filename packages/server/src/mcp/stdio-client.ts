import type { JsonValue } from "../types/index.js"
/**
 * Mira MCP Stdio Client — JSON-RPC 2.0 over stdin/stdout (newline-delimited)
 *
 * Implements the MCP spec handshake + tool surface without SDK deps:
 *   initialize → notifications/initialized → tools/list → tools/call
 *
 * Timeout-guarded like the LSP client; rejects pending on server exit.
 */

export interface MCPToolDef {
  name: string
  description?: string
  inputSchema?: Record<string, JsonValue>
}

interface Pending {
  resolve: (v: JsonValue) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class McpStdioClient {
  private proc: ReturnType<typeof Bun.spawn>
  private buf = ""
  private nextId = 1
  private pending = new Map<number, Pending>()
  public serverInfo: Record<string, JsonValue> = {}
  public capabilities: Record<string, JsonValue> = {}
  public name: string

  private constructor(name: string, proc: ReturnType<typeof Bun.spawn>) {
    this.name = name
    this.proc = proc
    void this.readLoop()
  }

  static async spawn(command: string[], opts: { env?: Record<string, string>; cwd?: string } = {}): Promise<McpStdioClient> {
    // Build minimal env — only cfg.env + safe defaults (PATH, HOME) to avoid leaking secrets like OPENROUTER_API_KEY
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin",
      HOME: process.env.HOME ?? "",
      // Keep locale/timezone if present
      ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
      ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
    }
    Object.assign(env, opts.env ?? {})
    const proc = Bun.spawn(command, {
      env,
      cwd: opts.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    const client = new McpStdioClient(command[0], proc)
    const result = await client.request<Record<string, JsonValue>>("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mira", version: "0.1.0" },
    }, 15_000)
    if (result?.serverInfo) client.serverInfo = result.serverInfo as Record<string, JsonValue>
    if (result?.capabilities) client.capabilities = result.capabilities as Record<string, JsonValue>
    await client.notify("notifications/initialized")
    return client
  }

  get alive(): boolean {
    return !this.exited && this.proc.exitCode === null && this.proc.signalCode === null
  }
  private exited = false

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

  async callTool(name: string, args: Record<string, JsonValue>, timeoutMs = 60_000): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }> {
    return await this.request("tools/call", { name, arguments: args }, timeoutMs)
  }

  async shutdown(): Promise<void> {
    if (!this.alive) return
    this.exited = true
    try { this.proc.kill() } catch {}
  }

  // ── Protocol ───────────────────────────────────────────────────────

  request<T = Record<string, JsonValue>>(method: string, params: JsonValue, timeoutMs = 30_000): Promise<T> {
    if (!this.alive) return Promise.reject(new Error(`MCP server not alive: ${this.name}`))
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
      try {
        this.write({ jsonrpc: "2.0", id, method, params })
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(e as Error)
      }
    })
  }

  async notify(method: string, params: JsonValue = {}): Promise<void> {
    this.write({ jsonrpc: "2.0", method, params })
  }

  /** Expose the raw process handle so managers can kill on disconnectAll */
  get handle(): ReturnType<typeof Bun.spawn> {
    return this.proc
  }

  private write(msg: object): void {
    if (!this.alive) throw new Error(`MCP server not alive: ${this.name}`)
    // MCP stdio framing: newline-delimited JSON (NOT Content-Length like LSP)
    ;(this.proc.stdin as Bun.FileSink).write(JSON.stringify(msg) + "\n")
  }

  private async readLoop(): Promise<void> {
    const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        this.buf += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = this.buf.indexOf("\n")) !== -1) {
          const line = this.buf.slice(0, nl).trim()
          this.buf = this.buf.slice(nl + 1)
          if (line) this.handleMessage(line)
        }
      }
    } catch {}
    this.exited = true
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error(`MCP server exited: ${this.name}`))
    }
    this.pending.clear()
  }

  private handleMessage(line: string): void {
    let msg: Record<string, JsonValue | undefined>
    try { msg = JSON.parse(line) } catch { return }
    const id = msg.id
    if (typeof id !== "number") return // notification
    const p = this.pending.get(id)
    if (!p) return
    clearTimeout(p.timer)
    this.pending.delete(id)
    const errObj = msg.error as { code?: JsonValue; message?: JsonValue } | undefined
    if (errObj) p.reject(new Error(`MCP error ${String(errObj.code)}: ${String(errObj.message)}`))
    else p.resolve(msg.result ?? (null as JsonValue))
  }
}
