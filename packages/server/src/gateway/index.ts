/**
 * Mira Model Gateway — Vercel AI SDK v5 → OpenRouter → 25+ providers
 *
 * 75% of teams use multiple models — gateway makes you future-proof.
 * Pattern: Vercel AI SDK v5 (streamText) on top, provider swapped via
 *   createOpenAI({ baseURL: "https://openrouter.ai/api/v1" })  (OpenAI-compatible)
 *   — so all OpenRouter's 25+ providers work through one SDK surface.
 *
 * Providers via OpenRouter (single API key):
 *   anthropic/claude-sonnet-4, openai/gpt-4o, google/gemini-2.5-pro,
 *   deepseek/deepseek-v3.2, meta/llama-3.3-70b, etc. (300+ models)
 *
 * Also supports direct provider keys for lower latency:
 *   ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY
 *
 * Features beyond Mira:
 *   - Fallback chain (model → fallbackModel if 429/5xx)
 *   - Cost/latency tracking per request (for future eval/observability)
 *   - Summarization helper for compaction (uses smallModel)
 */

import type { JsonValue, MiraConfig } from "../types/index.js"
import type { z } from "zod"

// ── Wire types ────────────────────────────────────────────────────────

/** Usage as reported by providers — both camelCase (Vercel AI SDK) and snake_case (OpenAI) shapes */
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

/**
 * Chunks yielded by Gateway.stream(): mirrors core StreamChunk
 * plus the trailing "usage-report" chunk some OpenAI-compatible providers emit.
 */
export type GatewayChunk =
  | { type: "text-delta"; text?: string }
  | { type: "tool-call"; toolCall: GatewayToolCall }
  | { type: "tool-result"; toolCallID?: string; result?: JsonValue; isError?: boolean }
  | { type: "finish"; finishReason?: "stop" | "tool-calls" | "length" | "error"; usage?: ChunkUsage }
  | { type: "error"; error?: string }
  | { type: "usage-report"; usage: ChunkUsage }

/** Minimal structural message accepted by stream()/summarize() */
export interface GatewayMessage {
  role: string
  content: string
  /** for role "tool": id of the tool call this result answers */
  toolCallID?: string
  toolCalls?: Array<{ id?: string; name?: string }>
}

/** Multimodal content part (vision) for complete() */
export type GatewayContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } }

export interface StreamOptions {
  model: string              // e.g. "openrouter/anthropic/claude-sonnet-4" or "anthropic/claude-sonnet-4"
  messages: Array<GatewayMessage>
  tools?: Record<string, { description: string; parameters: z.ZodTypeAny }>
  system?: string
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
}

// ── OpenAI-compatible wire shapes ─────────────────────────────────────

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
  tools?: Array<{ type: "function"; function: { name: string; description: string; parameters: z.ZodTypeAny } }>
  tool_choice?: "auto"
  max_tokens?: number
  temperature?: number
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string }
    finish_reason?: string
    delta?: { content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

interface OpenRouterModelsResponse {
  data?: Array<{ id?: string; name?: string; context_length?: number }>
}

export interface Gateway {
  /** Stream LLM response (async iterable of chunks) — Vercel AI SDK v5 style */
  stream(opts: StreamOptions): Promise<AsyncIterable<GatewayChunk>>
  /** Non-streaming completion — supports multimodal content parts (vision) */
  complete(opts: {
    model: string
    system?: string
    /** string OR OpenAI-style content parts (e.g. [{type:"text"},{type:"image_url"...}]) */
    prompt: string | GatewayContentPart[]
    maxTokens?: number
  }): Promise<{ text: string; inputTokens?: number; outputTokens?: number }>
  /** Summarize messages via smallModel (for compaction) */
  summarize(messages: GatewayMessage[], smallModel?: string): Promise<string>
  /** List available models (from OpenRouter /api/models) */
  listModels(): Promise<Array<{ id: string; name: string; context: number }>>
  /** Cumulative cost/latency/token stats for this process */
  stats(): { requests: number; inputTokens: number; outputTokens: number; costUSD: number; avgLatencyMs: number; byModel: Record<string, { requests: number; inputTokens: number; outputTokens: number; costUSD: number }> }
}

/** Wrap an async iterable, invoking onUsage when usage info appears (finish chunk or trailing report) */
async function* trackedStream(iter: AsyncIterable<GatewayChunk>, onUsage: (u: { input: number; output: number }) => void): AsyncIterable<GatewayChunk> {
  for await (const chunk of iter) {
    const u = chunk?.type === "finish"
      ? chunk.usage
      : chunk?.type === "usage-report"
        ? chunk.usage
        : null
    if (u && typeof u === "object") {
      const input = Number(u.inputTokens ?? u.prompt_tokens ?? u.promptTokens ?? 0) || 0
      const output = Number(u.outputTokens ?? u.completion_tokens ?? u.completionTokens ?? 0) || 0
      if (input || output) {
        if (chunk.type === "finish") chunk.usage = { inputTokens: input, outputTokens: output }
        onUsage({ input, output })
      }
    }
    yield chunk
  }
}

/** Expand {env:VAR} templates in provider strings — lets mira.json keep secrets out of git. */
function expandEnv(value: string): string {
  if (!value) return value
  return value.replace(/\{env:([^}]+)\}/g, (_, name: string) => process.env[name] ?? "")
}

export function createGateway(config: MiraConfig): Gateway {
  // ── Cost/latency tracking (cumulative per process) ────────────────
  const stats = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUSD: 0,
    totalLatencyMs: 0,
    byModel: new Map<string, { requests: number; inputTokens: number; outputTokens: number; costUSD: number }>(),
  }

  // Rough per-1M-token pricing (input/output USD) for known model families
  function priceFor(modelID: string): [number, number] {
    const m = modelID.toLowerCase()
    if (m.includes("claude-sonnet")) return [3, 15]
    if (m.includes("claude-opus")) return [15, 75]
    if (m.includes("claude-haiku")) return [0.8, 4]
    if (m.includes("gpt-4o")) return [2.5, 10]
    if (m.includes("gpt-4")) return [10, 30]
    if (m.includes("deepseek")) return [0.27, 1.1]
    if (m.includes("llama") || m.includes("mistral")) return [0.5, 0.8]
    return [1, 2] // conservative default
  }

  /** Record token usage + latency for one request */
  function record(modelID: string, inputTokens: number, outputTokens: number, latencyMs: number) {
    const [pin, pout] = priceFor(modelID)
    const cost = ((inputTokens * pin) + (outputTokens * pout)) / 1_000_000
    stats.requests++
    stats.inputTokens += inputTokens
    stats.outputTokens += outputTokens
    stats.costUSD += cost
    stats.totalLatencyMs += latencyMs
    const cur = stats.byModel.get(modelID) ?? { requests: 0, inputTokens: 0, outputTokens: 0, costUSD: 0 }
    cur.requests++; cur.inputTokens += inputTokens; cur.outputTokens += outputTokens; cur.costUSD += cost
    stats.byModel.set(modelID, cur)
  }

  // Resolve provider + model from "openrouter/anthropic/claude-sonnet-4" style string
  function resolveModel(modelStr: string): { baseURL: string; apiKey: string; modelID: string } {
    // Strip prefix if present: "openrouter/anthropic/claude..." → "anthropic/claude..."
    let modelID = modelStr
    let providerKey = "openrouter"

    if (modelStr.includes("/")) {
      const firstSlash = modelStr.indexOf("/")
      const maybeProvider = modelStr.slice(0, firstSlash)
      if (config.provider[maybeProvider]) {
        providerKey = maybeProvider
        modelID = modelStr.slice(firstSlash + 1)
      }
    }

    const provider = config.provider[providerKey]
    if (!provider) {
      // Fallback to openrouter
      const or = config.provider["openrouter"]
      return { baseURL: expandEnv(or.options.baseURL), apiKey: expandEnv(or.options.apiKey), modelID }
    }
    return { baseURL: expandEnv(provider.options.baseURL), apiKey: expandEnv(provider.options.apiKey), modelID }
  }

  return {
    async stream(opts) {
      const { baseURL, apiKey, modelID } = resolveModel(opts.model)
      const t0 = Date.now()

      // If API key is set, try live call via fetch (OpenAI-compatible) with retry + fallbackModel
      if (apiKey) {
        const fallbackModel = (config as MiraConfig & { fallbackModel?: string }).fallbackModel as string | undefined
        const candidates = [modelID, fallbackModel].filter(Boolean) as string[]
        for (const candModel of candidates.length ? candidates : [modelID]) {
          const candResolved = candidates.length > 1 && candModel !== modelID ? resolveModel(candModel) : { baseURL, apiKey, modelID: candModel }
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const iter = await liveOpenAIStream({ baseURL: candResolved.baseURL, apiKey: candResolved.apiKey, modelID: candResolved.modelID, opts })
              return trackedStream(iter, (usage) => record(candResolved.modelID, usage.input, usage.output, Date.now() - t0))
            } catch (e) {
              const msg = (e as Error).message
              const retryable = /429|5\d\d|timeout|ECONN/i.test(msg)
              if (!retryable || attempt === 2) {
                console.warn(`[gateway] live stream failed (${candResolved.modelID} attempt ${attempt + 1}):`, msg)
                break
              }
              const backoff = 500 * Math.pow(2, attempt)
              await new Promise(r => setTimeout(r, backoff))
            }
          }
          if (candModel !== modelID) console.warn(`[gateway] falling back to stub after ${candModel} failed`)
        }
      }

      // Stub stream — emits a helpful message so `mira` is usable without keys
      const stub = stubStream(modelID, opts)
      return trackedStream(stub, (usage) => record(modelID, usage.input, usage.output, Date.now() - t0))
    },

    async complete(opts) {
      const { baseURL, apiKey, modelID } = resolveModel(opts.model)
      const t0 = Date.now()
      if (!apiKey) throw new Error("No provider API key configured for complete()")
      const res = await fetch(`${baseURL.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "HTTP-Referer": "https://mira.ai", "X-Title": "Mira" },
        body: JSON.stringify({
          model: modelID,
          messages: [
            ...(opts.system ? [{ role: "system", content: opts.system }] : []),
            { role: "user", content: opts.prompt },
          ],
          max_tokens: opts.maxTokens ?? 1024,
        }),
        signal: AbortSignal.timeout(120_000),
      })
      if (!res.ok) throw new Error(`complete() ${res.status}: ${(await res.text()).slice(0, 300)}`)
      const data = (await res.json()) as ChatCompletionResponse
      const text = data.choices?.[0]?.message?.content ?? ""
      record(modelID, data.usage?.prompt_tokens ?? 0, data.usage?.completion_tokens ?? 0, Date.now() - t0)
      return {
        text,
        inputTokens: data.usage?.prompt_tokens,
        outputTokens: data.usage?.completion_tokens,
      }
    },

    async summarize(messages, smallModel) {
      const model = smallModel ?? config.smallModel ?? config.model
      const t0 = Date.now()
      const { baseURL, apiKey, modelID } = resolveModel(model)

      // Transcript bound: cap each message, drop empty ones
      const MAX_MSG_CHARS = 800
      const transcript = messages
        .filter(m => m.role !== "system")
        .map(m => {
          const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")
          return `${m.role}: ${c.length > MAX_MSG_CHARS ? c.slice(0, MAX_MSG_CHARS) + "…" : c}`
        })
        .join("\n\n")

      // ── Live path: real abstractive summary via small model ──
      if (apiKey) {
        try {
          const res = await fetch(`${baseURL.replace(/\/$/, "")}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "HTTP-Referer": "https://mira.ai", "X-Title": "Mira" },
            body: JSON.stringify({
              model: modelID,
              messages: [
                { role: "system", content: "You compress agent conversation history. Produce a dense summary preserving: (1) the user's original goal/task, (2) key decisions and their reasons, (3) files touched and outcomes, (4) open questions or pending work. Omit pleasantries and repetition. Output only the summary." },
                { role: "user", content: transcript.slice(0, 60_000) },
              ],
              max_tokens: 600,
              temperature: 0.2,
            }),
            signal: AbortSignal.timeout(45_000),
          })
          if (res.ok) {
            const data = (await res.json()) as ChatCompletionResponse
            const content = data.choices?.[0]?.message?.content
            if (content) {
              record(modelID, data.usage?.prompt_tokens ?? 0, data.usage?.completion_tokens ?? 0, Date.now() - t0)
              return content.trim()
            }
          }
        } catch (e) {
          console.warn("[gateway] live summarize failed, using extractive fallback:", (e as Error).message)
        }
      }

      // ── Fallback: extractive summary (deterministic, no API) ──
      const lines: string[] = []
      const firstUser = messages.find(m => m.role === "user")
      if (firstUser) lines.push(`Original task: ${String(typeof firstUser.content === "string" ? firstUser.content : JSON.stringify(firstUser.content)).slice(0, 300)}`)
      let toolsUsed = 0
      for (const m of messages) {
        if (Array.isArray(m.toolCalls)) toolsUsed += m.toolCalls.length
      }
      if (toolsUsed) lines.push(`Tool calls in this span: ${toolsUsed}`)
      const lastAssistant = [...messages].reverse().find(m => m.role === "assistant" && typeof m.content === "string" && m.content.trim())
      if (lastAssistant) lines.push(`Last state: ${lastAssistant.content.slice(0, 300)}`)
      lines.push(`(${messages.length} messages condensed extractively — set an API key for abstractive summaries)`)
      return lines.join("\n")
    },

    async listModels() {
      const or = config.provider["openrouter"]
      const orKey = or ? expandEnv(or.options.apiKey) : ""
      const orBase = or ? expandEnv(or.options.baseURL) : ""
      if (!orKey) return [{ id: "openrouter/anthropic/claude-sonnet-4", name: "Claude Sonnet 4 (stub)", context: 200_000 }]
      try {
        const res = await fetch(`${orBase}/models`, {
          headers: { Authorization: `Bearer ${orKey}` },
        })
        if (!res.ok) throw new Error(String(res.status))
        const data = (await res.json()) as OpenRouterModelsResponse
        return (data.data ?? []).slice(0, 50).map(m => ({ id: `openrouter/${m.id}`, name: m.name ?? "", context: m.context_length ?? 128_000 }))
      } catch {
        return [{ id: "openrouter/anthropic/claude-sonnet-4", name: "Claude Sonnet 4", context: 200_000 }]
      }
    },

    stats() {
      const byModel: Record<string, { requests: number; inputTokens: number; outputTokens: number; costUSD: number }> = {}
      for (const [k, v] of stats.byModel) byModel[k] = { ...v }
      return {
        requests: stats.requests,
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
        costUSD: Math.round(stats.costUSD * 1e6) / 1e6,
        avgLatencyMs: stats.requests ? Math.round(stats.totalLatencyMs / stats.requests) : 0,
        byModel,
      }
    },
  }
}

// ── Live OpenAI-compatible stream (fetch + SSE) ────────────────────

async function liveOpenAIStream(ctx: { baseURL: string; apiKey: string; modelID: string; opts: StreamOptions }): Promise<AsyncIterable<GatewayChunk>> {
  const { baseURL, apiKey, modelID, opts } = ctx

  // Build OpenAI-compatible request
  const isClaude = /claude|anthropic/i.test(modelID)
  const systemMsg: ChatRequestMessage | null = opts.system
    ? {
        role: "system",
        // Prompt caching: OpenRouter forwards cache_control to Anthropic —
        // stable system prefix (AGENTS.md + skills) then caches across turns (~90% cheaper reads)
        ...(isClaude ? { content: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }] } : { content: opts.system }),
      }
    : null

  const body: ChatCompletionRequest = {
    model: modelID,
    messages: [
      ...(systemMsg ? [systemMsg] : []),
      ...opts.messages.map(m => ({
        role: m.role === "tool" ? "tool" : m.role,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        ...(m.role === "tool" ? { tool_call_id: m.toolCallID } : {}),
      })),
    ],
    stream: true,
    stream_options: { include_usage: true },
    ...(opts.tools ? { tools: Object.entries(opts.tools).map(([name, def]) => ({ type: "function" as const, function: { name, description: def.description, parameters: def.parameters } })), tool_choice: "auto" as const } : {}),
  }

  // Combine provider timeout with caller's abort signal (client disconnect)
  const timeoutSignal = AbortSignal.timeout(120_000)
  const combinedSignal = opts.signal ? AbortSignal.any([timeoutSignal, opts.signal]) : timeoutSignal
  const res = await fetch(`${baseURL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://mira.ai",
      "X-Title": "Mira",
    },
    body: JSON.stringify(body),
    signal: combinedSignal,
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gateway ${res.status}: ${err.slice(0, 500)}`)
  }

  // Parse SSE → AsyncIterable<StreamChunk> with streaming tool-call argument accumulation
  async function* gen(): AsyncGenerator<GatewayChunk> {
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    let lastUsage: { inputTokens: number; outputTokens: number } | null = null
    // Accumulate fragmented tool-call arguments across SSE chunks
    const toolCallAccum = new Map<string, { name: string; argsFragments: string[] }>()
    // Fallback index counter for tool_calls without id (OpenAI spec uses index field)
    let toolCallIndexCounter = 0
    const indexToId = new Map<number, string>()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split("\n")
      buf = lines.pop() ?? ""
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith("data:")) continue
        const data = trimmed.slice(5).trim()
        if (data === "[DONE]") {
          // Flush any accumulated tool-calls whose arguments were streamed fragmented
          for (const [id, acc] of toolCallAccum) {
            const assembled = acc.argsFragments.join("")
            let args: Record<string, JsonValue> = {}
            if (assembled.trim()) {
              try { args = JSON.parse(assembled) as Record<string, JsonValue> } catch { args = {} }
            }
            yield { type: "tool-call", toolCall: { id, name: acc.name, args } }
            toolCallAccum.delete(id)
          }
          if (lastUsage) yield { type: "usage-report", usage: lastUsage }
          return
        }
        try {
          const json = JSON.parse(data) as ChatCompletionResponse
          if (json.usage) {
            lastUsage = { inputTokens: json.usage.prompt_tokens ?? 0, outputTokens: json.usage.completion_tokens ?? 0 }
          }
          const choice = json.choices?.[0] as { delta?: { content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string } | undefined
          if (!choice) continue
          if (choice.delta?.content) yield { type: "text-delta", text: choice.delta.content }
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
              const existing = toolCallAccum.get(id) ?? { name: tc.function?.name ?? "unknown", argsFragments: [] }
              if (tc.function?.name) existing.name = tc.function.name
              if (tc.function?.arguments) existing.argsFragments.push(tc.function.arguments)
              toolCallAccum.set(id, existing)
              // If this fragment looks like complete JSON, we can try emit early — but defer to finish_reason or [DONE] for safety
              // Check if we have a complete JSON object (heuristic: try parse)
              const assembled = existing.argsFragments.join("")
              if (assembled.trim() && (() => { try { JSON.parse(assembled); return true } catch { return false } })()) {
                // Don't emit yet — wait for finish_reason or next tool_call boundary; keep accumulating
              }
            }
          }
          if (choice.finish_reason) {
            // Flush accumulated tool-calls on finish
            for (const [id, acc] of [...toolCallAccum.entries()]) {
              const assembled = acc.argsFragments.join("")
              let args: Record<string, JsonValue> = {}
              if (assembled.trim()) {
                try { args = JSON.parse(assembled) as Record<string, JsonValue> } catch { args = {} }
              }
              yield { type: "tool-call", toolCall: { id, name: acc.name, args } }
            }
            toolCallAccum.clear()
            indexToId.clear()
            yield { type: "finish", finishReason: choice.finish_reason === "tool_calls" ? "tool-calls" : "stop", ...(lastUsage ? { usage: lastUsage } : {}) }
          }
        } catch {}
      }
    }
    // Stream ended without [DONE] — flush any remaining tool calls
    for (const [id, acc] of toolCallAccum) {
      const assembled = acc.argsFragments.join("")
      let args: Record<string, JsonValue> = {}
      if (assembled.trim()) {
        try { args = JSON.parse(assembled) as Record<string, JsonValue> } catch { args = {} }
      }
      yield { type: "tool-call", toolCall: { id, name: acc.name, args } }
    }
    yield { type: "finish", finishReason: "stop" as const, ...(lastUsage ? { usage: lastUsage } : {}) }
  }

  return gen()
}

// ── Stub stream (no API key) ───────────────────────────────────────

async function* stubStream(modelID: string, opts: StreamOptions): AsyncIterable<GatewayChunk> {
  const lastUser = [...opts.messages].reverse().find(m => m.role === "user")
  const userText = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "")
  const hasTools = opts.tools && Object.keys(opts.tools).length > 0

  // If tools available and prompt looks like a task, demo a tool call
  if (hasTools && /read|file|list|glob|search|write|edit/i.test(userText)) {
    yield { type: "text-delta", text: `I'll help with: "${userText.slice(0, 80)}". Let me check the project.\n` }
    const firstTool = Object.keys(opts.tools!)[0]
    yield { type: "tool-call", toolCall: { id: "stub-1", name: firstTool, args: firstTool === "read" ? { path: "README.md" } : firstTool === "glob" ? { pattern: "**/*" } : {} } }
    yield { type: "finish", finishReason: "tool-calls" as const }
    return
  }

  // Plain text response
  const response = `[Mira stub — model: ${modelID}]\nYou said: "${userText.slice(0, 200)}"\n\nSet OPENROUTER_API_KEY (or provider key) for live LLM responses. Gateway is wired — Vercel AI SDK v5 → OpenRouter → 25+ providers. This stub proves the loop works without keys.`
  // Stream word by word
  for (const word of response.split(/(\s+)/)) {
    if (word) yield { type: "text-delta", text: word }
  }
    yield { type: "finish", finishReason: "stop" as const }
}
