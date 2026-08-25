import type { JsonValue } from "../types/index.js"
/**
 * Mira LSP Client — Language Server Protocol 3.17 over stdio (JSON-RPC 2.0)
 *
 * Real language-server integration (OpenCode-parity):
 *   - Content-Length framed messages, bidirectional
 *   - Requests with id→promise correlation + timeout guard
 *   - Server notifications captured (publishDiagnostics)
 *   - Per-language server registry (gopls, custom via MIRA_LSP_<LANG>_CMD)
 *
 * Falls back gracefully: callers check availability before use.
 */

export interface LSPPosition { line: number; character: number }
export interface LSPLocation { uri: string; range: { start: LSPPosition; end: LSPPosition } }
export interface LSPDiagnostic { severity?: number; message: string; range: unknown; source?: string }

interface PendingRequest {
  resolve: (v: JsonValue) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class LSPClient {
  // Encapsulated process handle — Bun's Subprocess generics vary by version
  private proc: ReturnType<typeof Bun.spawn>
  private buf = ""
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  /** uri → latest published diagnostics */
  readonly diagnostics = new Map<string, LSPDiagnostic[]>()
  private shuttingDown = false

  public readonly serverName: string
  public capabilities: Record<string, unknown> = {}

  private constructor(serverName: string, proc: ReturnType<typeof Bun.spawn>) {
    this.serverName = serverName
    this.proc = proc
    void this.readLoop()
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  /** Spawn a server process and perform the initialize handshake */
  static async spawn(cmd: string[], args: string[], rootPath: string, name = cmd[0]): Promise<LSPClient> {
    const proc = Bun.spawn([cmd[0], ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: rootPath,
    })
    const client = new LSPClient(name, proc)

    const result = await client.request("initialize", {
      processId: process.pid,
      rootUri: `file://${rootPath.replace(/\/$/, "")}`,
      capabilities: {
        textDocument: {
          publishDiagnostics: { relatedInformation: false },
        },
      },
    }, 20_000)
    client.capabilities = ((result as { capabilities?: Record<string, unknown> } | null)?.capabilities) ?? {}
    await client.notify("initialized", {})
    return client
  }

  get alive(): boolean {
    return !this.shuttingDown && this.proc.exitCode === null && this.proc.signalCode === null
  }

  async shutdown(): Promise<void> {
    if (!this.alive) return
    this.shuttingDown = true
    try { await this.request("shutdown", null, 5_000) } catch {}
    try { await this.notify("exit") } catch {}
    try { this.proc.kill() } catch {}
  }

  // ── Protocol ───────────────────────────────────────────────────────

  request<T = JsonValue>(method: string, params: object | null, timeoutMs = 30_000): Promise<T> {
    if (!this.alive) {
      return Promise.reject(new Error(`LSP server not alive: ${this.serverName}`))
    }
    const id = this.nextId++
    const timer = setTimeout(() => {
      const p = this.pending.get(id)
      if (p) {
        this.pending.delete(id)
        p.reject(new Error(`LSP ${method} timed out after ${timeoutMs}ms (${this.serverName})`))
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

  async notify(method: string, params: unknown = {}): Promise<void> {
    this.write({ jsonrpc: "2.0", method, params })
  }

  // ── Document sync + language features ─────────────────────────────

  async didOpen(fileUri: string, text: string, languageId = "plaintext", version = 1): Promise<void> {
    await this.notify("textDocument/didOpen", {
      textDocument: { uri: fileUri, languageId, version, text },
    })
  }

  async definition(fileUri: string, pos: LSPPosition): Promise<LSPLocation[] | null> {
    const r = await this.request<LSPLocation[] | LSPLocation>("textDocument/definition", {
      textDocument: { uri: fileUri },
      position: pos,
    })
    if (!r) return null
    return Array.isArray(r) ? r : [r]
  }

  async references(fileUri: string, pos: LSPPosition, includeDeclaration = true): Promise<LSPLocation[]> {
    const r = await this.request<LSPLocation[]>("textDocument/references", {
      textDocument: { uri: fileUri },
      position: pos,
      context: { includeDeclaration },
    })
    return Array.isArray(r) ? r : []
  }

  async hover(fileUri: string, pos: LSPPosition): Promise<{ contents?: { value?: string; kind?: string } } | null> {
    return await this.request("textDocument/hover", {
      textDocument: { uri: fileUri },
      position: pos,
    })
  }

  // ── Internals ──────────────────────────────────────────────────────

  private write(msg: object): void {
    if (!this.alive) throw new Error(`LSP server not alive: ${this.serverName}`)
    const body = JSON.stringify(msg)
    const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
    ;(this.proc.stdin as Bun.FileSink).write(frame)
  }

  private async readLoop(): Promise<void> {
    const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        this.buf += decoder.decode(value, { stream: true })

        // Extract all complete Content-Length framed messages
        while (true) {
          const headerEnd = this.buf.indexOf("\r\n\r\n")
          if (headerEnd === -1) break
          const header = this.buf.slice(0, headerEnd)
          const m = header.match(/Content-Length:\s*(\d+)/i)
          if (!m) {
            // Malformed header — drop it to avoid stalling forever
            this.buf = this.buf.slice(headerEnd + 4)
            continue
          }
          const len = parseInt(m[1], 10)
          const bodyStart = headerEnd + 4
          if (this.buf.length < bodyStart + len) break // wait for more bytes
          const body = this.buf.slice(bodyStart, bodyStart + len)
          this.buf = this.buf.slice(bodyStart + len)
          this.handleMessage(body)
        }
      }
    } catch {
      // stream ended (server died) — reject all pending
    }
    this.rejectAllPending(new Error(`LSP server exited: ${this.serverName}`))
  }

  private handleMessage(body: string): void {
    let msg: Record<string, JsonValue | undefined>
    try { msg = JSON.parse(body) } catch { return }

    const id = msg.id
    if (typeof id === "number" && (msg.result !== undefined || msg.error !== undefined)) {
      // Response to our request
      const p = this.pending.get(id)
      if (p) {
        clearTimeout(p.timer)
        this.pending.delete(id)
        const errObj = msg.error as { code?: JsonValue; message?: JsonValue } | undefined
        if (errObj) p.reject(new Error(`LSP error ${String(errObj.code)}: ${String(errObj.message)}`))
        else p.resolve(msg.result ?? null)
      }
      return
    }

    if (msg.method === "textDocument/publishDiagnostics") {
      const params = msg.params as { uri?: string; diagnostics?: LSPDiagnostic[] } | undefined
      this.diagnostics.set(params?.uri ?? "", params?.diagnostics ?? [])
      return
    }
    // window/logMessage & friends: ignored
  }

  private rejectAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }
}

// ── Per-language server registry ────────────────────────────────────

const clients = new Map<string, LSPClient>()

/** Detect a language server command for a file path (env override wins). */
export function serverCommandFor(filePath: string): { cmd: string[]; lang: string; name: string } | null {
  const ext = filePath.slice(filePath.lastIndexOf(".") + 1).toLowerCase()
  const env = (k: string) => {
    const v = process.env[k]
    return v ? v.split(/\s+/) : null
  }
  switch (ext) {
    case "go": {
      const cmd = env("MIRA_LSP_GO_CMD") ?? ["gopls"]
      return { cmd, lang: "go", name: "gopls" }
    }
    default:
      return null
  }
}

/** Get (or lazily spawn) an LSP client for a file. Returns null when no server configured. */
export async function clientForFile(
  filePath: string,
  rootPath = process.cwd(),
): Promise<LSPClient | null> {
  const spec = serverCommandFor(filePath)
  if (!spec) return null

  const existing = clients.get(spec.lang)
  if (existing?.alive) return existing
  if (existing && !existing.alive) clients.delete(spec.lang)

  // Only spawn when binary actually exists — avoids noisy failures
  try {
    const proc = Bun.which(spec.cmd[0])
    if (!proc) return null
  } catch { return null }

  try {
    const client = await LSPClient.spawn(spec.cmd, spec.cmd.slice(1), rootPath, spec.name)
    clients.set(spec.lang, client)
    return client
  } catch {
    return null
  }
}

/** Shutdown all running language servers (graceful-exit hook) */
export async function shutdownAllServers(): Promise<void> {
  await Promise.allSettled([...clients.values()].map(c => c.shutdown()))
  clients.clear()
}
