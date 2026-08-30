/**
 * Mira Shared — Canonical TypeScript types
 *
 * Pure types with no runtime deps. Zod-inferred types live in schemas/*;
 * these are hand-written for places where Zod would be overkill (BusEvent generics, etc.)
 * or to provide stable imports without pulling zod.
 *
 * Server `src/types` re-exports from here in production.
 */
import type { PermissionAction, MiraConfig } from "../schemas/config.js"
import type { Session, Message, Part, Todo, Role, PartType, TodoStatus, TodoPriority, BusEvent, BusEventType } from "../schemas/session.js"
import type { ToolName, ToolCategory } from "../schemas/tools.js"
import type { Skill, AgentsContext } from "../agents/index.js"

export type {
  MiraConfig,
  PermissionAction,
  Session,
  Message,
  Part,
  Todo,
  Role,
  PartType,
  TodoStatus,
  TodoPriority,
  BusEvent,
  BusEventType,
  ToolName,
  ToolCategory,
  Skill,
  AgentsContext,
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue | undefined }

// ── Tool call/result (LLM ↔ registry boundary) ─────────────────────
export interface ToolCall {
  id: string
  name: ToolName | string
  args: JsonValue
}

export interface ToolResult {
  toolCallID: string
  name: string
  result: JsonValue
  isError?: boolean
}

// ── Model & streaming ──────────────────────────────────────────────
export interface ModelRef {
  provider: string // "openrouter" | "anthropic" | "openai" | ...
  modelID: string  // "anthropic/claude-sonnet-4" | "gpt-4o"
}

export interface StreamChunk {
  type: "text-delta" | "tool-call" | "tool-result" | "finish" | "error"
  text?: string
  toolCall?: ToolCall
  toolResult?: ToolResult
  finishReason?: "stop" | "tool-calls" | "length" | "error"
  usage?: { inputTokens: number; outputTokens: number }
}

// ── Session IDs (branded for safety) ───────────────────────────────
export type SessionID = string
export type MessageID = string
export type PartID = string

// ── Permission request (tool-layer guardrail) ──────────────────────
export interface PermissionRequest {
  sessionID: SessionID
  tool: string
  args: JsonValue
  pattern?: string // matched pattern, e.g. "bash:rm *"
}

// ── API envelopes ──────────────────────────────────────────────────
export interface ApiResponse<T> {
  ok: boolean
  data?: T
  error?: { message: string; code?: string }
}

export interface Paginated<T> {
  items: T[]
  total: number
  limit: number
  offset: number
}

// ── Re-export utility type: DeepPartial for config overrides ───────
export type DeepPartial<T> = T extends object ? { [P in keyof T]?: DeepPartial<T[P]> } : T
