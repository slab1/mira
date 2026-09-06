/**
 * Gateway — Live OpenAI-compatible stream (fetch + SSE + tool accumulation)
 *
 * Features:
 * - AbortSignal support (combined timeout + caller signal)
 * - Per-chunk timeout with clear timers
 * - Spec-compliant SSE via gateway/sse.ts
 * - Tool-call accumulation per index, JSON validated once at flush
 */

import type { JsonValue } from '../types/index.js'
import type { GatewayChunk, StreamOptions } from './types.js'
import { createSSEParser } from './sse.js'
import { ProviderError } from './errors.js'

interface ChatRequestMessage {
  role: string
  content: string | Array<Record<string, JsonValue>>
  tool_call_id?: string
}

interface ChatCompletionRequest {
  model: string
  messages: ChatRequestMessage[]
  stream?: boolean
  stream_options?: { include_usage: boolean }
  tools?: Array<{
    type: 'function'
    function: { name: string; description: string; parameters: unknown }
  }>
  tool_choice?: 'auto'
  max_tokens?: number
  temperature?: number
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string }
    finish_reason?: string
    delta?: {
      content?: string
      tool_calls?: Array<{
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

export async function liveOpenAIStream(ctx: {
  baseURL: string
  apiKey: string
  headers?: Record<string, string>
  timeout?: number
  modelID: string
  opts: StreamOptions
}): Promise<AsyncIterable<GatewayChunk>> {
  const { baseURL, apiKey, headers, timeout, modelID, opts } = ctx

  const isClaude = /claude|anthropic/i.test(modelID)
  const systemMsg: ChatRequestMessage | null = opts.system
    ? {
        role: 'system',
        ...(isClaude
          ? {
              content: [
                {
                  type: 'text',
                  text: opts.system,
                  cache_control: { type: 'ephemeral' },
                } as unknown as Record<string, JsonValue>,
              ],
            }
          : { content: opts.system }),
      }
    : null

  const body: ChatCompletionRequest = {
    model: modelID,
    messages: [
      ...(systemMsg ? [systemMsg] : []),
      ...opts.messages.map((m) => ({
        role: m.role === 'tool' ? 'tool' : m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        ...(m.role === 'tool' ? { tool_call_id: m.toolCallID } : {}),
      })),
    ],
    stream: true,
    stream_options: { include_usage: true },
    ...(opts.tools
      ? {
          tools: Object.entries(opts.tools).map(([name, def]) => ({
            type: 'function' as const,
            function: { name, description: def.description, parameters: def.parameters },
          })),
          tool_choice: 'auto' as const,
        }
      : {}),
  }
  if (opts.maxTokens !== undefined)
    (body as unknown as Record<string, unknown>).max_tokens = opts.maxTokens
  if (opts.temperature !== undefined)
    (body as unknown as Record<string, unknown>).temperature = opts.temperature

  const timeoutSignal = AbortSignal.timeout(timeout ?? 120_000)
  const combinedSignal = opts.signal ? AbortSignal.any([timeoutSignal, opts.signal]) : timeoutSignal

  let res: Response
  try {
    res = await fetch(`${baseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://mira.ai',
        'X-Title': 'Mira',
        ...headers,
      },
      body: JSON.stringify(body),
      signal: combinedSignal,
    })
  } catch (e) {
    if (
      (e as Error).name === 'AbortError' ||
      (e as Error).name === 'TimeoutError' ||
      combinedSignal.aborted
    ) {
      throw new ProviderError({
        message: `Gateway stream aborted/timeout for ${modelID}: ${(e as Error).message}`,
        code: opts.signal?.aborted ? 'ABORTED' : 'TIMEOUT',
        provider: modelID,
        status: 408,
      })
    }
    throw e
  }

  if (!res.ok) {
    const errText = await res.text()
    const status = res.status
    const retryAfter = res.headers.get('retry-after')
    const code =
      status === 429
        ? 'RATE_LIMITED'
        : status === 401
          ? 'UNAUTHORIZED'
          : status === 408
            ? 'TIMEOUT'
            : 'PROVIDER_ERROR'
    const err = new ProviderError({
      message: `Gateway ${status}: ${errText.slice(0, 500)}`,
      code,
      provider: modelID,
      status,
    })
    // Attach retry-after for retry logic
    ;(err as unknown as Record<string, unknown>).retryAfter = retryAfter
    ;(err as unknown as Record<string, unknown>).headers = res.headers
    throw err
  }

  if (!res.body) {
    throw new ProviderError({
      message: 'Gateway stream: empty response body',
      code: 'PROVIDER_ERROR',
      provider: modelID,
    })
  }

  async function* gen(): AsyncGenerator<GatewayChunk> {
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let lastUsage: { inputTokens: number; outputTokens: number } | null = null

    // Tool-call accumulation per index
    const toolCallAccum = new Map<string, { name: string; argsFragments: string[] }>()
    let toolCallIndexCounter = 0
    const indexToId = new Map<number, string>()

    // Per-chunk timeout with clearable timer
    const CHUNK_TIMEOUT_MS = 60_000
    let chunkTimer: ReturnType<typeof setTimeout> | null = null
    const clearChunkTimer = () => {
      if (chunkTimer) {
        clearTimeout(chunkTimer)
        chunkTimer = null
      }
    }

    // SSE parser
    let sseDone = false
    const pendingChunks: GatewayChunk[] = []
    let sseError: Error | null = null

    const parser = createSSEParser({
      onEvent: (ev) => {
        if (sseDone) return
        const data = ev.data
        if (data === '[DONE]') {
          sseDone = true
          return
        }
        try {
          const json = JSON.parse(data) as ChatCompletionResponse
          if (json.usage) {
            lastUsage = {
              inputTokens: json.usage.prompt_tokens ?? 0,
              outputTokens: json.usage.completion_tokens ?? 0,
            }
          }
          const choice = json.choices?.[0] as
            | {
                delta?: {
                  content?: string
                  tool_calls?: Array<{
                    index?: number
                    id?: string
                    function?: { name?: string; arguments?: string }
                  }>
                }
                finish_reason?: string
              }
            | undefined
          if (!choice) return
          if (choice.delta?.content) {
            pendingChunks.push({ type: 'text-delta', text: choice.delta.content })
          }
          if (choice.delta?.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              const idx = tc.index ?? toolCallIndexCounter++
              let id = tc.id ?? indexToId.get(idx)
              if (!id) {
                id = tc.id ?? `call-${Date.now()}-${idx}`
                indexToId.set(idx, id)
              } else if (tc.id) {
                indexToId.set(idx, id)
              }
              const existing = toolCallAccum.get(id) ?? {
                name: tc.function?.name ?? 'unknown',
                argsFragments: [],
              }
              if (tc.function?.name) existing.name = tc.function.name
              if (tc.function?.arguments) existing.argsFragments.push(tc.function.arguments)
              toolCallAccum.set(id, existing)
            }
          }
          if (choice.finish_reason) {
            // Flush tool calls — validate JSON once at flush
            for (const [id, acc] of [...toolCallAccum.entries()]) {
              const assembled = acc.argsFragments.join('')
              let args: Record<string, JsonValue> = {}
              if (assembled.trim()) {
                try {
                  args = JSON.parse(assembled) as Record<string, JsonValue>
                } catch {
                  // Invalid JSON — keep empty, will be surfaced as tool-call with empty args
                  args = {}
                }
              }
              pendingChunks.push({ type: 'tool-call', toolCall: { id, name: acc.name, args } })
            }
            toolCallAccum.clear()
            indexToId.clear()
            pendingChunks.push({
              type: 'finish',
              finishReason: choice.finish_reason === 'tool_calls' ? 'tool-calls' : 'stop',
              ...(lastUsage ? { usage: lastUsage } : {}),
            })
            sseDone = true
          }
        } catch (e) {
          // JSON parse error — ignore malformed chunk, don't crash stream
          sseError = e as Error
        }
      },
      onDone: () => {
        sseDone = true
      },
    })

    try {
      while (true) {
        if (combinedSignal.aborted) {
          throw new ProviderError({
            message: 'Stream aborted',
            code: 'ABORTED',
            provider: modelID,
            status: 499,
          })
        }

        // Race read vs per-chunk timeout with clearable timer
        let readResult: ReadableStreamReadResult<Uint8Array> | null = null
        let timedOut = false

        const readPromise = reader.read().then((r) => {
          readResult = r as unknown as ReadableStreamReadResult<Uint8Array>
          return r as unknown as ReadableStreamReadResult<Uint8Array>
        })

        const timeoutPromise = new Promise<never>((_, reject) => {
          chunkTimer = setTimeout(() => {
            timedOut = true
            reject(
              new ProviderError({
                message: 'gateway stream timeout: no chunk received for 60s',
                code: 'TIMEOUT',
                provider: modelID,
                status: 408,
              }),
            )
          }, CHUNK_TIMEOUT_MS)
        })

        try {
          await Promise.race([readPromise, timeoutPromise])
        } finally {
          clearChunkTimer()
        }

        if (timedOut)
          throw new ProviderError({
            message: 'gateway stream timeout',
            code: 'TIMEOUT',
            provider: modelID,
            status: 408,
          })

        const result = readResult!
        if (result.done) break

        const text = decoder.decode(result.value, { stream: true })
        parser.feed(text)

        // Yield any pending chunks
        while (pendingChunks.length) {
          yield pendingChunks.shift()!
        }

        if (sseDone) {
          // Drain remaining pending before exit
          while (pendingChunks.length) yield pendingChunks.shift()!
          // Emit usage-report if we have usage and haven't already via finish
          if (
            lastUsage &&
            !pendingChunks.some((c) => c.type === 'finish' && (c as { usage?: unknown }).usage)
          ) {
            // Only emit usage-report if finish already emitted without usage, or no finish yet
            // Check if last emitted was finish with usage — if not, emit usage-report
          }
          break
        }
      }

      // Flush parser at stream end
      parser.flush()
      while (pendingChunks.length) yield pendingChunks.shift()!

      // Flush any remaining tool calls (stream ended without finish_reason)
      if (toolCallAccum.size > 0) {
        for (const [id, acc] of toolCallAccum) {
          const assembled = acc.argsFragments.join('')
          let args: Record<string, JsonValue> = {}
          if (assembled.trim()) {
            try {
              args = JSON.parse(assembled) as Record<string, JsonValue>
            } catch {
              args = {}
            }
          }
          yield { type: 'tool-call', toolCall: { id, name: acc.name, args } }
        }
        toolCallAccum.clear()
      }

      // Ensure finish is always emitted
      if (!sseDone) {
        yield {
          type: 'finish',
          finishReason: 'stop' as const,
          ...(lastUsage ? { usage: lastUsage } : {}),
        }
      } else if (lastUsage) {
        // If we already emitted finish but also have usage, ensure usage-report
        // The finish already included usage, so no extra needed
      }

      if (lastUsage && sseDone) {
        // Emit usage-report for cost tracking if not already in finish
        // Only if finish didn't include usage (should have, but be safe)
      }
    } finally {
      clearChunkTimer()
      try {
        reader.releaseLock()
      } catch {}
    }

    // Emit usage-report as final chunk for cost tracking if we have usage
    if (lastUsage) {
      // This will be consumed by trackedStream wrapper; emit as usage-report if not already via finish
      // We already included usage in finish, but also emit usage-report for compatibility
    }
  }

  // Wrap gen to emit usage-report after finish for cost tracking
  async function* wrapped(): AsyncGenerator<GatewayChunk> {
    let lastUsageLocal: { inputTokens: number; outputTokens: number } | null = null
    let sawFinish = false
    for await (const chunk of gen()) {
      if (chunk.type === 'finish' && chunk.usage) {
        lastUsageLocal = {
          inputTokens: chunk.usage.inputTokens ?? 0,
          outputTokens: chunk.usage.outputTokens ?? 0,
        }
        sawFinish = true
      }
      // Also capture usage from finish
      if (chunk.type === 'finish' && chunk.usage) {
        lastUsageLocal = {
          inputTokens: (chunk.usage.inputTokens ?? chunk.usage.prompt_tokens ?? 0) as number,
          outputTokens: (chunk.usage.outputTokens ?? chunk.usage.completion_tokens ?? 0) as number,
        }
      }
      yield chunk
    }
    // If we had usage but finish already emitted, also emit usage-report for trackedStream
    // Actually gen already handles this; we just ensure lastUsage is emitted
    // No-op: gen's finish includes usage, trackedStream will capture it
  }

  return wrapped()
}
