/**
 * Context compaction for long-running Mira sessions
 * 
 * Uses hierarchical summarization:
 * - Keep system prompt + recent context
 * - Summarize middle history with small model
 * - Preserve tool call boundaries
 * - Track compaction history to avoid double-compaction
 */

import type { JsonValue } from "../types/index.js"
import type { GatewayMessage } from "../gateway/index.js"
import type { Gateway } from "../gateway/index.js"

export interface CompactionOptions {
  threshold?: number // 0.8 = compact at 80% of limit
  keepTailRatio?: number // 0.25 = keep last 25%
  smallModel?: string
  contextLimit?: number // tokens
}

/** Minimal message shape accepted by compaction (superset of GatewayMessage) */
/** Minimal message shape accepted by compaction (superset of GatewayMessage) */
/** Minimal message shape accepted by compaction (superset of GatewayMessage) */
export interface CompactionMessage {
  role: string
  content: string
  toolCalls?: Array<{ id?: string; name?: string }>
  __meta?: { compacted?: true; originalCount?: number }
}

export interface CompactionResult {
  messages: CompactionMessage[]
  summary: string
  originalCount: number
  compactedCount: number
  tokenEstimate: number
}

let cachedEnc: { encode: (s: string) => number[] } | null = null
function getEnc(): { encode: (s: string) => number[] } | null {
  // js-tiktoken disabled for test stability — fallback to heuristic (len/4)
  // Enable by setting MIRA_TIKTOKEN=1 and ensuring js-tiktoken is installed
  if (process.env.MIRA_TIKTOKEN !== "1") return null
  if (cachedEnc) return cachedEnc
  try {
// @ts-ignore
    const { getEncoding } = (globalThis as JsonValue as { require: (m: string) => JsonValue }).require?.("js-tiktoken") as JsonValue as { getEncoding: (n: string) => { encode: (s: string) => number[] } } | undefined ?? {} as JsonValue
    if (getEncoding) {
      cachedEnc = getEncoding("cl100k_base")
      return cachedEnc
    }
  } catch {}
  return null
}

/**
 * Estimate token count from messages
 * Uses js-tiktoken cl100k_base when available, fallback to ~4 chars/token +10 overhead
 */
export function estimateTokens(messages: CompactionMessage[]): number {
  const enc = getEnc()
  return messages.reduce((total, m) => {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')
    const tokens = enc ? enc.encode(content).length : Math.ceil(content.length / 4)
    return total + tokens + 10
  }, 0)
}

/**
 * Check if compaction is needed
 */
export async function needsCompaction(
  messages: CompactionMessage[],
  contextLimit: number,
  threshold = 0.8
): Promise<{ needed: boolean; tokenEstimate: number; ratio: number }> {
  const tokenEstimate = estimateTokens(messages)
  const ratio = tokenEstimate / contextLimit
  return {
    needed: ratio > threshold,
    tokenEstimate,
    ratio,
  }
}

/**
 * Compact messages using summarization
 */
export async function compactMessages(
  gateway: Gateway,
  messages: CompactionMessage[],
  opts: CompactionOptions = {}
): Promise<CompactionResult> {
  const {
    keepTailRatio = 0.25,
    smallModel = 'openrouter/deepseek/deepseek-v3.2-exp',
    contextLimit = 128_000,
  } = opts

  if (messages.length <= 2) {
    return {
      messages,
      summary: '',
      originalCount: messages.length,
      compactedCount: messages.length,
      tokenEstimate: estimateTokens(messages),
    }
  }

  // Keep system messages separate
  const systemMessages = messages.filter(m => m.role === 'system')
  const conversation = messages.filter(m => m.role !== 'system')

  const keepCount = Math.max(1, Math.ceil(conversation.length * keepTailRatio))
  const tail = conversation.slice(-keepCount)
  const head = conversation.slice(0, conversation.length - keepCount)

  if (head.length === 0) {
    return {
      messages,
      summary: '',
      originalCount: messages.length,
      compactedCount: messages.length,
      tokenEstimate: estimateTokens(messages),
    }
  }

  // Build summarization prompt with context boundaries
  const summary = await gateway.summarize(head.filter(m => typeof m.content === "string") as GatewayMessage[], smallModel)

  const compacted: CompactionMessage[] = [
    ...systemMessages,
    {
      role: 'system',
      content: `## Conversation Summary (compacted at ${new Date().toISOString()})\n${summary}\n\n---\nThis summary replaces ${head.length} earlier messages.`,
      __meta: { compacted: true, originalCount: head.length }
    },
    ...tail,
  ]

  return {
    messages: compacted,
    summary,
    originalCount: messages.length,
    compactedCount: compacted.length,
    tokenEstimate: estimateTokens(compacted),
  }
}

/**
 * Progressive compaction for very long sessions
 * Performs multiple compaction passes if still too large
 */
export async function progressiveCompact(
  gateway: Gateway,
  messages: CompactionMessage[],
  opts: CompactionOptions = {}
): Promise<CompactionResult> {
  let current = messages
  let iterations = 0
  const maxIterations = 3

  while (iterations < maxIterations) {
    const { needed, tokenEstimate, ratio } = await needsCompaction(current, opts.contextLimit ?? 128_000, opts.threshold ?? 0.8)
    if (!needed) {
      return {
        messages: current,
        summary: '',
        originalCount: messages.length,
        compactedCount: current.length,
        tokenEstimate,
      }
    }
    const result = await compactMessages(gateway, current, {
      ...opts,
      keepTailRatio: Math.max(0.15, (opts.keepTailRatio ?? 0.25) - iterations * 0.05),
    })
    current = result.messages
    iterations++
  }

  return {
    messages: current,
    summary: '',
    originalCount: messages.length,
    compactedCount: current.length,
    tokenEstimate: estimateTokens(current),
  }
}

/**
 * Smart compaction that preserves tool call context
 */
export async function smartCompact(
  gateway: Gateway,
  messages: CompactionMessage[],
  opts: CompactionOptions = {}
): Promise<CompactionResult> {
  // Group messages into tool-call boundaries
  const toolBoundaries: number[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role === 'assistant' && m.toolCalls) {
      toolBoundaries.push(i)
    }
    if (m.role === 'tool') {
      toolBoundaries.push(i)
    }
  }

  // If we have tool boundaries, try to compact whole blocks
  if (toolBoundaries.length > 2) {
    const keepTail = Math.ceil(messages.length * (opts.keepTailRatio ?? 0.25))
    const cutoff = messages.length - keepTail
    
    // Find last tool boundary before cutoff
    let lastBoundary = cutoff
    for (let i = toolBoundaries.length - 1; i >= 0; i--) {
      if (toolBoundaries[i] < cutoff) {
        lastBoundary = toolBoundaries[i] + 1
        break
      }
    }
    
    const head = messages.slice(0, lastBoundary)
    const tail = messages.slice(lastBoundary)
    
    if (head.length > 1) {
      const summary = await gateway.summarize(head.filter(m => typeof m.content === "string") as GatewayMessage[], opts.smallModel)
      return {
        messages: [
          { role: 'system', content: `## Conversation Summary\n${summary}` },
          ...tail,
        ],
        summary,
        originalCount: messages.length,
        compactedCount: tail.length + 1,
        tokenEstimate: estimateTokens([...tail, { role: "user", content: summary }]),
      }
    }
  }

  // Fallback to standard compaction
  return compactMessages(gateway, messages, opts)
}
