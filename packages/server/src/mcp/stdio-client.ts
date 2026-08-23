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
  inputSchema?: Record<string, unknown>
}

interface Pending {
  resolve: (v: any) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class McpStdioClient {
  private proc: any
  private buf = ""
  private nextId = 1
  private pending = new Map<number, Pending>()
  public serverInfo: Record<string, unknown> = {}
  public capabilities: Record<string, unknown> = {}
  public name: string

  private constructor(name: string, proc: any) {
    this.name = name
    this.proc = proc
    void this.readLoop()
  }

  static async spawn(command: string[], opts: { env?: Record<string, string>; cwd?: string } = {}): Promise<McpStdioClient> {
    const proc = Bun.spawn(command, {
      env: { ...process.env, ...(opts.env ?? {}) } as any,
      cwd: opts.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    const client = new McpStdioClient(command[0], proc)
    const result = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mira", version: "0.1.0" },
    }, 15_000)
    if (result?.serverInfo) client.serverInfo = result.serverInfo
    if (result?.capabilities) client.capabilities = result.capabilities
    await client.notify("notifications/initialized")
    return client
  }

  get alive(): boolean {
    return !this.exited && this.proc.exitCode === null && this.proc.signalCode === null
  }
  private exited = false

  async listTools(timeoutMs = 20_000): Promise<MCPToolDef[]> {
    const r = await this.request("tools/list", {}, timeoutMs)
    return Array.isArray(r?.tools) ? r.tools : []
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }> {
    return await this.request("tools/call", { name, arguments: args }, timeoutMs)
  }

  async shutdown(): Promise<void> {
    if (!this.alive) return
    this.exited = true
    try { this.proc.kill() } catch {}
  }

  // ── Protocol ───────────────────────────────────────────────────────

  request<T = any>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
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
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.write({ jsonrpc: "2.0", id, method, params })
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(e as Error)
      }
    })
  }

  async notify(method: string, params: unknown = {}): Promise<void> {
    this.write({ jsonrpc: "2.0", method, params })
  }

  /** Expose the raw process handle so managers can kill on disconnectAll */
  get handle(): any {
    return this.proc
  }

  private write(msg: object): void {
    if (!this.alive) throw new Error(`MCP server not alive: ${this.name}`)
    // MCP stdio framing: newline-delimited JSON (NOT Content-Length like LSP)
    this.proc.stdin.write(JSON.stringify(msg) + "\n")
  }

  private async readLoop(): Promise<void> {
    const reader = this.proc.stdout.getReader()
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
    let msg: any
    try { msg = JSON.parse(line) } catch { return }
    if (msg.id === undefined || msg.id === null) return // notification
    const p = this.pending.get(msg.id)
    if (!p) return
    clearTimeout(p.timer)
    this.pending.delete(msg.id)
    if (msg.error) p.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`))
    else p.resolve(msg.result)
  }
}
