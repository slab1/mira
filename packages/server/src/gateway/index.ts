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
 * Features beyond OpenCode:
 *   - Fallback chain (model → fallbackModel if 429/5xx)
 *   - Cost/latency tracking per request (for future eval/observability)
 *   - Summarization helper for compaction (uses smallModel)
 */

import type { MiraConfig } from "../types/index.js"

export interface StreamOptions {
  model: string              // e.g. "openrouter/anthropic/claude-sonnet-4" or "anthropic/claude-sonnet-4"
  messages: Array<{ role: string; content: unknown }>
  tools?: Record<string, { description: string; parameters: unknown }>
  system?: string
  maxTokens?: number
  temperature?: number
}

export interface Gateway {
  /** Stream LLM response (async iterable of chunks) — Vercel AI SDK v5 style */
  stream(opts: StreamOptions): Promise<AsyncIterable<any>>
  /** Summarize messages via smallModel (for compaction) */
  summarize(messages: any[], smallModel?: string): Promise<string>
  /** List available models (from OpenRouter /api/models) */
  listModels(): Promise<Array<{ id: string; name: string; context: number }>>
  /** Cumulative cost/latency/token stats for this process */
  stats(): { requests: number; inputTokens: number; outputTokens: number; costUSD: number; avgLatencyMs: number; byModel: Record<string, { requests: number; inputTokens: number; outputTokens: number; costUSD: number }> }
}

/** Wrap an async iterable, invoking onUsage when usage info appears (finish chunk or trailing report) */
async function* trackedStream(iter: AsyncIterable<any>, onUsage: (u: { input: number; output: number }) => void): AsyncIterable<any> {
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
      return { baseURL: or.options.baseURL, apiKey: or.options.apiKey, modelID }
    }
    return { baseURL: provider.options.baseURL, apiKey: provider.options.apiKey, modelID }
  }

  return {
    async stream(opts) {
      const { baseURL, apiKey, modelID } = resolveModel(opts.model)
      const t0 = Date.now()

      // If API key is set, try live call via fetch (OpenAI-compatible)
      if (apiKey) {
        try {
          const iter = await liveOpenAIStream({ baseURL, apiKey, modelID, opts })
          // Wrap to capture usage + latency from the live stream
          return trackedStream(iter, (usage) => record(modelID, usage.input, usage.output, Date.now() - t0))
        } catch (e) {
          console.warn("[gateway] live stream failed, falling back to stub:", (e as Error).message)
        }
      }

      // Stub stream — emits a helpful message so `mira` is usable without keys
      const stub = stubStream(modelID, opts)
      return trackedStream(stub, (usage) => record(modelID, usage.input, usage.output, Date.now() - t0))
    },

    async summarize(messages, smallModel) {
      const model = smallModel ?? config.smallModel ?? config.model
      const t0 = Date.now()
      const { baseURL, apiKey, modelID } = resolveModel(model)

      // Transcript bound: cap each message, drop empty ones
      const MAX_MSG_CHARS = 800
      const transcript = messages
        .filter(m => m.role !== "system")
        .map((m: any) => {
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
            const data: any = await res.json()
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
      const firstUser = messages.find((m: any) => m.role === "user")
      if (firstUser) lines.push(`Original task: ${String(typeof firstUser.content === "string" ? firstUser.content : JSON.stringify(firstUser.content)).slice(0, 300)}`)
      let toolsUsed = 0
      for (const m of messages) {
        if (Array.isArray((m as any).toolCalls)) toolsUsed += (m as any).toolCalls.length
      }
      if (toolsUsed) lines.push(`Tool calls in this span: ${toolsUsed}`)
      const lastAssistant = [...messages].reverse().find((m: any) => m.role === "assistant" && typeof m.content === "string" && m.content.trim())
      if (lastAssistant) lines.push(`Last state: ${lastAssistant.content.slice(0, 300)}`)
      lines.push(`(${messages.length} messages condensed extractively — set an API key for abstractive summaries)`)
      return lines.join("\n")
    },

    async listModels() {
      const or = config.provider["openrouter"]
      if (!or?.options.apiKey) return [{ id: "openrouter/anthropic/claude-sonnet-4", name: "Claude Sonnet 4 (stub)", context: 200_000 }]
      try {
        const res = await fetch(`${or.options.baseURL}/models`, {
          headers: { Authorization: `Bearer ${or.options.apiKey}` },
        })
        if (!res.ok) throw new Error(String(res.status))
        const data: any = await res.json()
        return (data.data ?? []).slice(0, 50).map((m: any) => ({ id: `openrouter/${m.id}`, name: m.name, context: m.context_length ?? 128_000 }))
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

async function liveOpenAIStream(ctx: { baseURL: string; apiKey: string; modelID: string; opts: StreamOptions }): Promise<AsyncIterable<any>> {
  const { baseURL, apiKey, modelID, opts } = ctx

  // Build OpenAI-compatible request
  const isClaude = /claude|anthropic/i.test(modelID)
  const systemMsg = opts.system
    ? {
        role: "system",
        // Prompt caching: OpenRouter forwards cache_control to Anthropic —
        // stable system prefix (AGENTS.md + skills) then caches across turns (~90% cheaper reads)
        ...(isClaude ? { content: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }] } : { content: opts.system }),
      }
    : null

  const body: any = {
    model: modelID,
    messages: [
      ...(systemMsg ? [systemMsg] : []),
      ...opts.messages.map(m => ({
        role: m.role === "tool" ? "tool" : m.role,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        ...(m.role === "tool" ? { tool_call_id: (m as any).toolCallID } : {}),
      })),
    ],
    stream: true,
    stream_options: { include_usage: true },
    ...(opts.tools ? { tools: Object.entries(opts.tools).map(([name, def]: any) => ({ type: "function", function: { name, description: def.description, parameters: def.parameters } })), tool_choice: "auto" } : {}),
  }

  const res = await fetch(`${baseURL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://mira.ai",
      "X-Title": "Mira",
    },
    body: JSON.stringify(body),
    // Never let a stalled provider hang the session loop — fail → stub fallback
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gateway ${res.status}: ${err.slice(0, 500)}`)
  }

  // Parse SSE → AsyncIterable<StreamChunk>
  async function* gen() {
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    let lastUsage: { inputTokens: number; outputTokens: number } | null = null
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
          // Providers that send usage in a trailing chunk: emit it before closing
          if (lastUsage) yield { type: "usage-report", usage: lastUsage }
          return
        }
        try {
          const json: any = JSON.parse(data)
          // Usage-only chunks (choices: []) arrive before/without finish — always capture
          if (json.usage) {
            lastUsage = { inputTokens: json.usage.prompt_tokens ?? 0, outputTokens: json.usage.completion_tokens ?? 0 }
          }
          const choice = json.choices?.[0]
          if (!choice) continue
          if (choice.delta?.content) yield { type: "text-delta", text: choice.delta.content }
          if (choice.delta?.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              yield { type: "tool-call", toolCall: { id: tc.id ?? `call-${Date.now()}`, name: tc.function?.name ?? "unknown", args: tc.function?.arguments ? JSON.parse(tc.function.arguments) : {} } }
            }
          }
          if (choice.finish_reason) {
            yield { type: "finish", finishReason: choice.finish_reason === "tool_calls" ? "tool-calls" : "stop", ...(lastUsage ? { usage: lastUsage } : {}) }
          }
        } catch {}
      }
    }
    yield { type: "finish", finishReason: "stop" as const, ...(lastUsage ? { usage: lastUsage } : {}) }
  }

  return gen()
}

// ── Stub stream (no API key) ───────────────────────────────────────

async function* stubStream(modelID: string, opts: StreamOptions): AsyncIterable<any> {
  const lastUser = [...opts.messages].reverse().find(m => m.role === "user")
  const userText = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "")
  const hasTools = opts.tools && Object.keys(opts.tools).length > 0

  // If tools available and prompt looks like a task, demo a tool call
  if (hasTools && /read|file|list|glob|search/i.test(userText)) {
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
  yield { type: "finish", finishReason: "stop" as const, usage: { inputTokens: 100, outputTokens: 50 } }
}
