import type { MCPServerConfig } from '../../../shared/src/schemas/config.js'

/**
 * Mira Server — Shared Types
 * Based on Mira architecture: sessions, messages, parts, todos + BusEvent
 */

// ── Session & Message ──────────────────────────────────────────────
export type SessionID = string
export type MessageID = string
export type PartID = string

export type Role = 'user' | 'assistant' | 'system'

export interface Session {
  id: SessionID
  title: string
  model: string // e.g. "openrouter/anthropic/claude-sonnet-4"
  provider: string
  createdAt: number
  updatedAt: number
  parentID?: SessionID // for forked sessions
}

export interface Message {
  id: MessageID
  sessionID: SessionID
  role: Role
  createdAt: number
}

export type PartType = 'text' | 'tool-call' | 'tool-result' | 'reasoning' | 'file'

export interface Part {
  id: PartID
  messageID: MessageID
  sessionID: SessionID
  type: PartType
  text?: string
  tool?: string // tool name for tool-call/result
  toolCallID?: string
  args?: JsonValue
  result?: JsonValue
  isError?: boolean
  createdAt: number
}

// ── Todo ───────────────────────────────────────────────────────────
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'
export type TodoPriority = 'high' | 'medium' | 'low'

export interface Todo extends Record<string, JsonValue> {
  id: string
  sessionID: SessionID
  content: string
  status: TodoStatus
  priority: TodoPriority
  createdAt: number
}

// ── Tool ───────────────────────────────────────────────────────────
export interface ToolCall {
  id: string
  name: string
  args: Record<string, JsonValue>
}

export interface ToolResult {
  toolCallID: string
  name: string
  result: JsonValue
  isError?: boolean
}

// ── Model ──────────────────────────────────────────────────────────
export interface ModelRef {
  provider: string // "openrouter" | "anthropic" | "openai" | ...
  modelID: string // "anthropic/claude-sonnet-4" | "gpt-4o"
}

export interface StreamChunk {
  type: 'text-delta' | 'tool-call' | 'tool-result' | 'finish' | 'error'
  text?: string
  toolCall?: ToolCall
  finishReason?: 'stop' | 'tool-calls' | 'length' | 'error'
  usage?: { inputTokens: number; outputTokens: number }
}

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue | undefined }

// ── BusEvent (Event-driven, no polling) ────────────────────────────
export type BusEventType =
  | 'session.created'
  | 'session.updated'
  | 'session.deleted'
  | 'message.created'
  | 'message.updated'
  | 'part.created'
  | 'part.updated'
  | 'todo.updated'
  | 'job.created'
  | 'job.updated'
  | 'job.cancelled'
  | 'learning.updated'
  | 'permission.ask'
  | 'permission.reply'
  | 'question.ask'
  | 'question.reply'
  | 'server.heartbeat'
  | 'server.error'
  | 'config.updated'

export interface BusEvent<T = JsonValue> {
  type: BusEventType
  sessionID?: SessionID
  payload: T
  timestamp: number
}

// ── Permission ─────────────────────────────────────────────────────
export type PermissionAction = 'allow' | 'deny' | 'ask'

export interface PermissionRequest {
  sessionID: SessionID
  tool: string
  args: Record<string, JsonValue>
  pattern?: string // matched permission pattern e.g. "bash:rm *"
}

// ── Config ─────────────────────────────────────────────────────────
export interface MiraConfig {
  model: string
  smallModel?: string
  /** Agentic loop limits (env MIRA_MAX_STEPS etc. override these) */
  loop?: {
    maxSteps?: number
    contextLimit?: number
    compactionThreshold?: number
    smallModel?: string
  }
  /** @deprecated — use `loop`; kept for backward compat with older mira.json */
  loopLimits?: {
    maxSteps?: number
    contextLimit?: number | string
    compactionThreshold?: number
    smallModel?: string
  }
  permission: Record<string, PermissionAction | Record<string, PermissionAction>>
  guardrails?: {
    enforce?: boolean
    allowedRoots?: string[]
    blockedPaths?: string[]
    blockedCommands?: string[]
    allowedCommands?: string[]
    maxOutputBytes?: number
    auditLogPath?: string
  }
  mcp: Record<string, MCPServerConfig>
  provider: Record<string, ProviderConfig>
  routing?: RoutingConfig
  subgateways?: Record<string, SubgatewayConfig>
  /** Custom agent definitions (mira.json "agents") — merged over built-in templates */
  agents?: Record<string, AgentDefinition>
  /** Auto-model routing (Kilo K8) */
  autoModel?: { enabled?: boolean; tier?: 'cheap' | 'balanced' | 'max' }
  /** Cost cap per task/session in USD (Kilo K8) */
  costCap?: { perTask?: number; perSession?: number }
  /** Roadmap metadata (REVISE) — passthrough, not validated */
  roadmap?: Record<string, JsonValue>
  /** Feature flags for lane contracts etc. */
  features?: Record<string, boolean>
  /** Tool-layer settings */
  tools?: Record<string, JsonValue>
  /** Skills v2 settings */
  skills?: Record<string, JsonValue>
}

/** User-supplied agent definition; missing fields fall back to safe defaults. */
export interface AgentDefinition {
  system: string
  description?: string
  tools?: string[]
  permissions?: 'readonly' | 'standard' | 'elevated'
  /** per-agent model override (Kilo K1: ask=cheap, code=opus) */
  model?: string
}

export type { MCPServerConfig } from '../../../shared/src/schemas/config.js'
// Re-export for convenience — single source of truth is shared/src/schemas/config.ts
export interface LegacyMCPServerConfig {
  type: 'local' | 'remote'
  command?: string[]
  url?: string
  enabled: boolean
  env?: Record<string, string>
  headers?: Record<string, string>
}

export interface ProviderConfig {
  npm?: string
  name: string
  options: {
    baseURL: string
    apiKey: string | string[]
    headers?: Record<string, string>
    timeout?: number
    kind?: string
  }
  models: Record<string, { name: string; limit: { context: number; output: number } }>
}

export interface RoutingConfig {
  aliases?: Record<string, string>
  fallbacks?: string[]
  defaultProvider?: string
  lanes?: Record<string, string>
}

export interface SubgatewayConfig {
  provider?: string
  model?: string
  fallback?: string[]
  rateLimit?: { rps?: number; burst?: number }
  costCap?: { perTask?: number; perSession?: number }
  retry?: { maxAttempts?: number; baseMs?: number; maxMs?: number }
  timeout?: number
  circuitBreaker?: { failureThreshold?: number; resetTimeoutMs?: number }
  enabled?: boolean
}
