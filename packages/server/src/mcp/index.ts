/**
 * Mira MCP — StreamableHTTP / SSE / Stdio
 *
 * MCP won (97M downloads, Linux Foundation, 30% vendors by end 2026).
 * Mira is MCP-native: every external tool is an MCP server.
 *
 * Transports:
 *   - StreamableHTTP (new, preferred) — POST /mcp + GET /mcp stream
 *   - SSE (legacy)                     — GET /mcp/sse
 *   - Stdio                            — spawn local command, JSON-RPC over stdin/stdout
 *
 * Flow:
 *   MCPManager.connectAll() — reads mira.json mcp servers, connects each,
 *   discovers tools via `tools/list`, registers them as mcp__<server>__<tool>
 *   into ToolRegistry. Permission layer sees them as `mcp_firecrawl_*`, etc.
 *
 * Based on Mira's MCP handling but with StreamableHTTP added.
 */

import type { Bus } from "../bus/index.js"
import type { ToolRegistry } from "../tools/registry.js"
import type { JsonValue } from "../types/index.js"
import { z } from "zod"
import { McpStdioClient } from "./stdio-client.js"
import { McpHttpClient } from "./http-client.js"

interface MCPServerConfig {
  type: "local" | "remote"
  command?: string[]
  args?: string[]
  url?: string
  enabled: boolean
  env?: Record<string, string>
  headers?: Record<string, string>
}

export interface MCPManagerDeps {
  bus: Bus
  tools: ToolRegistry
  config: Record<string, MCPServerConfig>
}

interface ConnectedServer {
  name: string
  config: MCPServerConfig
  tools: string[] // registered tool names
  status: "connected" | "error" | "disabled"
  error?: string
}

export class MCPManager {
  private servers = new Map<string, ConnectedServer>()
  private processes = new Map<string, ReturnType<typeof Bun.spawn>>()
  private clients = new Map<string, McpStdioClient>()
  private httpClients = new Map<string, McpHttpClient>()

  constructor(private deps: MCPManagerDeps) {}

  async connectAll(): Promise<void> {
    for (const [name, cfg] of Object.entries(this.deps.config)) {
      if (!cfg.enabled) {
        this.servers.set(name, { name, config: cfg, tools: [], status: "disabled" })
        continue
      }
      try {
        await this.connect(name, cfg)
      } catch (e) {
        console.warn(`[mcp] ${name} failed:`, (e as Error).message)
        this.servers.set(name, { name, config: cfg, tools: [], status: "error", error: String(e) })
      }
    }
  }

  private async connect(name: string, cfg: MCPServerConfig): Promise<void> {
    if (cfg.type === "local") {
      await this.connectStdio(name, cfg)
    } else if (cfg.type === "remote") {
      await this.connectRemote(name, cfg)
    }
    // Mark connected if not already set by sub-method
    if (!this.servers.has(name)) {
      this.servers.set(name, { name, config: cfg, tools: [], status: "connected" })
    }
  }

  // ── Stdio transport ──────────────────────────────────────────────
  private async connectStdio(name: string, cfg: MCPServerConfig): Promise<void> {
    const command = cfg.command?.[0] ?? cfg.command?.join(" ")
    if (!command) throw new Error(`No command for MCP server ${name}`)

    const args = (cfg.command?.slice(1) ?? cfg.args ?? [])
    // Expand {env:VAR} in env values
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(cfg.env ?? {})) {
      env[k] = v.replace(/\{env:([^}]+)\}/g, (_, varName) => process.env[varName] ?? "")
    }

    // Real MCP handshake over stdio: initialize → initialized → tools/list
    const client = await McpStdioClient.spawn([command, ...args], { env })
    this.clients.set(name, client)
    this.processes.set(name, client.handle)

    const discovered = await client.listTools()
    const registered: string[] = []
    for (const t of discovered) {
      const toolName = `mcp__${name}__${t.name}`
      this.deps.tools.register({
        name: toolName,
        description: t.description ?? `MCP tool ${t.name} from ${name}`,
        category: "mcp",
        needsPermission: true,
        // JSON Schema from the server passes through; remote validates its own args
        schema: z.object({}).passthrough(),
        async execute(args) {
          const result = await client.callTool(t.name, (args as Record<string, JsonValue>) ?? {})
          const text = (result.content ?? [])
            .filter(c => c.type === "text")
            .map(c => c.text)
            .join("\n")
          return { ok: !result.isError, text }
        },
      })
      registered.push(toolName)
    }

    this.servers.set(name, { name, config: cfg, tools: registered, status: "connected" })
    console.log(`[mcp] ${name} (stdio) → ${registered.length} tools`)
  }

  // ── Remote transport (StreamableHTTP / SSE) ──────────────────────
  // Real Streamable HTTP: initialize → notifications/initialized → tools/list.
  // Uses a dependency-free JSON-RPC over HTTP client (http-client.ts) that
  // handles session id capture, SSE + single-JSON response framing, and
  // per-request timeouts. Mirrors the stdio flow so remote servers expose the
  // same mcp__<name>__<tool> surface.
  private async connectRemote(name: string, cfg: MCPServerConfig): Promise<void> {
    if (!cfg.url) throw new Error(`No url for remote MCP server ${name}`)

    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(cfg.headers ?? {})) {
      headers[k] = v.replace(/\{env:([^}]+)\}/g, (_, varName) => process.env[varName] ?? "")
    }
    // Expand env in url
    const url = cfg.url.replace(/\{env:([^}]+)\}/g, (_, varName) => process.env[varName] ?? "")

    // Real Streamable HTTP handshake: initialize → initialized → tools/list
    const client = await McpHttpClient.connect(name, { url, headers })
    this.httpClients.set(name, client)

    const discovered = await client.listTools()
    const registered: string[] = []
    for (const t of discovered) {
      const toolName = `mcp__${name}__${t.name}`
      this.deps.tools.register({
        name: toolName,
        description: t.description ?? `MCP tool ${t.name} from ${name}`,
        category: "mcp",
        needsPermission: true,
        // JSON Schema from the server passes through; remote validates its own args
        schema: z.object({}).passthrough(),
        async execute(args, ctx) {
          const signal = (ctx as { signal?: AbortSignal } | undefined)?.signal
          const result = await client.callTool(t.name, (args as Record<string, JsonValue>) ?? {}, 60_000, signal)
          const text = (result.content ?? [])
            .filter(c => c.type === "text")
            .map(c => c.text)
            .join("\n")
          return { ok: !result.isError, text }
        },
      })
      registered.push(toolName)
    }

    this.servers.set(name, { name, config: cfg, tools: registered, status: "connected" })
    console.log(`[mcp] ${name} (remote ${url}) → ${registered.length} tools`)
  }

  count(): number {
    return [...this.servers.values()].reduce((n, s) => n + s.tools.length, 0)
  }

  list(): ConnectedServer[] {
    return [...this.servers.values()]
  }

  /** Discovery view: sanitized (no config secrets) for REST/UI */
  listServers(): Array<{ name: string; type: string; status: string; toolCount: number; tools: Array<{ name: string; description: string }>; error?: string }> {
    return [...this.servers.values()].map(s => ({
      name: s.name,
      type: s.config.type,
      status: s.status,
      toolCount: s.tools.length,
      tools: s.tools.map(name => ({ name, description: this.deps.tools.get(name)?.description ?? "" })),
      ...(s.error ? { error: s.error } : {}),
    }))
  }

  async addServer(name: string, cfg: MCPServerConfig): Promise<ConnectedServer> {
    if (this.servers.has(name)) throw new Error(`MCP server ${name} already exists`)
    this.deps.config[name] = cfg
    if (!cfg.enabled) {
      const entry: ConnectedServer = { name, config: cfg, tools: [], status: "disabled" }
      this.servers.set(name, entry)
      return entry
    }
    try {
      await this.connect(name, cfg)
      const entry = this.servers.get(name)
      if (!entry) throw new Error(`Failed to connect ${name}`)
      return entry
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e)
      const entry: ConnectedServer = { name, config: cfg, tools: [], status: "error", error: err }
      this.servers.set(name, entry)
      return entry
    }
  }

  async removeServer(name: string): Promise<void> {
    const entry = this.servers.get(name)
    if (!entry) throw new Error(`MCP server ${name} not found`)
    const client = this.clients.get(name)
    if (client) {
      try { client.shutdown() } catch {}
      this.clients.delete(name)
    }
    const httpClient = this.httpClients.get(name)
    if (httpClient) {
      try { httpClient.shutdown() } catch {}
      this.httpClients.delete(name)
    }
    const proc = this.processes.get(name)
    if (proc) {
      try { proc.kill() } catch {}
      this.processes.delete(name)
    }
    for (const toolName of entry.tools) {
      this.deps.tools.unregister(toolName)
    }
    this.servers.delete(name)
    delete this.deps.config[name]
  }

  async testServer(name: string): Promise<{ ok: boolean; toolCount?: number; error?: string }> {
    const entry = this.servers.get(name)
    if (!entry) return { ok: false, error: `Server ${name} not found` }
    if (entry.status === "connected") return { ok: true, toolCount: entry.tools.length }
    if (entry.status === "disabled") return { ok: false, error: "Server disabled" }
    return { ok: false, error: entry.error ?? "Unknown error" }
  }

  async toggleServer(name: string, enabled: boolean): Promise<ConnectedServer> {
    const entry = this.servers.get(name)
    if (!entry) throw new Error(`Server ${name} not found`)
    if (entry.config.enabled === enabled) return entry
    entry.config.enabled = enabled
    this.deps.config[name] = entry.config
    if (enabled) {
      try {
        await this.connect(name, entry.config)
        const updated = this.servers.get(name)
        if (!updated) throw new Error(`Failed to connect ${name}`)
        return updated
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e)
        const failed: ConnectedServer = { name, config: entry.config, tools: [], status: "error", error: err }
        this.servers.set(name, failed)
        return failed
      }
    } else {
      const client = this.clients.get(name)
      if (client) { try { client.shutdown() } catch {} ; this.clients.delete(name) }
      const httpClient = this.httpClients.get(name)
      if (httpClient) { try { httpClient.shutdown() } catch {} ; this.httpClients.delete(name) }
      const proc = this.processes.get(name)
      if (proc) { try { proc.kill() } catch {} ; this.processes.delete(name) }
      for (const toolName of entry.tools) {
        this.deps.tools.unregister(toolName)
      }
      const disabled: ConnectedServer = { name, config: entry.config, tools: [], status: "disabled" }
      this.servers.set(name, disabled)
      return disabled
    }
  }

  disconnectAll(): void {
    for (const [, client] of this.clients) {
      try { client.shutdown() } catch {}
    }
    this.clients.clear()
    for (const [, client] of this.httpClients) {
      try { client.shutdown() } catch {}
    }
    this.httpClients.clear()
    for (const [name, proc] of this.processes) {
      try { proc.kill() } catch {}
      console.log(`[mcp] ${name} disconnected`)
    }
    this.processes.clear()
  }
}
