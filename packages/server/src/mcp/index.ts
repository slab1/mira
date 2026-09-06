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

import type { Bus } from '../bus/index.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { JsonValue } from '../types/index.js'
import type { MCPServerConfig } from '../../../shared/src/schemas/config.js'
import { expandEnv, expandEnvTemplate, sanitizeForLog } from '../../../shared/src/utils/env.js'
import { jsonSchemaToZod } from './json-schema-to-zod.js'
import { McpStdioClient } from './stdio-client.js'
import { McpHttpClient } from './http-client.js'
import { z } from 'zod'

export type { MCPServerConfig }

export interface MCPManagerDeps {
  bus: Bus
  tools: ToolRegistry
  config: Record<string, MCPServerConfig>
}

interface ConnectedServer {
  name: string
  config: MCPServerConfig
  tools: string[] // registered tool names
  status: 'connected' | 'error' | 'disabled'
  error?: string
}

interface MCPClient {
  listTools(
    timeoutMs?: number,
  ): Promise<Array<{ name: string; description?: string; inputSchema?: Record<string, JsonValue> }>>
  callTool(
    name: string,
    args: Record<string, JsonValue>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>
  listResources(
    timeoutMs?: number,
  ): Promise<Array<{ uri: string; name: string; description?: string; mimeType?: string }>>
  readResource(
    uri: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<{ contents: Array<{ uri: string; text?: string; blob?: string; mimeType?: string }> }>
  shutdown(): Promise<void>
  readonly alive: boolean
  readonly handle: ReturnType<typeof Bun.spawn> | null
}

export class MCPManager {
  private servers = new Map<string, ConnectedServer>()
  private processes = new Map<string, ReturnType<typeof Bun.spawn>>()
  private clients = new Map<string, MCPClient>()
  private reconnectAttempts = new Map<string, number>()
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private healthInterval: ReturnType<typeof setInterval> | null = null

  constructor(private deps: MCPManagerDeps) {}

  async connectAll(): Promise<void> {
    for (const [name, cfg] of Object.entries(this.deps.config)) {
      if (!cfg.enabled) {
        this.servers.set(name, { name, config: cfg, tools: [], status: 'disabled' })
        continue
      }
      try {
        await this.connect(name, cfg)
      } catch (e) {
        console.warn(`[mcp] ${sanitizeForLog(name)} failed:`, sanitizeForLog((e as Error).message))
        this.servers.set(name, { name, config: cfg, tools: [], status: 'error', error: String(e) })
        this.scheduleReconnect(name, cfg)
      }
    }
  }

  private async connect(name: string, cfg: MCPServerConfig): Promise<void> {
    if (cfg.type === 'local') {
      await this.connectStdio(name, cfg)
    } else if (cfg.type === 'remote') {
      await this.connectRemote(name, cfg)
    }
    // Mark connected if not already set by sub-method
    if (!this.servers.has(name)) {
      this.servers.set(name, { name, config: cfg, tools: [], status: 'connected' })
    }
    this.reconnectAttempts.delete(name)
  }

  // ── Stdio transport ──────────────────────────────────────────────
  private async connectStdio(name: string, cfg: MCPServerConfig): Promise<void> {
    const rawCommand = cfg.command ?? []
    if (rawCommand.length === 0) throw new Error(`No command for MCP server ${name}`)
    const expandedCommand = expandEnvTemplate(rawCommand)
    const command = expandedCommand[0]
    if (!command) throw new Error(`No command for MCP server ${name}`)
    const args = expandedCommand.slice(1).length
      ? expandedCommand.slice(1)
      : expandEnvTemplate(cfg.args ?? [])
    // Expand {env:VAR} in env values
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(cfg.env ?? {})) {
      env[k] = expandEnv(v)
    }

    const timeoutMs = cfg.timeoutMs ?? 60_000
    // Real MCP handshake over stdio: initialize → initialized → tools/list
    const client = await McpStdioClient.spawn([command, ...args], { env })
    this.clients.set(name, client as unknown as MCPClient)
    this.processes.set(name, client.handle)

    const discovered = await client.listTools()
    const registered: string[] = []
    for (const t of discovered) {
      const toolName = `mcp__${name}__${t.name}`
      const schema = t.inputSchema ? jsonSchemaToZod(t.inputSchema) : z.object({}).passthrough()
      this.deps.tools.register({
        name: toolName,
        description: t.description ?? `MCP tool ${t.name} from ${name}`,
        category: 'mcp',
        needsPermission: true,
        schema,
        async execute(args, ctx) {
          const result = await client.callTool(
            t.name,
            (args as Record<string, JsonValue>) ?? {},
            timeoutMs,
            ctx.signal,
          )
          const text = (result.content ?? [])
            .filter((c) => c.type === 'text')
            .map((c) => c.text)
            .join('\n')
          return { ok: !result.isError, text }
        },
      })
      registered.push(toolName)
    }

    // Resources
    try {
      const resources = await client.listResources()
      for (const r of resources) {
        const toolName = `mcp__${name}__resource__${sanitizeResourceName(r.uri)}`
        this.deps.tools.register({
          name: toolName,
          description: r.description ?? `MCP resource ${r.uri} from ${name}`,
          category: 'mcp',
          needsPermission: true,
          schema: z.object({}).passthrough(),
          async execute(_args, ctx) {
            const result = await client.readResource(r.uri, timeoutMs, ctx.signal)
            const text = (result.contents ?? []).map((c) => c.text ?? c.blob ?? '').join('\n')
            return { ok: true, text, contents: result.contents }
          },
        })
        registered.push(toolName)
      }
    } catch {}

    this.servers.set(name, { name, config: cfg, tools: registered, status: 'connected' })
    console.log(`[mcp] ${sanitizeForLog(name)} (stdio) → ${registered.length} tools`)
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
      headers[k] = expandEnv(v)
    }
    // Expand env in url
    const url = expandEnv(cfg.url)
    const timeoutMs = cfg.timeoutMs ?? 60_000

    // Real Streamable HTTP handshake: initialize → initialized → tools/list
    const client = await McpHttpClient.connect(name, { url, headers })
    this.clients.set(name, client as unknown as MCPClient)

    const discovered = await client.listTools()
    const registered: string[] = []
    for (const t of discovered) {
      const toolName = `mcp__${name}__${t.name}`
      const schema = t.inputSchema ? jsonSchemaToZod(t.inputSchema) : z.object({}).passthrough()
      this.deps.tools.register({
        name: toolName,
        description: t.description ?? `MCP tool ${t.name} from ${name}`,
        category: 'mcp',
        needsPermission: true,
        schema,
        async execute(args, ctx) {
          const result = await client.callTool(
            t.name,
            (args as Record<string, JsonValue>) ?? {},
            timeoutMs,
            ctx.signal,
          )
          const text = (result.content ?? [])
            .filter((c) => c.type === 'text')
            .map((c) => c.text)
            .join('\n')
          return { ok: !result.isError, text }
        },
      })
      registered.push(toolName)
    }

    // Resources
    try {
      const resources = await client.listResources()
      for (const r of resources) {
        const toolName = `mcp__${name}__resource__${sanitizeResourceName(r.uri)}`
        this.deps.tools.register({
          name: toolName,
          description: r.description ?? `MCP resource ${r.uri} from ${name}`,
          category: 'mcp',
          needsPermission: true,
          schema: z.object({}).passthrough(),
          async execute(_args, ctx) {
            const result = await client.readResource(r.uri, timeoutMs, ctx.signal)
            const text = (result.contents ?? []).map((c) => c.text ?? c.blob ?? '').join('\n')
            return { ok: true, text, contents: result.contents }
          },
        })
        registered.push(toolName)
      }
    } catch {}

    this.servers.set(name, { name, config: cfg, tools: registered, status: 'connected' })
    console.log(
      `[mcp] ${sanitizeForLog(name)} (remote ${sanitizeForLog(url)}) → ${registered.length} tools`,
    )
  }

  count(): number {
    return [...this.servers.values()].reduce((n, s) => n + s.tools.length, 0)
  }

  list(): ConnectedServer[] {
    return [...this.servers.values()]
  }

  /** Discovery view: sanitized (no config secrets) for REST/UI */
  listServers(): Array<{
    name: string
    type: string
    status: string
    toolCount: number
    tools: Array<{ name: string; description: string }>
    error?: string
  }> {
    return [...this.servers.values()].map((s) => ({
      name: s.name,
      type: s.config.type,
      status: s.status,
      toolCount: s.tools.length,
      tools: s.tools.map((name) => ({
        name,
        description: this.deps.tools.get(name)?.description ?? '',
      })),
      ...(s.error ? { error: s.error } : {}),
    }))
  }

  async addServer(name: string, cfg: MCPServerConfig): Promise<ConnectedServer> {
    if (this.servers.has(name)) throw new Error(`MCP server ${name} already exists`)
    this.deps.config[name] = cfg
    if (!cfg.enabled) {
      const entry: ConnectedServer = { name, config: cfg, tools: [], status: 'disabled' }
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
      const entry: ConnectedServer = { name, config: cfg, tools: [], status: 'error', error: err }
      this.servers.set(name, entry)
      this.scheduleReconnect(name, cfg)
      return entry
    }
  }

  async removeServer(name: string): Promise<void> {
    const entry = this.servers.get(name)
    if (!entry) throw new Error(`MCP server ${name} not found`)
    await this.cleanupServer(name, entry.tools)
    this.servers.delete(name)
    delete this.deps.config[name]
  }

  async testServer(name: string): Promise<{ ok: boolean; toolCount?: number; error?: string }> {
    const entry = this.servers.get(name)
    if (!entry) return { ok: false, error: `Server ${name} not found` }
    if (entry.status === 'connected') return { ok: true, toolCount: entry.tools.length }
    if (entry.status === 'disabled') return { ok: false, error: 'Server disabled' }
    return { ok: false, error: entry.error ?? 'Unknown error' }
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
        const failed: ConnectedServer = {
          name,
          config: entry.config,
          tools: [],
          status: 'error',
          error: err,
        }
        this.servers.set(name, failed)
        this.scheduleReconnect(name, entry.config)
        return failed
      }
    } else {
      await this.cleanupServer(name, entry.tools)
      const disabled: ConnectedServer = {
        name,
        config: entry.config,
        tools: [],
        status: 'disabled',
      }
      this.servers.set(name, disabled)
      return disabled
    }
  }

  // ── Health & Reconnect ───────────────────────────────────────────
  async healthCheck(): Promise<void> {
    for (const [name, server] of this.servers) {
      if (server.status !== 'connected') continue
      const client = this.clients.get(name)
      if (!client) continue
      if (client.alive) continue
      // Client died — mark error and schedule reconnect
      console.warn(`[mcp] healthCheck: ${sanitizeForLog(name)} not alive, scheduling reconnect`)
      this.servers.set(name, {
        ...server,
        status: 'error',
        error: 'health check failed: client not alive',
      })
      this.deps.bus.publish({
        type: 'server.error',
        payload: {
          error: `MCP server ${name} health check failed`,
          source: 'mcp-health',
          server: name,
        } as JsonValue,
        timestamp: Date.now(),
      })
      // Cleanup dead client
      await this.cleanupServer(name, server.tools)
      this.scheduleReconnect(name, server.config)
    }
  }

  private scheduleReconnect(name: string, cfg: MCPServerConfig): void {
    const reconnectCfg = cfg.reconnect
    if (reconnectCfg?.enabled === false) return
    const maxRetries = reconnectCfg?.maxRetries ?? 5
    const baseDelayMs = reconnectCfg?.baseDelayMs ?? 1000
    const maxDelayMs = reconnectCfg?.maxDelayMs ?? 30_000

    const attempts = this.reconnectAttempts.get(name) ?? 0
    if (attempts >= maxRetries) {
      console.warn(`[mcp] ${sanitizeForLog(name)} max reconnect attempts (${maxRetries}) reached`)
      this.deps.bus.publish({
        type: 'server.error',
        payload: {
          error: `MCP server ${name} max reconnect attempts reached`,
          source: 'mcp-reconnect',
          server: name,
        } as JsonValue,
        timestamp: Date.now(),
      })
      return
    }

    const delay = Math.min(baseDelayMs * 2 ** attempts, maxDelayMs)
    this.reconnectAttempts.set(name, attempts + 1)

    // Clear existing timer
    const existing = this.reconnectTimers.get(name)
    if (existing) clearTimeout(existing)

    console.log(
      `[mcp] scheduling reconnect for ${sanitizeForLog(name)} in ${delay}ms (attempt ${attempts + 1}/${maxRetries})`,
    )
    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(name)
      try {
        // Clean up old tools before reconnect
        const old = this.servers.get(name)
        if (old) {
          for (const toolName of old.tools) this.deps.tools.unregister(toolName)
        }
        await this.connect(name, cfg)
        console.log(`[mcp] ${sanitizeForLog(name)} reconnected successfully`)
        this.reconnectAttempts.delete(name)
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e)
        console.warn(`[mcp] ${sanitizeForLog(name)} reconnect failed:`, sanitizeForLog(err))
        this.servers.set(name, { name, config: cfg, tools: [], status: 'error', error: err })
        this.deps.bus.publish({
          type: 'server.error',
          payload: {
            error: `MCP server ${name} reconnect failed: ${err}`,
            source: 'mcp-reconnect',
            server: name,
          } as JsonValue,
          timestamp: Date.now(),
        })
        this.scheduleReconnect(name, cfg)
      }
    }, delay)
    this.reconnectTimers.set(name, timer)
  }

  startHealthCheck(intervalMs = 30_000): void {
    if (this.healthInterval) clearInterval(this.healthInterval)
    this.healthInterval = setInterval(() => {
      this.healthCheck().catch((e) => console.warn('[mcp] healthCheck error:', e))
    }, intervalMs)
  }

  stopHealthCheck(): void {
    if (this.healthInterval) {
      clearInterval(this.healthInterval)
      this.healthInterval = null
    }
    for (const [, timer] of this.reconnectTimers) clearTimeout(timer)
    this.reconnectTimers.clear()
  }

  private async cleanupServer(name: string, tools: string[]): Promise<void> {
    const client = this.clients.get(name)
    if (client) {
      try {
        await client.shutdown()
      } catch {}
      this.clients.delete(name)
    }
    const proc = this.processes.get(name)
    if (proc) {
      try {
        proc.kill()
      } catch {}
      this.processes.delete(name)
    }
    for (const toolName of tools) {
      this.deps.tools.unregister(toolName)
    }
    // Clear reconnect state
    const timer = this.reconnectTimers.get(name)
    if (timer) {
      clearTimeout(timer)
      this.reconnectTimers.delete(name)
    }
  }

  async disconnectAll(): Promise<void> {
    this.stopHealthCheck()
    const promises: Promise<void>[] = []
    for (const [, client] of this.clients) {
      promises.push(client.shutdown().catch(() => {}))
    }
    await Promise.allSettled(promises)
    this.clients.clear()
    for (const [name, proc] of this.processes) {
      try {
        proc.kill()
      } catch {}
      console.log(`[mcp] ${sanitizeForLog(name)} disconnected`)
    }
    this.processes.clear()
    this.reconnectAttempts.clear()
  }
}

function sanitizeResourceName(uri: string): string {
  return uri.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64) || 'resource'
}
