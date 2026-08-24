/**
 * Mira SessionPrompt — The Core Loop
 *
 * OpenCode-inspired but better:
 *   LLM.stream → tool-call → execute → finish-step → doom-loop detection → compaction
 *
 * Key improvements over OpenCode:
 *   - Doom-loop detection is stateful & tool-aware (not just text repetition)
 *   - Compaction uses hierarchical memory (episodic → semantic) not just truncation
 *   - Guardrails at tool-layer (PermissionManager) not prompt-layer
 *   - Event-driven: every step publishes BusEvent → GlobalBus → Worker → RPC → TUI
 *
 * Flow:
 *   1. Persist user message (parts)
 *   2. Loop:
 *      a. Build context (messages + todos + system prompt), check compaction threshold
 *      b. gateway.stream(model, context, tools)  — Vercel AI SDK v5
 *      c. For each tool-call: permission.check → execute → persist tool-result part → bus publish
 *      d. finish-step: aggregate results, update message, check done?
 *      e. doom-loop: detect 3x identical tool-calls / 5x same file edit without progress → break + ask user
 *      f. compaction: if context > 80% window, summarize oldest 50% via smallModel
 *   3. Return final SSE stream
 */

import type { Bus } from "../bus/index.js"
import type { ToolRegistry } from "../tools/registry.js"
import type { PermissionManager } from "../permission/index.js"
import type { Gateway } from "../gateway/index.js"
import { buildSystemPrompt, getLoopLimits } from "../config/index.js"
import { DoomLoopDetector } from "./doom-loop-detector.js"
import { needsCompaction, compactMessages, estimateTokens } from "./compaction.js"
import { searchKnowledge } from "../learning/knowledge.js"
import { openFindingsForContext } from "../tools/findings.js"
import type { MiraDB } from "../storage/db.js"
import { loadSkills } from "../skills/loader.js"
import { AGENT_TEMPLATES } from "../agents/templates.js"
import { initLangfuse } from "../telemetry/langfuse.js"
import { eq } from "drizzle-orm"
import { trace as otelTrace } from "@opentelemetry/api"

// ── Types ──────────────────────────────────────────────────────────

export interface SessionPromptDeps {
  db: MiraDB
  bus: Bus
  gateway: Gateway
  tools: ToolRegistry
  permissions: PermissionManager
  /** shared hierarchical memory (injected from learning system) */
  knowledge?: { retrieve(opts: { query: string; limit?: number }): Promise<Array<{ title: string; content: string }>> }
  /** usage learner (injected from learning system) */
  usage?: {
    recordTool(m: { tool: string; durationMs: number; isError: boolean; errorKind?: string; sessionID: string; timestamp: number }): Promise<void>
    recordSession(m: { sessionID: string; model: string; steps: number; totalTokensIn: number; totalTokensOut: number; latencyMs: number; toolCalls: number; toolErrors: number; doomLoops: number; compactionCount: number; success: boolean; userFeedback?: "up" | "down" | null; createdAt: number }): Promise<void>
  }
}

export interface LoopOptions {
  maxSteps?: number        // default 32
  maxTokens?: number       // per-step
  compactionThreshold?: number // 0.8 = compact at 80% context
}

// ── SessionPrompt ──────────────────────────────────────────────────

export class SessionPrompt {
  private doomDetector = new DoomLoopDetector()
  /** Queues persist in SQLite (message_queue) — survive restarts */

  constructor(private deps: SessionPromptDeps) {}

  // ── Message queueing (OpenCode-parity UX) ─────────────────────────

  /** Queue a message while a turn is streaming; it runs right after. Persisted to SQLite. */
  queueMessage(sessionID: string, text: string): { position: number } {
    this.deps.db.sqlite
      .prepare(`INSERT INTO message_queue (id, session_id, text, created_at) VALUES (?, ?, ?, ?)`)
      .run(crypto.randomUUID(), sessionID, text, Date.now())
    const q = this.getQueue(sessionID)
    this.deps.bus.publish({ type: "session.updated", sessionID, payload: { queued: q.length }, timestamp: Date.now() })
    return { position: q.length }
  }

  getQueue(sessionID: string): string[] {
    try {
      return (this.deps.db.sqlite
        .prepare(`SELECT text FROM message_queue WHERE session_id = ? ORDER BY created_at, rowid`)
        .all(sessionID) as any[]).map(r => r.text)
    } catch { return [] }
  }

  clearQueue(sessionID: string): number {
    const n = this.getQueue(sessionID).length
    try { this.deps.db.sqlite.prepare(`DELETE FROM message_queue WHERE session_id = ?`).run(sessionID) } catch {}
    return n
  }

  /** Atomically pop the oldest queued message (drain head) */
  private dequeueFirst(sessionID: string): string | null {
    try {
      const row: any = this.deps.db.sqlite
        .prepare(`SELECT id, text FROM message_queue WHERE session_id = ? ORDER BY created_at, rowid LIMIT 1`)
        .get(sessionID)
      if (!row) return null
      this.deps.db.sqlite.prepare(`DELETE FROM message_queue WHERE id = ?`).run(row.id)
      return row.text
    } catch { return null }
  }

  // ── Session CRUD (delegated to storage) ──────────────────────────

  async createSession(input: { title?: string; model?: string; parentID?: string; agent?: keyof typeof AGENT_TEMPLATES; ownerID?: string | null }) {
    const id = crypto.randomUUID()
    const now = Date.now()
    // Subagent/fork children inherit the parent session's owner (multi-tenant)
    let ownerID = input.ownerID ?? null
    if (!ownerID && input.parentID) {
      try {
        const parent = await this.getSession(input.parentID)
        ownerID = (parent as any)?.ownerID ?? null
      } catch {}
    }
    const session = {
      id,
      title: input.title ?? (input.agent ? `${input.agent} session` : "New Session"),
      model: input.model ?? "openrouter/anthropic/claude-sonnet-4",
      provider: "openrouter",
      createdAt: now,
      updatedAt: now,
      parentID: input.parentID,
      agent: (input.agent && AGENT_TEMPLATES[input.agent] ? input.agent : null) as string | null,
      ownerID: ownerID as string | null,
    }
    await this.deps.db.insert(this.deps.db.schema.sessions).values(session)
    return session
  }

  async getSession(id: string) {
    return this.deps.db.query.sessions.findFirst({ where: (s: any, { eq }: any) => eq(s.id, id) })
  }

  async deleteSession(id: string) {
    await this.deps.db.delete(this.deps.db.schema.messages).where((m: any) => m.sessionID === id)
    await this.deps.db.delete(this.deps.db.schema.parts).where((p: any) => p.sessionID === id)
    await this.deps.db.delete(this.deps.db.schema.todos).where((t: any) => t.sessionID === id)
    await this.deps.db.delete(this.deps.db.schema.sessions).where((s: any) => s.id === id)
  }

  async getMessages(sessionID: string) {
    return this.deps.db.query.messages.findMany({
      where: (m: any, { eq }: any) => eq(m.sessionID, sessionID),
      with: { parts: true },
      orderBy: (m: any, { asc }: any) => [asc(m.createdAt)],
    })
  }

  async getTodos(sessionID: string) {
    return this.deps.db.query.todos.findMany({
      where: (t: any, { eq }: any) => eq(t.sessionID, sessionID),
    })
  }

  async setTodos(sessionID: string, todos: any[]) {
    // Replace todos for session
    await this.deps.db.delete(this.deps.db.schema.todos).where((t: any) => t.sessionID === sessionID)
    if (todos.length) {
      await this.deps.db.insert(this.deps.db.schema.todos).values(
        todos.map((t: any) => ({ ...t, id: t.id ?? crypto.randomUUID(), sessionID, createdAt: Date.now() }))
      )
    }
    return todos
  }

  // ── Session forking ───────────────────────────────────────────────

  /**
   * Fork a session: copy history (messages + parts) up to messageID into a
   * new child session. Enables branching exploration without losing the original.
   */
  async forkSession(opts: { sourceSessionID: string; messageID?: string; title?: string }): Promise<{ sessionID: string; copiedMessages: number }> {
    const source = await this.getSession(opts.sourceSessionID)
    if (!source) throw new Error("source session not found")
    const history = await this.getMessages(opts.sourceSessionID)

    // Slice at the fork point (inclusive of messageID if given)
    let selected = history as any[]
    if (opts.messageID) {
      const idx = selected.findIndex(m => m.id === opts.messageID)
      if (idx === -1) throw new Error(`message ${opts.messageID} not found in source session`)
      selected = selected.slice(0, idx + 1)
    }

    const fork = await this.createSession({
      title: opts.title ?? `${source.title} (fork)`,
      model: source.model,
      parentID: source.id,
      agent: source.agent ?? undefined,
    })

    const now = Date.now()
    for (const m of selected) {
      const newMessageID = crypto.randomUUID()
      await this.deps.db.insert(this.deps.db.schema.messages).values({
        id: newMessageID, sessionID: fork.id, role: m.role, createdAt: m.createdAt ?? now,
      })
      for (const p of (m.parts ?? []) as any[]) {
        const { id: _old, ...rest } = p
        await this.deps.db.insert(this.deps.db.schema.parts).values({
          id: crypto.randomUUID(), ...rest, messageID: newMessageID, sessionID: fork.id,
        })
      }
    }

    this.deps.bus.publish({ type: "session.created", payload: { ...fork, forkedFrom: source.id }, timestamp: now })
    return { sessionID: fork.id, copiedMessages: selected.length }
  }

  // ── Subagent spawning ─────────────────────────────────────────────

  /**
   * Run an isolated subagent session (used by the `task` tool).
   * Unlike ephemeral subagents elsewhere, Mira persists each subagent as a
   * real child session (parentID set) so users can inspect its full transcript.
   */
  async runSubagent(opts: {
    prompt: string
    parentID: string
    agent?: keyof typeof AGENT_TEMPLATES
    model?: string
    title?: string
  }): Promise<{ sessionID: string; text: string }> {
    const s = await this.createSession({
      title: opts.title ?? `↳ ${opts.prompt.slice(0, 48)}`,
      parentID: opts.parentID,
      agent: opts.agent,
      model: opts.model,
    })
    let text = ""
    // No-op sink: collect only the final text (no SSE transport needed)
    const send = (_event: string, data: unknown) => {
      const d = data as { text?: string }
      if (d?.text !== undefined) text = d.text
    }
    const noopWriter = { write: () => {}, close: async () => {} } as unknown as WritableStreamDefaultWriter<Uint8Array>
    try {
      await this.runLoop({
        sessionID: s.id,
        assistantMessageID: crypto.randomUUID(),
        userText: opts.prompt,
        model: opts.model ?? s.model,
        systemPrompt: await buildSystemPrompt(),
        send,
        writer: noopWriter,
        agent: opts.agent ?? s.agent,
      })
    } catch (err) {
      text = `[subagent error] ${String(err)}`
    }
    return { sessionID: s.id, text }
  }

  // ── The Loop ─────────────────────────────────────────────────────

  /**
   * streamResponse — Server-Sent Events stream for POST /session/:id/prompt
   *
   * Implements: LLM.stream → tool-call → execute → finish-step → doom-loop → compaction
   */
  async streamResponse(sessionID: string, userText: string, modelOverride?: string, options?: LoopOptions): Promise<Response> {
    const session = await this.getSession(sessionID)
    if (!session) throw new Error("session not found")

    const model = modelOverride ?? session.model
    const basePrompt = await buildSystemPrompt()
    // Agent persona (researcher/coder/reviewer) prepended when set on the session
    const persona = session.agent ? (AGENT_TEMPLATES as Record<string, { system: string }>)[session.agent]?.system : undefined
    const systemPrompt = persona ? `${persona}\n\n${basePrompt}` : basePrompt

    // Persist user message + part immediately (so TUI sees it via bus)
    const userMessageID = crypto.randomUUID()
    const now = Date.now()
    await this.deps.db.insert(this.deps.db.schema.messages).values({
      id: userMessageID, sessionID, role: "user", createdAt: now,
    })
    await this.deps.db.insert(this.deps.db.schema.parts).values({
      id: crypto.randomUUID(), messageID: userMessageID, sessionID,
      type: "text", text: userText, createdAt: now,
    })
    this.deps.bus.publish({ type: "message.created", sessionID, payload: { id: userMessageID, text: userText }, timestamp: now })
    this.deps.bus.publish({ type: "part.created", sessionID, payload: { text: userText }, timestamp: now })

    // Create assistant message placeholder
    const assistantMessageID = crypto.randomUUID()
    await this.deps.db.insert(this.deps.db.schema.messages).values({
      id: assistantMessageID, sessionID, role: "assistant", createdAt: Date.now(),
    })

    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()
    const encoder = new TextEncoder()

    const send = (event: string, data: unknown) => {
      const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
      writer.write(encoder.encode(line))
    }

    // Run loop in background (don't block response headers)
    this.runLoop({
      sessionID, assistantMessageID, userText, model, systemPrompt, send, writer,
      agent: session.agent,
      maxSteps: options?.maxSteps,
      compactionThreshold: options?.compactionThreshold,
    }).catch(async err => {
      console.error(`[mira] loop error (session ${sessionID}):`, err?.stack ?? err)
      send("error", { error: String(err) })
      try { await writer.close() } catch {}
    })

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    })
  }

  private async runLoop(opts: {
    sessionID: string
    assistantMessageID: string
    userText: string
    model: string
    systemPrompt: string
    send: (event: string, data: unknown) => void
    writer: WritableStreamDefaultWriter<Uint8Array>
    agent?: string | null
    maxSteps?: number
    compactionThreshold?: number
  }) {
    const { sessionID, assistantMessageID, model, systemPrompt, send, writer } = opts
    const tracer = otelTrace.getTracer('mira-server')
    const span = tracer.startSpan('session.prompt.loop', { attributes: { session_id: sessionID, prompt_id: assistantMessageID } })
    // Loop limits: explicit option > env/config (MIRA_MAX_STEPS etc.) > built-in default
    const limits = getLoopLimits()
    const MAX_STEPS = opts.maxSteps ?? limits.maxSteps
    let step = 0
    let accumulatedText = ""
    this.doomDetector.reset()
    const lf = initLangfuse()
    const trace = lf?.trace?.("session") ?? { update: (_data?: unknown) => {}, end: () => {} }
    // usage-learning counters for recordSession at finalize
    const t0 = Date.now()
    let toolCallCount = 0, toolErrorCount = 0, doomLoopCount = 0, compactionCount = 0
    let totalTokensIn = 0, totalTokensOut = 0

    // Load conversation history
    let messages = await this.loadContext(sessionID, systemPrompt)

    loop: while (step < MAX_STEPS) {
      step++

      // ── Compaction check ──
      const contextLimit = limits.contextLimit
      const threshold = opts.compactionThreshold ?? limits.compactionThreshold
      const { needed, tokenEstimate, ratio } = await needsCompaction(messages, contextLimit, threshold)
      if (needed) {
        send("compaction", { step, tokenEstimate, ratio })
        const result = await compactMessages(this.deps.gateway, messages, { smallModel: limits.smallModel, contextLimit, threshold })
        messages = result.messages
        compactionCount++
        this.deps.bus.publish({ type: "message.updated", sessionID, payload: { compaction: true, step, tokenEstimate, reducedTo: result.compactedCount }, timestamp: Date.now() })
      }

      // ── LLM.stream (Vercel AI SDK v5) ──
      send("step_start", { step, model })
      const stream = await this.deps.gateway.stream({
        model,
        messages,
        tools: this.filterToolsForAgent(opts.agent), // lane-contract enforcement (agent allowlist)
        system: systemPrompt,
      })

      let stepText = ""
      const toolCalls: Array<{ id: string; name: string; args: unknown }> = []

      for await (const chunk of stream) {
        if (chunk.type === "text-delta" && chunk.text) {
          stepText += chunk.text
          accumulatedText += chunk.text
          send("text_delta", { delta: chunk.text, step })

          // Persist incremental text part (for resume)
          await this.upsertTextPart(assistantMessageID, sessionID, accumulatedText)
          this.deps.bus.publish({ type: "part.updated", sessionID, payload: { text: chunk.text, step }, timestamp: Date.now() })

        } else if (chunk.type === "tool-call" && chunk.toolCall) {
          toolCalls.push(chunk.toolCall)
          send("tool_call", chunk.toolCall)
        } else if (chunk.type === "finish") {
          send("step_finish", { step, reason: chunk.finishReason, usage: chunk.usage })
          const u: any = (chunk as any).usage
          if (u) {
            totalTokensIn += Number(u.promptTokens ?? u.inputTokens ?? 0) || 0
            totalTokensOut += Number(u.completionTokens ?? u.outputTokens ?? 0) || 0
          }
          if (chunk.finishReason === "stop" && toolCalls.length === 0) {
            // Conversation turn complete — drain trailing chunks (e.g. usage-report)
            // so gateway cost tracking sees them, then exit the loop.
            for await (const tail of stream) {
              if ((tail as any).type === "usage-report") {
                const tu: any = (tail as any).usage
                if (tu) {
                  totalTokensIn += Number(tu.inputTokens ?? tu.prompt_tokens ?? 0) || 0
                  totalTokensOut += Number(tu.outputTokens ?? tu.completion_tokens ?? 0) || 0
                }
              }
            }
            break loop
          }
        } else if (chunk.type === "error") {
          send("error", chunk)
          break loop
        }
      }

      // ── No tool calls? We're done ──
      if (toolCalls.length === 0) break loop

      // ── Execute each tool-call ──
      const toolResults: any[] = []
      for (const tc of toolCalls) {
        // Doom-loop detection
        const loopSignal = this.doomDetector.check({ name: tc.name, args: tc.args })
        if (loopSignal.detected) {
          const msg = `Doom-loop detected: ${loopSignal.reason ?? 'repeating tool call'} — tool "${tc.name}". Breaking loop and asking user.`
          send("doom_loop", { tool: tc.name, args: tc.args, step, reason: loopSignal.reason, pattern: loopSignal.pattern })
          await this.persistToolResult(assistantMessageID, sessionID, tc, { error: msg }, true)
          doomLoopCount++
          accumulatedText += `\n\n[System: ${msg}]\n`
          messages.push({ role: "assistant", content: accumulatedText })
          messages.push({ role: "user", content: `[Doom-loop guard: ${msg} — please clarify or adjust.]` })
          break loop
        }

        // Permission check (5 layers + BashArity)
        const perm = await this.deps.permissions.check({ sessionID, tool: tc.name, args: tc.args })
        if (perm.action === "deny") {
          const err = `Permission denied for ${tc.name}: ${perm.reason}`
          send("tool_result", { toolCallID: tc.id, name: tc.name, error: err })
          await this.persistToolResult(assistantMessageID, sessionID, tc, { error: err }, true)
          toolResults.push({ toolCallID: tc.id, name: tc.name, result: { error: err }, isError: true })
          continue
        }
        if (perm.action === "ask") {
          // Publish permission.ask → TUI shows prompt → user replies via WS → permission.reply
          send("permission_ask", { toolCallID: tc.id, tool: tc.name, args: tc.args })
          const decision = await this.deps.bus.waitForPermissionReply(tc.id, 120_000)
          if (decision !== "allow") {
            const err = `User denied ${tc.name}`
            await this.persistToolResult(assistantMessageID, sessionID, tc, { error: err }, true)
            toolResults.push({ toolCallID: tc.id, name: tc.name, result: { error: err }, isError: true })
            continue
          }
        }

        // Execute
        send("tool_execute", { toolCallID: tc.id, name: tc.name })
        let result: unknown
        let isError = false
        toolCallCount++
        const tTool = Date.now()
        try {
          result = await this.deps.tools.execute(tc.name, tc.args, { sessionID, messageID: assistantMessageID })
          send("tool_result", { toolCallID: tc.id, name: tc.name, result })
        } catch (err) {
          result = { error: String(err) }
          isError = true
          send("tool_result", { toolCallID: tc.id, name: tc.name, result, isError: true })
        }
        if (this.deps.usage) {
          this.deps.usage.recordTool({
            tool: tc.name, durationMs: Date.now() - tTool, isError,
            errorKind: isError ? "execution" : undefined, sessionID, timestamp: Date.now(),
          }).catch(() => {})
        }
        if (isError) toolErrorCount++

        await this.persistToolResult(assistantMessageID, sessionID, tc, result, isError)
        toolResults.push({ toolCallID: tc.id, name: tc.name, result, isError })
        this.deps.bus.publish({
          type: "part.created", sessionID,
          payload: { tool: tc.name, toolCallID: tc.id, result }, timestamp: Date.now(),
        })
      }

      // ── finish-step: append tool results to context for next iteration ──
      messages.push({ role: "assistant", content: stepText, toolCalls })
      messages.push({ role: "tool", toolResults, content: JSON.stringify(toolResults) })

      // Also persist accumulated text so far
      await this.upsertTextPart(assistantMessageID, sessionID, accumulatedText)
    }

    // Finalize
    send("finish", { steps: step, text: accumulatedText })
    await this.upsertTextPart(assistantMessageID, sessionID, accumulatedText)
    this.deps.bus.publish({ type: "message.updated", sessionID, payload: { id: assistantMessageID, text: accumulatedText, done: true }, timestamp: Date.now() })
    if (this.deps.usage) {
      this.deps.usage.recordSession({
        sessionID, model, steps: step,
        totalTokensIn, totalTokensOut,
        latencyMs: Date.now() - t0,
        toolCalls: toolCallCount, toolErrors: toolErrorCount,
        doomLoops: doomLoopCount, compactionCount,
        success: doomLoopCount === 0,
        userFeedback: null, createdAt: Date.now(),
      }).catch(() => {})
    }
    trace.update({ steps: step })
    trace.end()
    // Persist per-session spend (tokens observed from provider usage chunks)
    if (totalTokensIn || totalTokensOut) {
      try {
        this.deps.db.sqlite
          .prepare(`UPDATE sessions SET tokens_in = COALESCE(tokens_in, 0) + ?, tokens_out = COALESCE(tokens_out, 0) + ? WHERE id = ?`)
          .run(totalTokensIn, totalTokensOut, sessionID)
      } catch {}
    }
    try { await writer.close() } catch {}

    // ── Drain queued messages: chain next turn automatically ──
    const next = this.dequeueFirst(sessionID)
    if (next) {
      this.deps.bus.publish({ type: "session.updated", sessionID, payload: { dequeued: true, remaining: this.getQueue(sessionID).length }, timestamp: Date.now() })
      // Detached chained turn — clients follow via bus events + message reload
      void this.streamResponse(sessionID, next).catch(err => {
        console.error(`[mira] queued turn failed (session ${sessionID}):`, err?.stack ?? err)
      })
    }
    span.end()
  }

  // ── Helpers ──────────────────────────────────────────────────────

  /**
   * Lane-contract enforcement: when the session runs under an agent template
   * that declares a `tools` allowlist, restrict the LLM-visible toolset to it.
   * No template / no allowlist → full registry (general agent).
   */
  private filterToolsForAgent(agent?: string | null): Record<string, { description: string; parameters: any; execute?: any }> {
    const all = this.deps.tools.toAISDKTools()
    if (!agent) return all
    const tpl = (AGENT_TEMPLATES as Record<string, { tools?: readonly string[] }>)[agent]
    if (!tpl?.tools?.length) return all
    const allow = new Set<string>(tpl.tools)
    return Object.fromEntries(Object.entries(all).filter(([name]) => allow.has(name)))
  }

  private async loadContext(sessionID: string, systemPrompt: string) {
    const messages = await this.getMessages(sessionID)
    const context: any[] = [{ role: "system", content: systemPrompt }]
    // Skills injection
    try {
      const skills = await loadSkills()
      if (Object.keys(skills).length) {
        context.push({ role: "system", content: `Active skills:\n${Object.values(skills).map(s => `- ${s.name}: ${s.description.slice(0,200)}`).join("\n")}` })
      }
    } catch {}
    // Todo continuity: inject open todos so a resumed session keeps its task state
    try {
      const todos = await this.getTodos(sessionID)
      if (todos.length) {
        const lines = (todos as any[]).map(t => `- [${t.status}] ${t.content}`)
        context.push({ role: "system", content: `Current todo list — keep exactly ONE item "in_progress" and update the list before starting new work:\n${lines.join("\n")}` })
      }
    } catch {}
    // Structured findings: surface open team memory so loops avoid repeating solved problems
    try {
      const fctx = await openFindingsForContext(this.deps.db)
      if (fctx) context.push({ role: "system", content: fctx })
    } catch {}
    // Memory retrieval: inject relevant knowledge (shared KB if injected, else standalone helper)
    const lastUserText = messages.length ? (messages[messages.length - 1].parts?.find((p: any) => p.type === "text")?.text ?? "") : ""
    if (lastUserText) {
      try {
        const docs = this.deps.knowledge
          ? await this.deps.knowledge.retrieve({ query: lastUserText, limit: 3 })
          : await searchKnowledge(lastUserText, 3)
        if (docs.length) {
          context.push({ role: "system", content: `Relevant memory:\n${docs.map(d => `- ${d.title}: ${d.content.slice(0, 300)}`).join("\n")}` })
        }
      } catch {}
    }
    for (const m of messages) {
      const parts = (m as any).parts ?? []
      const text = parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n")
      if (text) context.push({ role: m.role, content: text })
      // Re-hydrate tool calls for continuity
      for (const p of parts.filter((p: any) => p.type === "tool-call")) {
        context.push({ role: "assistant", content: "", toolCalls: [{ id: p.toolCallID, name: p.tool, args: p.args }] })
      }
      for (const p of parts.filter((p: any) => p.type === "tool-result")) {
        context.push({ role: "tool", content: JSON.stringify(p.result), toolCallID: p.toolCallID })
      }
    }
    return context
  }

  private async upsertTextPart(messageID: string, sessionID: string, text: string) {
    const existing = await this.deps.db.query.parts.findFirst({
      where: (p: any, { and, eq }: any) => and(eq(p.messageID, messageID), eq(p.type, "text")),
    })
    if (existing) {
      // NOTE: update().where() takes an SQL expression, not a callback
      await this.deps.db.update(this.deps.db.schema.parts)
        .set({ text })
        .where(eq(this.deps.db.schema.parts.id, existing.id))
    } else {
      await this.deps.db.insert(this.deps.db.schema.parts).values({
        id: crypto.randomUUID(), messageID, sessionID, type: "text", text, createdAt: Date.now(),
      })
    }
  }

  private async persistToolResult(
    messageID: string, sessionID: string,
    tc: { id: string; name: string; args: unknown },
    result: unknown, isError = false,
  ) {
    // Tool-call part
    await this.deps.db.insert(this.deps.db.schema.parts).values({
      id: crypto.randomUUID(), messageID, sessionID,
      type: "tool-call", tool: tc.name, toolCallID: tc.id, args: tc.args, createdAt: Date.now(),
    })
    // Tool-result part
    await this.deps.db.insert(this.deps.db.schema.parts).values({
      id: crypto.randomUUID(), messageID, sessionID,
      type: "tool-result", tool: tc.name, toolCallID: tc.id, result, isError, createdAt: Date.now(),
    })
  }
}
