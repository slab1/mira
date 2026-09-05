/**
 * Mira SessionPrompt — The Core Loop
 *
 * Mira-inspired but better:
 *   LLM.stream → tool-call → execute → finish-step → doom-loop detection → compaction
 *
 * Key improvements over Mira:
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

import type { Bus } from '../bus/index.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { PermissionManager } from '../permission/index.js'
import type { Gateway } from '../gateway/index.js'
import { buildSystemPrompt, getLoopLimits, getConfig } from '../config/index.js'
import { DoomLoopDetector } from './doom-loop-detector.js'
import { needsCompaction, compactMessages, estimateTokens } from './compaction.js'
import { searchKnowledge } from '../learning/knowledge.js'
import { openFindingsForContext } from '../tools/findings.js'
import type { Todo, JsonValue, MiraConfig } from '../types/index.js'
import type { MiraDB } from '../storage/db.js'
import { loadSkills } from '../skills/loader.js'
import { getAgentTemplates, isKnownAgent } from '../agents/templates.js'
import { initLangfuse } from '../telemetry/langfuse.js'
import { eq } from 'drizzle-orm'
import { trace as otelTrace } from '@opentelemetry/api'
import { classifyBashArity } from '../permission/index.js'

// ── Types ──────────────────────────────────────────────────────────

/** One turn-context message fed back into gateway.stream (loop working set). */
interface LoopMessage {
  role: string
  content: string
  toolCalls?: Array<{ id: string; name: string; args: Record<string, JsonValue> }>
  toolResults?: Array<{ toolCallID: string; name: string; result: JsonValue; isError: boolean }>
  toolCallID?: string
}

export interface SessionPromptDeps {
  db: MiraDB
  bus: Bus
  gateway: Gateway
  tools: ToolRegistry
  permissions: PermissionManager
  /** shared hierarchical memory (injected from learning system) */
  knowledge?: {
    retrieve(opts: {
      query: string
      limit?: number
    }): Promise<Array<{ id: string; title: string; content: string }>>
    /** utility feedback loop: id ∈ [insight.id from online, parse id] */
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
      success: boolean
      userFeedback?: 'up' | 'down' | null
      createdAt: number
    }): Promise<void>
  }
}

export interface LoopOptions {
  maxSteps?: number // default 32
  maxTokens?: number // per-step
  compactionThreshold?: number // 0.8 = compact at 80% context
  signal?: AbortSignal
  agent?: string | null // per-turn agent override (Kilo K1 parity)
}

// ── Auto-Model + Cost Cap helpers (Kilo K8) ──────────────────────────

function tierModel(tier: string | undefined, fallbackSmall?: string): string {
  switch (tier) {
    case 'cheap':
      return fallbackSmall ?? 'openrouter/deepseek/deepseek-v3.2-exp'
    case 'max':
      return 'openrouter/anthropic/claude-opus-4'
    case 'balanced':
    default:
      return 'openrouter/anthropic/claude-sonnet-4'
  }
}
function priceForModel(modelID: string): [number, number] {
  const m = modelID.toLowerCase()
  if (m.includes('claude-sonnet')) return [3, 15]
  if (m.includes('claude-opus')) return [15, 75]
  if (m.includes('claude-haiku')) return [0.8, 4]
  if (m.includes('gpt-4o')) return [2.5, 10]
  if (m.includes('gpt-4')) return [10, 30]
  if (m.includes('deepseek')) return [0.27, 1.1]
  if (m.includes('llama') || m.includes('mistral')) return [0.5, 0.8]
  return [1, 2]
}
function estimateCostUSD(modelID: string, inputTokens: number, outputTokens: number): number {
  const [pin, pout] = priceForModel(modelID)
  return (inputTokens * pin + outputTokens * pout) / 1_000_000
}
function resolveEffectiveModel(input: {
  explicitModel?: string
  agent?: string | null
  sessionModel?: string
}): string {
  // Precedence: explicit > agent.template.model > autoModel tier > session default > global default
  if (input.explicitModel) return input.explicitModel
  if (input.agent) {
    const tpl = getAgentTemplates()[input.agent]
    if (tpl?.model) return tpl.model
  }
  try {
    const cfg = getConfig() as MiraConfig & {
      autoModel?: { enabled?: boolean; tier?: string }
      smallModel?: string
    }
    if (cfg.autoModel?.enabled) {
      return tierModel(cfg.autoModel.tier, cfg.smallModel)
    }
  } catch {}
  if (input.sessionModel) return input.sessionModel
  try {
    return getConfig().model
  } catch {
    return 'openrouter/anthropic/claude-sonnet-4'
  }
}

// ── SessionPrompt ──────────────────────────────────────────────────

export class SessionPrompt {
  private doomDetectors = new Map<string, DoomLoopDetector>()
  private getDoomDetector(sessionID: string): DoomLoopDetector {
    let d = this.doomDetectors.get(sessionID)
    if (!d) {
      d = new DoomLoopDetector()
      this.doomDetectors.set(sessionID, d)
    }
    return d
  }
  /** Knowledge entries currently resident in this session's prompt (for utility feedback). */
  private injectedMemories = new Map<string, Array<{ id: string; title: string }>>()

  /** Log-utility hooks — Phase 4 of ONLINE_LEARNING_ROADMAP. */
  private trackInjectedMemory(sessionID: string, doc: { id: string; title: string }): void {
    if (!this.injectedMemories.has(sessionID)) this.injectedMemories.set(sessionID, [])
    this.injectedMemories.get(sessionID)!.push(doc)
  }
  /** After a turn finishes, bump/decrement the utility of injected memory rows. */
  private settleInjectedMemories(sessionID: string, success: boolean): void {
    const docs = this.injectedMemories.get(sessionID)
    if (!docs?.length || !this.deps.knowledge?.bumpUtility) return
    const delta = success ? 1 : -1
    for (const d of docs) this.deps.knowledge.bumpUtility!(d.id, delta)
    this.injectedMemories.delete(sessionID)
  }

  /** Queues persist in SQLite (message_queue) — survive restarts */

  constructor(private deps: SessionPromptDeps) {}

  // ── Message queueing (Mira-parity UX) ─────────────────────────

  /** Queue a message while a turn is streaming; it runs right after. Persisted to SQLite. */
  queueMessage(sessionID: string, text: string): { position: number } {
    this.deps.db.sqlite
      .prepare(`INSERT INTO message_queue (id, session_id, text, created_at) VALUES (?, ?, ?, ?)`)
      .run(crypto.randomUUID(), sessionID, text, Date.now())
    const q = this.getQueue(sessionID)
    this.deps.bus.publish({
      type: 'session.updated',
      sessionID,
      payload: { queued: q.length },
      timestamp: Date.now(),
    })
    return { position: q.length }
  }

  getQueue(sessionID: string): string[] {
    try {
      return (
        this.deps.db.sqlite
          .prepare(`SELECT text FROM message_queue WHERE session_id = ? ORDER BY created_at, rowid`)
          .all(sessionID) as Array<{ text: string }>
      ).map((r) => r.text)
    } catch {
      return []
    }
  }

  clearQueue(sessionID: string): number {
    const n = this.getQueue(sessionID).length
    try {
      this.deps.db.sqlite.prepare(`DELETE FROM message_queue WHERE session_id = ?`).run(sessionID)
    } catch {}
    return n
  }

  /** Atomically pop the oldest queued message (drain head) */
  dequeueFirst(sessionID: string): string | null {
    try {
      const row = this.deps.db.sqlite
        .prepare(
          `SELECT id, text FROM message_queue WHERE session_id = ? ORDER BY created_at, rowid LIMIT 1`,
        )
        .get(sessionID) as { id: string; text: string } | undefined
      if (!row) return null
      this.deps.db.sqlite.prepare(`DELETE FROM message_queue WHERE id = ?`).run(row.id)
      return row.text
    } catch {
      return null
    }
  }

  // ── Session CRUD (delegated to storage) ──────────────────────────

  async createSession(input: {
    title?: string
    model?: string
    parentID?: string
    agent?: string
    ownerID?: string | null
  }) {
    const id = crypto.randomUUID()
    const now = Date.now()
    // Subagent/fork children inherit the parent session's owner (multi-tenant)
    let ownerID = input.ownerID ?? null
    if (!ownerID && input.parentID) {
      try {
        const parent = await this.getSession(input.parentID)
        ownerID = parent?.ownerID ?? null
      } catch {}
    }
    // Kilo K1+K8: explicit > agent.model > autoModel tier > default
    const effectiveModel = resolveEffectiveModel({
      explicitModel: input.model,
      agent: input.agent ?? null,
      sessionModel: 'openrouter/anthropic/claude-sonnet-4',
    })
    const session = {
      id,
      title: input.title ?? (input.agent ? `${input.agent} session` : 'New Session'),
      model: effectiveModel,
      provider: 'openrouter',
      createdAt: now,
      updatedAt: now,
      parentID: input.parentID,
      agent: (input.agent && isKnownAgent(input.agent) ? input.agent : null) as string | null,
      ownerID: ownerID as string | null,
      tokensIn: null as number | null,
      tokensOut: null as number | null,
      costUsd: null as number | null,
    }
    await this.deps.db.insert(this.deps.db.schema.sessions).values(session)
    return session
  }

  async getSession(id: string) {
    return this.deps.db.query.sessions.findFirst({ where: (s, { eq }) => eq(s.id, id) })
  }

  async deleteSession(id: string) {
    await this.deps.db
      .delete(this.deps.db.schema.messages)
      .where(eq(this.deps.db.schema.messages.sessionID, id))
    await this.deps.db
      .delete(this.deps.db.schema.parts)
      .where(eq(this.deps.db.schema.parts.sessionID, id))
    await this.deps.db
      .delete(this.deps.db.schema.todos)
      .where(eq(this.deps.db.schema.todos.sessionID, id))
    await this.deps.db
      .delete(this.deps.db.schema.fileSnapshots)
      .where(eq(this.deps.db.schema.fileSnapshots.sessionID, id))
    await this.deps.db
      .delete(this.deps.db.schema.jobs)
      .where(eq(this.deps.db.schema.jobs.parentSessionID, id))
    await this.deps.db
      .delete(this.deps.db.schema.findings)
      .where(eq(this.deps.db.schema.findings.sessionID, id))
    await this.deps.db
      .delete(this.deps.db.schema.knowledgeEntries)
      .where(eq(this.deps.db.schema.knowledgeEntries.sessionID, id))
    this.deps.db.sqlite.prepare('DELETE FROM message_queue WHERE session_id = ?').run(id)
    await this.deps.db
      .delete(this.deps.db.schema.sessions)
      .where(eq(this.deps.db.schema.sessions.id, id))
  }

  async getMessages(sessionID: string) {
    return this.deps.db.query.messages.findMany({
      where: (m, { eq }) => eq(m.sessionID, sessionID),
      with: { parts: true },
      orderBy: (m, { asc }) => [asc(m.createdAt)],
    })
  }

  async getTodos(sessionID: string) {
    return this.deps.db.query.todos.findMany({
      where: (t, { eq }) => eq(t.sessionID, sessionID),
    })
  }

  async setTodos(sessionID: string, todos: Todo[]) {
    // Replace todos for session
    await this.deps.db
      .delete(this.deps.db.schema.todos)
      .where(eq(this.deps.db.schema.todos.sessionID, sessionID))
    if (todos.length) {
      await this.deps.db.insert(this.deps.db.schema.todos).values(
        todos.map((t: Todo) => ({
          ...t,
          id: t.id ?? crypto.randomUUID(),
          sessionID,
          createdAt: Date.now(),
        })),
      )
    }
    return todos
  }

  // ── Session forking ───────────────────────────────────────────────

  /**
   * Fork a session: copy history (messages + parts) up to messageID into a
   * new child session. Enables branching exploration without losing the original.
   */
  async forkSession(opts: {
    sourceSessionID: string
    messageID?: string
    title?: string
  }): Promise<{ sessionID: string; copiedMessages: number }> {
    const source = await this.getSession(opts.sourceSessionID)
    if (!source) throw new Error('source session not found')
    const history = await this.getMessages(opts.sourceSessionID)

    // Slice at the fork point (inclusive of messageID if given)
    let selected = history
    if (opts.messageID) {
      const idx = selected.findIndex((m) => m.id === opts.messageID)
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
        id: newMessageID,
        sessionID: fork.id,
        role: m.role,
        createdAt: m.createdAt ?? now,
      })
      for (const p of m.parts ?? []) {
        const { id: _old, ...rest } = p
        await this.deps.db.insert(this.deps.db.schema.parts).values({
          id: crypto.randomUUID(),
          ...rest,
          messageID: newMessageID,
          sessionID: fork.id,
        })
      }
    }

    this.deps.bus.publish({
      type: 'session.created',
      payload: { ...fork, forkedFrom: source.id },
      timestamp: now,
    })
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
    agent?: string
    model?: string
    title?: string
    signal?: AbortSignal
  }): Promise<{ sessionID: string; text: string }> {
    // Per-agent model routing: explicit > agent.model > autoModel tier > default (Kilo K1+K8)
    const effectiveModel =
      resolveEffectiveModel({
        explicitModel: opts.model,
        agent: opts.agent ?? null,
        sessionModel: undefined,
      }) || undefined
    const s = await this.createSession({
      title: opts.title ?? `↳ ${opts.prompt.slice(0, 48)}`,
      parentID: opts.parentID,
      agent: opts.agent,
      model: effectiveModel,
    })
    let text = ''
    // No-op sink: collect only the final text (no SSE transport needed)
    const send = (_event: string, data: JsonValue) => {
      if (
        typeof data === 'object' &&
        data !== null &&
        !Array.isArray(data) &&
        typeof data.text === 'string'
      )
        text = data.text
    }
    const noopWriter = {
      write: () => {},
      close: async () => {},
    } as object as WritableStreamDefaultWriter<Uint8Array>
    try {
      const runModel = effectiveModel ?? s.model
      // Agent persona for subagent loop
      const persona = opts.agent ? getAgentTemplates()[opts.agent]?.system : undefined
      const basePrompt = await buildSystemPrompt()
      const systemPrompt = persona ? `${persona}\n\n${basePrompt}` : basePrompt
      await this.runLoop({
        sessionID: s.id,
        assistantMessageID: crypto.randomUUID(),
        userText: opts.prompt,
        model: runModel,
        systemPrompt,
        send,
        writer: noopWriter,
        agent: opts.agent ?? s.agent,
        signal: opts.signal,
      })
    } catch (err) {
      // Prefer a signal-abort over a generic error message so an explicitly
      // cancelled job reports "cancelled" rather than a misleading stack trace.
      text = opts.signal?.aborted ? '[subagent cancelled]' : `[subagent error] ${String(err)}`
    }
    return { sessionID: s.id, text }
  }

  // ── The Loop ─────────────────────────────────────────────────────

  /**
   * streamResponse — Server-Sent Events stream for POST /session/:id/prompt
   *
   * Implements: LLM.stream → tool-call → execute → finish-step → doom-loop → compaction
   */
  async streamResponse(
    sessionID: string,
    userText: string,
    modelOverride?: string,
    options?: LoopOptions,
  ): Promise<Response> {
    const session = await this.getSession(sessionID)
    if (!session) throw new Error('session not found')

    // Model resolution: explicit > agent.model > autoModel tier > session default (Kilo K1+K8)
    const effectiveAgent = options?.agent ?? session.agent ?? null
    const model = resolveEffectiveModel({
      explicitModel: modelOverride,
      agent: effectiveAgent,
      sessionModel: session.model,
    })
    const basePrompt = await buildSystemPrompt()
    // Agent persona (researcher/coder/reviewer) prepended when set on the session or per-turn
    const persona = effectiveAgent ? getAgentTemplates()[effectiveAgent]?.system : undefined
    const systemPrompt = persona ? `${persona}\n\n${basePrompt}` : basePrompt

    // Persist user message + part immediately (so TUI sees it via bus)
    const userMessageID = crypto.randomUUID()
    const now = Date.now()
    await this.deps.db.insert(this.deps.db.schema.messages).values({
      id: userMessageID,
      sessionID,
      role: 'user',
      createdAt: now,
    })
    await this.deps.db.insert(this.deps.db.schema.parts).values({
      id: crypto.randomUUID(),
      messageID: userMessageID,
      sessionID,
      type: 'text',
      text: userText,
      createdAt: now,
    })
    this.deps.bus.publish({
      type: 'message.created',
      sessionID,
      payload: { id: userMessageID, text: userText },
      timestamp: now,
    })
    this.deps.bus.publish({
      type: 'part.created',
      sessionID,
      payload: { text: userText },
      timestamp: now,
    })

    // Create assistant message placeholder
    const assistantMessageID = crypto.randomUUID()
    await this.deps.db.insert(this.deps.db.schema.messages).values({
      id: assistantMessageID,
      sessionID,
      role: 'assistant',
      createdAt: Date.now(),
    })

    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()
    const encoder = new TextEncoder()

    // SSE heartbeat — tunnel intermediaries (zrok/Cloudflare) idle-timeout silent
    // connections, killing long generations mid-stream. SSE comment lines keep
    // bytes flowing and are ignored by every client-side parser.
    let streamClosed = false
    const HEARTBEAT_MS = 20_000
    const heartbeat = setInterval(() => {
      if (streamClosed) return
      writer.write(encoder.encode(': ping\n\n')).catch(() => {
        streamClosed = true
        clearInterval(heartbeat)
      })
    }, HEARTBEAT_MS)
    const finishStream = () => {
      if (streamClosed) return
      streamClosed = true
      clearInterval(heartbeat)
    }

    const send = (event: string, data: JsonValue) => {
      const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
      writer.write(encoder.encode(line))
    }

    // Run loop in background (don't block response headers)
    this.runLoop({
      sessionID,
      assistantMessageID,
      userText,
      model,
      systemPrompt,
      send,
      writer,
      agent: effectiveAgent,
      maxSteps: options?.maxSteps,
      compactionThreshold: options?.compactionThreshold,
      onStreamClosed: finishStream,
      signal: options?.signal,
    }).catch(async (err) => {
      console.error(`[mira] loop error (session ${sessionID}):`, err?.stack ?? err)
      send('error', { error: String(err) })
      try {
        await writer.close()
      } catch {}
      finishStream()
    })

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    })
  }

  private async runLoop(opts: {
    sessionID: string
    assistantMessageID: string
    userText: string
    model: string
    systemPrompt: string
    send: (event: string, data: JsonValue) => void
    writer: WritableStreamDefaultWriter<Uint8Array>
    agent?: string | null
    maxSteps?: number
    compactionThreshold?: number
    onStreamClosed?: () => void
    signal?: AbortSignal
  }) {
    const { sessionID, assistantMessageID, model, systemPrompt, send, writer } = opts
    const tracer = otelTrace.getTracer('mira-server')
    const span = tracer.startSpan('session.prompt.loop', {
      attributes: { session_id: sessionID, prompt_id: assistantMessageID },
    })
    // Loop limits: explicit option > env/config (MIRA_MAX_STEPS etc.) > built-in default
    const limits = getLoopLimits()
    const MAX_STEPS = opts.maxSteps ?? limits.maxSteps
    let step = 0
    let accumulatedText = ''
    this.getDoomDetector(sessionID).reset()
    const lf = initLangfuse()
    const trace = lf?.trace?.('session') ?? { update: (_data?: JsonValue) => {}, end: () => {} }
    // usage-learning counters for recordSession at finalize
    const t0 = Date.now()
    let toolCallCount = 0,
      toolErrorCount = 0,
      doomLoopCount = 0,
      compactionCount = 0
    let totalTokensIn = 0,
      totalTokensOut = 0

    // Load conversation history
    let messages = await this.loadContext(sessionID, systemPrompt)

    // Fetch session base cost for perSession cap (session tokens + current run)
    let sessionBaseCost = 0
    try {
      const s = await this.getSession(sessionID)
      if (s)
        sessionBaseCost = estimateCostUSD(
          (s as { model?: string }).model ?? model,
          (s as { tokensIn?: number | null }).tokensIn ?? 0,
          (s as { tokensOut?: number | null }).tokensOut ?? 0,
        )
    } catch {}
    loop: while (step < MAX_STEPS) {
      step++

      // Honour an explicit cancellation (e.g. cancelJob) between steps —
      // abort the run promptly rather than waiting for the next stream call.
      if (opts.signal?.aborted) {
        send('aborted', { step, reason: 'cancelled' })
        break loop
      }

      // ── Cost cap guard (Kilo K8) — perTask / perSession in USD ───────
      try {
        const cfg = getConfig() as MiraConfig & {
          costCap?: { perTask?: number; perSession?: number }
        }
        const curCost = estimateCostUSD(model, totalTokensIn, totalTokensOut)
        if (cfg.costCap?.perTask !== undefined && curCost > cfg.costCap.perTask) {
          const msg = `Cost cap exceeded: $${curCost.toFixed(4)} > $${cfg.costCap.perTask.toFixed(4)} per-task limit (model ${model}, step ${step}). Aborting.`
          send('error', { error: msg })
          this.deps.bus.publish({
            type: 'server.error',
            sessionID,
            payload: { error: msg, source: 'cost-cap', cap: cfg.costCap.perTask } as JsonValue,
            timestamp: Date.now(),
          })
          accumulatedText += `\n\n[System: ${msg}]\n`
          await this.upsertTextPart(assistantMessageID, sessionID, accumulatedText)
          break loop
        }
        if (cfg.costCap?.perSession !== undefined) {
          const sessCost = sessionBaseCost + curCost
          if (sessCost > cfg.costCap.perSession) {
            const msg = `Cost cap exceeded: $${sessCost.toFixed(4)} > $${cfg.costCap.perSession.toFixed(4)} per-session limit (model ${model}, step ${step}). Aborting.`
            send('error', { error: msg })
            this.deps.bus.publish({
              type: 'server.error',
              sessionID,
              payload: { error: msg, source: 'cost-cap', cap: cfg.costCap.perSession } as JsonValue,
              timestamp: Date.now(),
            })
            accumulatedText += `\n\n[System: ${msg}]\n`
            await this.upsertTextPart(assistantMessageID, sessionID, accumulatedText)
            break loop
          }
        }
      } catch {}

      // ── Compaction check ──
      const contextLimit = limits.contextLimit
      const threshold = opts.compactionThreshold ?? limits.compactionThreshold
      const { needed, tokenEstimate, ratio } = await needsCompaction(
        messages,
        contextLimit,
        threshold,
      )
      if (needed) {
        send('compaction', { step, tokenEstimate, ratio })
        const result = await compactMessages(this.deps.gateway, messages, {
          smallModel: limits.smallModel,
          contextLimit,
          threshold,
        })
        // Preserve tool-call history — don't drop non-string contents (tool results) which are needed for correct summarization
        messages = result.messages
        compactionCount++
        this.deps.bus.publish({
          type: 'message.updated',
          sessionID,
          payload: { compaction: true, step, tokenEstimate, reducedTo: result.compactedCount },
          timestamp: Date.now(),
        })
      }

      // ── LLM.stream (Vercel AI SDK v5) ──
      send('step_start', { step, model })
      const stream = await this.deps.gateway.stream({
        model,
        messages,
        tools: this.filterToolsForAgent(opts.agent), // lane-contract enforcement (agent allowlist)
        system: systemPrompt,
        signal: opts?.signal,
      })

      let stepText = ''
      const toolCalls: Array<{ id: string; name: string; args: Record<string, JsonValue> }> = []
      let lastFlush = Date.now()
      let lastPersistedLen = accumulatedText.length

      for await (const chunk of stream) {
        if (chunk.type === 'text-delta' && chunk.text) {
          stepText += chunk.text
          accumulatedText += chunk.text
          send('text_delta', { delta: chunk.text, step })

          // Batch persist: flush every 200ms or 200 chars to reduce SQLite WAL write amplification
          const now = Date.now()
          if (now - lastFlush > 200 || accumulatedText.length - lastPersistedLen > 200) {
            await this.upsertTextPart(assistantMessageID, sessionID, accumulatedText)
            lastFlush = now
            lastPersistedLen = accumulatedText.length
          }
          this.deps.bus.publish({
            type: 'part.updated',
            sessionID,
            payload: { text: chunk.text, step },
            timestamp: Date.now(),
          })
        } else if (chunk.type === 'tool-call' && chunk.toolCall) {
          toolCalls.push(chunk.toolCall)
          send('tool_call', chunk.toolCall)
        } else if (chunk.type === 'finish') {
          send('step_finish', { step, reason: chunk.finishReason, usage: chunk.usage })
          const u = chunk.usage
          if (u) {
            totalTokensIn += Number(u.promptTokens ?? u.inputTokens ?? 0) || 0
            totalTokensOut += Number(u.completionTokens ?? u.outputTokens ?? 0) || 0
          }
          if (chunk.finishReason === 'stop' && toolCalls.length === 0) {
            // Flush any remaining batched text before exiting
            if (accumulatedText.length !== lastPersistedLen) {
              await this.upsertTextPart(assistantMessageID, sessionID, accumulatedText)
            }
            // Conversation turn complete — drain trailing chunks (e.g. usage-report)
            // so gateway cost tracking sees them, then exit the loop.
            for await (const tail of stream) {
              if (tail.type === 'usage-report') {
                const tu = tail.usage
                if (tu) {
                  totalTokensIn += Number(tu.inputTokens ?? tu.prompt_tokens ?? 0) || 0
                  totalTokensOut += Number(tu.outputTokens ?? tu.completion_tokens ?? 0) || 0
                }
              }
            }
            break loop
          }
        } else if (chunk.type === 'error') {
          send('error', chunk)
          break loop
        }
      }

      // Ensure any remaining batched text is persisted before tool execution / loop exit
      if (accumulatedText.length !== lastPersistedLen) {
        await this.upsertTextPart(assistantMessageID, sessionID, accumulatedText)
        lastPersistedLen = accumulatedText.length
      }

      // ── No tool calls? We're done ──
      if (toolCalls.length === 0) break loop

      // ── Execute each tool-call ──
      const toolResults: Array<{
        toolCallID: string
        name: string
        result: JsonValue
        isError: boolean
      }> = []
      for (const tc of toolCalls) {
        // Doom-loop detection — per-session
        const loopSignal = this.getDoomDetector(sessionID).check({ name: tc.name, args: tc.args })
        if (loopSignal.detected) {
          const msg = `Doom-loop detected: ${loopSignal.reason ?? 'repeating tool call'} — tool "${tc.name}". Breaking loop and asking user.`
          send('doom_loop', {
            tool: tc.name,
            args: tc.args,
            step,
            reason: loopSignal.reason,
            pattern: loopSignal.pattern,
          })
          this.deps.bus.publish({
            type: 'server.error',
            sessionID,
            payload: {
              error: msg,
              source: 'doom-loop',
              tool: tc.name,
              pattern: loopSignal.pattern,
            } as JsonValue,
            timestamp: Date.now(),
          })
          await this.persistToolResult(assistantMessageID, sessionID, tc, { error: msg }, true)
          doomLoopCount++
          accumulatedText += `\n\n[System: ${msg}]\n`
          messages.push({ role: 'assistant', content: accumulatedText })
          messages.push({
            role: 'user',
            content: `[Doom-loop guard: ${msg} — please clarify or adjust.]`,
          })
          break loop
        }

        // Per-agent permission profile (roadmap item 3) — enforce lane contracts beyond tool allowlist
        // Feature flag: perAgentPermissionProfiles (default true)
        let perm: Awaited<ReturnType<typeof this.deps.permissions.check>> | null = null
        if (opts.agent && getConfig().features?.perAgentPermissionProfiles !== false) {
          const tpl = getAgentTemplates()[opts.agent]
          if (tpl?.permissions === 'readonly') {
            const mutating = new Set(['write', 'edit', 'patch', 'todowrite'])
            if (mutating.has(tc.name)) {
              perm = {
                action: 'deny',
                reason: `lane contract: agent "${opts.agent}" is readonly — ${tc.name} blocked`,
              }
            } else if (tc.name === 'bash') {
              const cmd = (tc.args as Record<string, JsonValue>).command as string | undefined
              if (cmd) {
                const { level } = classifyBashArity(cmd)
                if (level > 0)
                  perm = {
                    action: 'deny',
                    reason: `lane contract: readonly agent "${opts.agent}" — bash level ${level} blocked (${cmd.slice(0, 60)})`,
                  }
              }
            }
          }
        }
        // Permission check (5 layers + BashArity) — only if not already denied by lane
        if (!perm)
          perm = await this.deps.permissions.check({ sessionID, tool: tc.name, args: tc.args })
        if (perm.action === 'deny') {
          const err = `Permission denied for ${tc.name}: ${perm.reason}`
          send('tool_result', { toolCallID: tc.id, name: tc.name, error: err })
          await this.persistToolResult(assistantMessageID, sessionID, tc, { error: err }, true)
          toolResults.push({
            toolCallID: tc.id,
            name: tc.name,
            result: { error: err },
            isError: true,
          })
          continue
        }
        if (perm.action === 'ask') {
          // Publish permission.ask → TUI shows prompt → user replies via WS → permission.reply
          send('permission_ask', { toolCallID: tc.id, tool: tc.name, args: tc.args })
          const decision = await this.deps.bus.waitForPermissionReply(tc.id, 120_000)
          if (decision !== 'allow') {
            const err = `User denied ${tc.name}`
            await this.persistToolResult(assistantMessageID, sessionID, tc, { error: err }, true)
            toolResults.push({
              toolCallID: tc.id,
              name: tc.name,
              result: { error: err },
              isError: true,
            })
            continue
          }
        }

        // Execute
        send('tool_execute', { toolCallID: tc.id, name: tc.name })
        let result: JsonValue = null
        let isError = false
        toolCallCount++
        const tTool = Date.now()
        try {
          result = await this.deps.tools.execute(tc.name, tc.args, {
            sessionID,
            messageID: assistantMessageID,
          })
          send('tool_result', { toolCallID: tc.id, name: tc.name, result })
        } catch (err) {
          result = { error: String(err) }
          isError = true
          send('tool_result', { toolCallID: tc.id, name: tc.name, result, isError: true })
        }
        if (this.deps.usage) {
          this.deps.usage
            .recordTool({
              tool: tc.name,
              durationMs: Date.now() - tTool,
              isError,
              errorKind: isError ? 'execution' : undefined,
              sessionID,
              timestamp: Date.now(),
            })
            .catch(() => {})
        }
        if (isError) toolErrorCount++

        await this.persistToolResult(assistantMessageID, sessionID, tc, result, isError)
        toolResults.push({ toolCallID: tc.id, name: tc.name, result, isError })
        this.deps.bus.publish({
          type: 'part.created',
          sessionID,
          payload: { tool: tc.name, toolCallID: tc.id, result },
          timestamp: Date.now(),
        })
      }

      // ── finish-step: append tool results to context for next iteration ──
      messages.push({ role: 'assistant', content: stepText, toolCalls })
      messages.push({ role: 'tool', toolResults, content: JSON.stringify(toolResults) })

      // Also persist accumulated text so far
      await this.upsertTextPart(assistantMessageID, sessionID, accumulatedText)
    }

    // Finalize
    send('finish', { steps: step, text: accumulatedText })
    await this.upsertTextPart(assistantMessageID, sessionID, accumulatedText)
    this.deps.bus.publish({
      type: 'message.updated',
      sessionID,
      payload: { id: assistantMessageID, text: accumulatedText, done: true },
      timestamp: Date.now(),
    })
    const finishSuccess = doomLoopCount === 0
    if (this.deps.usage) {
      this.deps.usage
        .recordSession({
          sessionID,
          model,
          steps: step,
          totalTokensIn,
          totalTokensOut,
          latencyMs: Date.now() - t0,
          toolCalls: toolCallCount,
          toolErrors: toolErrorCount,
          doomLoops: doomLoopCount,
          compactionCount,
          success: finishSuccess,
          userFeedback: null,
          createdAt: Date.now(),
        })
        .catch(() => {})
    }
    // Phase 4: settle utility for any knowledge entries we injected into this turn
    this.settleInjectedMemories(sessionID, finishSuccess)
    trace.update({ steps: step })
    trace.end()
    // Persist per-session spend (tokens observed from provider usage chunks)
    if (totalTokensIn || totalTokensOut) {
      try {
        this.deps.db.sqlite
          .prepare(
            `UPDATE sessions SET tokens_in = COALESCE(tokens_in, 0) + ?, tokens_out = COALESCE(tokens_out, 0) + ? WHERE id = ?`,
          )
          .run(totalTokensIn, totalTokensOut, sessionID)
      } catch {}
    }
    try {
      await writer.close()
    } catch {}
    opts.onStreamClosed?.()

    // ── Drain queued messages: chain next turn automatically ──
    const next = this.dequeueFirst(sessionID)
    if (next) {
      this.deps.bus.publish({
        type: 'session.updated',
        sessionID,
        payload: { dequeued: true, remaining: this.getQueue(sessionID).length },
        timestamp: Date.now(),
      })
      // Detached chained turn — surface errors via bus so clients see hung turn
      void this.streamResponse(sessionID, next).catch((err) => {
        console.error(`[mira] queued turn failed (session ${sessionID}):`, err?.stack ?? err)
        this.deps.bus.publish({
          type: 'server.error',
          sessionID,
          payload: { error: String(err), source: 'queue_drain' } as JsonValue,
          timestamp: Date.now(),
        })
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
  private filterToolsForAgent(agent?: string | null): ReturnType<ToolRegistry['toAISDKTools']> {
    const all = this.deps.tools.toAISDKTools()
    // Feature flag: enforceLaneContracts (default true). Off = every session sees the full registry.
    if (getConfig().features?.enforceLaneContracts === false) return all
    if (!agent) return all
    const tpl = getAgentTemplates()[agent]
    if (!tpl?.tools?.length) return all
    const allow = new Set<string>(tpl.tools)
    return Object.fromEntries(Object.entries(all).filter(([name]) => allow.has(name)))
  }

  private async loadContext(sessionID: string, systemPrompt: string): Promise<LoopMessage[]> {
    const messages = await this.getMessages(sessionID)
    // Hierarchical memory: systemPrompt already contains AGENTS.md via buildSystemPrompt (project instructions)
    // This method wires L1 working (messages) + L2 episodic (todos/findings) + L3 semantic (knowledge) + procedural (skills) + Memory Bank (Kilo K3)
    const context: LoopMessage[] = [{ role: 'system', content: systemPrompt }]
    // Memory Bank (Kilo K3 parity) — flat file notes that survive restarts, injected before other memory
    try {
      const bank = await this.loadMemoryBank()
      if (bank) context.push({ role: 'system', content: bank })
    } catch {}
    // Skills injection (procedural memory)
    try {
      const skills = await loadSkills()
      if (Object.keys(skills).length) {
        context.push({
          role: 'system',
          content: `Active skills:\n${Object.values(skills)
            .map((s) => `- ${s.name}: ${s.description.slice(0, 200)}`)
            .join('\n')}`,
        })
      }
    } catch {}
    // Todo continuity: inject open todos so a resumed session keeps its task state
    // Feature flag: injectTodosIntoLoadContext (default true)
    if (getConfig().features?.injectTodosIntoLoadContext !== false) {
      try {
        const todos = await this.getTodos(sessionID)
        if (todos.length) {
          const lines = todos.map((t) => `- [${t.status}] ${t.content}`)
          context.push({
            role: 'system',
            content: `Current todo list — keep exactly ONE item "in_progress" and update the list before starting new work:\n${lines.join('\n')}`,
          })
        }
      } catch {}
    }
    // Structured findings: surface open team memory so loops avoid repeating solved problems
    try {
      const fctx = await openFindingsForContext(this.deps.db)
      if (fctx) context.push({ role: 'system', content: fctx })
    } catch {}
    // Memory retrieval: hierarchical knowledge (L3 semantic) — uses injected KB or shared helper
    const lastUserText = messages.length
      ? (messages[messages.length - 1].parts?.find((p) => p.type === 'text')?.text ?? '')
      : ''
    if (lastUserText) {
      try {
        const docs = this.deps.knowledge
          ? await this.deps.knowledge.retrieve({ query: lastUserText, limit: 3 })
          : await searchKnowledge(lastUserText, 3)
        if (docs.length) {
          // Phase 4 utility-feedback: remember which memory rows entered the
          // prompt; after the turn resolves we credit/blame them on success.
          for (const d of docs) this.trackInjectedMemory(sessionID, d)
          context.push({
            role: 'system',
            content: `Relevant memory:\n${docs.map((d) => `- [${d.title}](${d.id}): ${d.content.slice(0, 300)}`).join('\n')}`,
          })
        }
      } catch {}
    }
    for (const m of messages) {
      const parts = m.parts ?? []
      const text = parts
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('\n')
      if (text) context.push({ role: m.role, content: text })
      // Re-hydrate tool calls for continuity
      for (const p of parts.filter((p) => p.type === 'tool-call')) {
        if (!p.toolCallID || !p.tool) continue
        context.push({
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: p.toolCallID, name: p.tool, args: (p.args ?? {}) as Record<string, JsonValue> },
          ],
        })
      }
      for (const p of parts.filter((p) => p.type === 'tool-result')) {
        if (!p.toolCallID) continue
        context.push({
          role: 'tool',
          content: JSON.stringify(p.result ?? null),
          toolCallID: p.toolCallID,
        })
      }
    }
    return context
  }

  /** Memory Bank loader — reads data/memory_bank/*.md if present (Kilo parity, flat file notes). */
  private async loadMemoryBank(): Promise<string | null> {
    // Resolve memory_bank sibling to the SQLite DB (MIRA_DB) or fallback to ./data/memory_bank
    const candidates: string[] = []
    const envDB = process.env.MIRA_DB
    if (envDB) {
      const slash = envDB.lastIndexOf('/')
      if (slash >= 0) candidates.push(`${envDB.slice(0, slash)}/memory_bank`)
    }
    candidates.push(`${process.cwd()}/data/memory_bank`)
    candidates.push(`${process.cwd()}/packages/server/data/memory_bank`)
    // dedupe
    const seen = new Set<string>()
    const uniq = candidates.filter((p) => !seen.has(p) && seen.add(p))
    let dir: string | null = null
    let files: string[] = []
    for (const cand of uniq) {
      try {
        const { readdirSync } = await import('node:fs')
        files = readdirSync(cand).filter((f) => f.endsWith('.md'))
        if (files.length >= 0) {
          dir = cand
          break
        }
      } catch {}
      // also try Bun.file existence via readdir failure -> try next candidate
    }
    if (!dir) return null
    const parts: string[] = []
    for (const f of files.sort()) {
      try {
        const txt = await Bun.file(`${dir}/${f}`).text()
        if (txt.trim()) parts.push(`### ${f}\n${txt.slice(0, 4000).trim()}`)
      } catch {}
    }
    if (!parts.length) return null
    return `Memory Bank (persistent project notes — read first, update via write/edit when you learn something durable):\n${parts.join('\n\n')}`
  }

  private async upsertTextPart(messageID: string, sessionID: string, text: string) {
    const existing = await this.deps.db.query.parts.findFirst({
      where: (p, { and, eq }) => and(eq(p.messageID, messageID), eq(p.type, 'text')),
    })
    if (existing) {
      // NOTE: update().where() takes an SQL expression, not a callback
      await this.deps.db
        .update(this.deps.db.schema.parts)
        .set({ text })
        .where(eq(this.deps.db.schema.parts.id, existing.id))
    } else {
      await this.deps.db.insert(this.deps.db.schema.parts).values({
        id: crypto.randomUUID(),
        messageID,
        sessionID,
        type: 'text',
        text,
        createdAt: Date.now(),
      })
    }
  }

  private async persistToolResult(
    messageID: string,
    sessionID: string,
    tc: { id: string; name: string; args: Record<string, JsonValue> },
    result: JsonValue,
    isError = false,
  ) {
    // Tool-call part
    await this.deps.db.insert(this.deps.db.schema.parts).values({
      id: crypto.randomUUID(),
      messageID,
      sessionID,
      type: 'tool-call',
      tool: tc.name,
      toolCallID: tc.id,
      args: tc.args,
      createdAt: Date.now(),
    })
    // Tool-result part
    await this.deps.db.insert(this.deps.db.schema.parts).values({
      id: crypto.randomUUID(),
      messageID,
      sessionID,
      type: 'tool-result',
      tool: tc.name,
      toolCallID: tc.id,
      result,
      isError,
      createdAt: Date.now(),
    })
  }
}
