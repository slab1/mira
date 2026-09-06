/**
 * Gateway — Wire types
 */

import type { z } from 'zod'
import type { JsonValue } from '../types/index.js'

export type ChunkUsage = {
  inputTokens?: number
  outputTokens?: number
  promptTokens?: number
  completionTokens?: number
  prompt_tokens?: number
  completion_tokens?: number
}

export type GatewayToolCall = {
  id: string
  name: string
  args: Record<string, JsonValue>
}

export type GatewayChunk =
  | { type: 'text-delta'; text?: string }
  | { type: 'tool-call'; toolCall: GatewayToolCall }
  | { type: 'tool-result'; toolCallID?: string; result?: JsonValue; isError?: boolean }
  | {
      type: 'finish'
      finishReason?: 'stop' | 'tool-calls' | 'length' | 'error'
      usage?: ChunkUsage
    }
  | { type: 'error'; error?: string }
  | { type: 'usage-report'; usage: ChunkUsage }

export interface GatewayMessage {
  role: string
  content: string
  toolCallID?: string
  toolCalls?: Array<{ id?: string; name?: string }>
}

export type GatewayContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } }

export interface StreamOptions {
  model: string
  messages: Array<GatewayMessage>
  tools?: Record<string, { description: string; parameters: z.ZodTypeAny }>
  system?: string
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
}

export interface GatewayStats {
  requests: number
  inputTokens: number
  outputTokens: number
  costUSD: number
  avgLatencyMs: number
  byModel: Record<
    string,
    { requests: number; inputTokens: number; outputTokens: number; costUSD: number }
  >
}

export interface Gateway {
  stream(opts: StreamOptions): Promise<AsyncIterable<GatewayChunk>>
  complete(opts: {
    model: string
    system?: string
    prompt: string | GatewayContentPart[]
    maxTokens?: number
  }): Promise<{ text: string; inputTokens?: number; outputTokens?: number }>
  summarize(messages: GatewayMessage[], smallModel?: string): Promise<string>
  listModels(): Promise<Array<{ id: string; name: string; context: number }>>
  stats(): GatewayStats
}
