/**
 * Mira Session Types
 * 
 * Type definitions for the session and prompt system.
 */

import type { JsonValue } from '../types/index.js'
import type { MiraDB } from '../storage/db.js'
import type { Bus } from '../bus/index.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { PermissionManager } from '../permission/index.js'
import type { Gateway } from '../gateway/index.js'
import type { GatewayRouter } from '../gateway/router.js'
import type { SubgatewayRegistry } from '../gateway/registry.js'

/** One turn-context message fed back into gateway.stream (loop working set). */
export interface LoopMessage {
  role: string
  content: string
  toolCalls?: Array<{ id: string; name: string; args: Record<string, JsonValue> }>
  toolResults?: Array<{ toolCallID: string; name: string; result: JsonValue; isError: boolean }>
  toolCallID?: string
  isExecutorContext?: boolean
}

/** Dependencies for SessionPrompt */
export interface SessionPromptDeps {
  db: MiraDB
  bus: Bus
  gateway: Gateway
  registry?: SubgatewayRegistry
  router?: GatewayRouter
  tools: ToolRegistry
  permissions: PermissionManager
  /** shared hierarchical memory (injected from learning system) */
  knowledge?: {
    retrieve(opts: {
      query: string
      limit?: number
    }): Promise<Array<{ id: string; title: string; content: string }>>
    /** utility feedback loop: id \u2208 [insight.id from online, parse id] */
    bumpUtility?: (id: string, delta: number) => void
  }
  /** usage learner (injected from learning system) */
  usage?: {
    recordTool(m: {
      tool: string
      durationMs: number
      isError: boolean
      errorKind?: string
      sessionID: string
      timestamp: number
    }): Promise<void>
    recordSession(m: {
      sessionID: string
      model: string
      steps: number
      totalTokensIn: number
      totalTokensOut: number
      latencyMs: number
      toolCalls: number
      toolErrors: number
      doomLoops: number
      compactionCount: number
      success?: boolean
      userFeedback?: string
      createdAt?: number
    }): Promise<void>
  }
}

/** Options for the loop */
export interface LoopOptions {
  sessionID?: string
  message?: string
  model?: string
  callerOwner?: string | null
  explicitModel?: string
  sessionModel?: string
  task?: string
  /** auto-compact when context > pct of model context window (default: 0.8) */
  compactionThreshold?: number
  /** max steps before auto-stop (default: 25) */
  maxSteps?: number
  /** max tokens in context window */
  contextLimit?: number
  /** custom system prompt (overrides config) */
  systemPrompt?: string
  /** agent to use for this session */
  agent?: string
  /** disable tool execution (read-only mode) */
  readOnly?: boolean
  /** skip guardrails checks */
  skipGuardrails?: boolean
  /** skip permission checks */
  skipPermissions?: boolean
  /** custom tool filter */
  toolFilter?: (name: string) => boolean
  /** custom memory context */
  memoryContext?: string
  /** signal for cancellation */
  signal?: AbortSignal
}

// Re-export for compatibility
export type { JsonValue, MiraDB }
