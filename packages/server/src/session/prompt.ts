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
import type { GatewayRouter } from '../gateway/router.js'
import type { SubgatewayRegistry } from '../gateway/registry.js'
import { getSessionCost } from '../gateway/subgateway.js'
import { buildSystemPrompt, getLoopLimits, getConfig } from '../config/index.js'
import { appendActiveWork, ensureMemoryBank } from '../memory/memory_controller.js'
import { DoomLoopDetector } from './doom-loop-detector.js'
import { needsCompaction, compactMessages } from './compaction.js'
import { searchKnowledge, sharedKnowledge } from '../learning/knowledge.js'
import { openFindingsForContext } from '../tools/findings.js'
import { sharedGoals } from '../strategic/goals.js'
import type { Todo, JsonValue, MiraConfig } from '../types/index.js'
import type { MiraDB } from '../storage/db.js'
import { getUserByOwner, getUserNameForOwner, setUserNameForOwner } from '../storage/users.js'
import { maybeAutoTitle } from './title.js'
import { loadSkills } from '../skills/loader.js'
import { getAgentTemplates, isKnownAgent, isBashCommandAllowed } from '../agents/templates.js'
import { buildRegistry, resolveModel, resolveWithFallbacks } from '../gateway/provider.js'
import { initLangfuse } from '../telemetry/langfuse.js'
import { eq } from 'drizzle-orm'
import { trace as otelTrace } from '@opentelemetry/api'
import { classifyBashArity } from '../permission/index.js'

// Import types and helpers from split files
import type { LoopMessage, SessionPromptDeps, LoopOptions } from './types.js'
import {
  pruneReasoning,
  summarizeToolTraces,
  getRouter,
  getRegistry,
  isGatewayRouter,
  isSubgatewayRegistry,
  resolveLane,
  laneCostCap,
  tierModel,
  priceForModel,
  estimateCostUSD,
  getRetiredModels,
  isRetired,
  resolveEffectiveModel,
  resolveModelViaGateway,
} from './helpers.js'


const INTRO_NON_NAME_WORDS = new Set([
  'a', 'an', 'the', 'me', 'you', 'it', 'that', 'this', 'here', 'there', 'not', 'no',
  'user', 'mira', 'assistant', 'bot', 'ai', 'something', 'anything', 'someone', 'anyone',
  'everything', 'nothing', 'sir', 'boss', 'chief', 'bro', 'dude', 'friend', 'madam',
  'back', 'later', 'soon', 'if', 'when', 'whenever', 'maybe', 'again', 'whatever',
  'ready', 'done', 'finished', 'crazy', 'stupid', 'wrong', 'right', 'busy', 'free',
  'available', 'sure', 'now', 'today', 'tomorrow', 'home', 'away', 'out', 'in', 'up',
  'down', 'off', 'on', 'testing', 'trying', 'asking', 'sorry', 'variable', 'function',
  'file', 'code', 'error', 'null', 'undefined', 'true', 'false',
])

/**
 * Conservatively extract a user's self-introduced display name from chat text
 * (e.g. "My name is Ada", "Remember my name is Alex", "Please call me Sam").
 */
export function extractIntroducedUserName(userText: string): string | undefined {
  const trimmed = userText.trim()
  if (!trimmed || trimmed.length > 500 || trimmed.includes('```')) return undefined
  const clauses = trimmed
    .split(/(?:[.!?\n]+|,\s*(?=(?:nice|glad|pleased|what|can|could|would|will|how|who|where|when|why|and|i\b|please\b)))/i)
    .map((c) => c.trim())
    .filter(Boolean)

  for (const clause of clauses) {
    const cleaned = clause
      .replace(/^(?:(?:hi|hello|hey|yo|mira)(?:\s+mira)?[,!\s]+)+/i, '')
      .replace(/\s*(?:,\s*)?(?:please|thanks|thank you|for future reference|from now on)$/i, '')
      .trim()
    const m = cleaned.match(
      /^(?:please\s+)?(?:(?:remember\s+(?:that\s+)?my\s+name\s+is)|(?:my\s+name\s+is)|(?:(?:you\s+can\s+)?call\s+me))\s+([A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'’.-]*(?:\s+[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'’.-]*){0,2})$/i,
    )
    if (!m?.[1]) continue
    const candidate = m[1].replace(/[.,!?;:]+$/, '').trim()
    if (!candidate || candidate.length > 50) continue
    const words = candidate.split(/\s+/)
    if (words.length > 3) continue
    if (words.some((w) => INTRO_NON_NAME_WORDS.has(w.toLowerCase()))) continue
    const isCallMe = /\bcall\s+me\b/i.test(cleaned)
    if (isCallMe && words.length > 2) continue
    return candidate
  }
  return undefined
}

// ── Types ──────────────────────────────────────────────────────────

/** One turn-context message fed back into gateway.stream (loop working set). */
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

  private persistDoomPattern(input: {
    sessionID: string
    tool: string
    reason: string
    pattern?: string[]
    args?: Record<string, JsonValue>
    step?: number
    stepText?: string
  }): void {
    const title = `Doom loop: ${input.tool} — ${input.reason.slice(0, 80)}`
    const body = [
      `Pattern: ${input.reason}`,
      `Tool: ${input.tool}`,
      input.args ? `Args: ${JSON.stringify(input.args).slice(0, 800)}` : null,
      input.pattern?.length ? `Sequence: ${input.pattern.join(' → ')}` : null,
      input.step !== undefined ? `Step: ${input.step}` : null,
      input.stepText ? `LLM output: ${input.stepText.slice(0, 500)}` : null,
      `Session: ${input.sessionID}`,
      `At: ${new Date().toISOString()}`,
    ]
      .filter(Boolean)
      .join('\n')
    const storeInput = {
      tier: 'semantic' as const,
      source: 'system' as const,
      title,
      content: body,
      tags: ['doom-loop', 'anti-pattern', input.tool].filter(Boolean),
      metadata: {
        sessionID: input.sessionID,
        tool: input.tool,
        reason: input.reason,
        pattern: input.pattern ?? [],
        step: input.step ?? null,
        kind: 'doom_loop',
      },
    }
    const p = (this.deps.knowledge as unknown as { store?: (input: unknown) => Promise<unknown> })
      ?.store
      ? (this.deps.knowledge as unknown as { store: (input: unknown) => Promise<unknown> })
          .store(storeInput as never)
          .catch(() => {})
      : sharedKnowledge()
          .store(storeInput as never)
          .catch(() => {})
    // also publish learning signal for scheduler visibility, ignore errors
    void p
      .then(() => {
        try {
          this.deps.bus.publish({
            type: 'learning.updated',
            sessionID: input.sessionID,
            payload: { kind: 'doom_loop', tool: input.tool },
            timestamp: Date.now(),
          } as never)
        } catch {}
      })
      .catch(() => {})
  }

  /** Active runLoop AbortControllers keyed by sessionID (for POST /session/:id/abort & deleteSession). */
  private activeLoops = new Map<string, Set<AbortController>>()

  /** Queues persist in SQLite (message_queue) — survive restarts */

  constructor(private deps: SessionPromptDeps) {
    if (typeof this.deps.bus?.subscribe === 'function') {
      this.deps.bus.subscribe('session.abort', (ev) => {
        if (ev.sessionID) this.abortSession(ev.sessionID)
      })
    }
  }

  /** Abort all active prompt loops running in a session. Returns count aborted. */
  abortSession(sessionID: string): number {
    const controllers = this.activeLoops.get(sessionID)
    if (!controllers || controllers.size === 0) return 0
    let count = 0
    for (const ac of [...controllers]) {
      if (!ac.signal.aborted) {
        ac.abort()
        count++
      }
    }
    return count
  }

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
    orgID?: string | null
    cwd?: string
    projectId?: string
    /** Publish session.created on the Bus (default true; routes/forkSession set false when they enrich the payload). */
    emitEvent?: boolean
  }) {
    const id = crypto.randomUUID()
    const now = Date.now()
    // Subagent/fork children inherit owner, org, cwd, projectId, and default model from parent
    let parent: Awaited<ReturnType<SessionPrompt['getSession']>> | undefined
    if (input.parentID) {
      try {
        parent = await this.getSession(input.parentID)
      } catch {}
    }
    const ownerID = input.ownerID ?? parent?.ownerID ?? null
    const orgID =
      input.orgID ?? (parent as { orgID?: string | null } | undefined)?.orgID ?? null
    const cwd = input.cwd ?? parent?.cwd ?? null
    const projectId = input.projectId ?? parent?.projectId ?? null

    // Kilo K1+K8: explicit > agent.model > parent/session model > config default
    const effectiveModel = resolveEffectiveModel({
      explicitModel: input.model,
      agent: input.agent ?? null,
      sessionModel: parent?.model ?? undefined,
    })
    // Emit model.retired event if explicit model was retired and fallback occurred
    if (input.model && isRetired(input.model) && input.model !== effectiveModel) {
      this.deps.bus.publish({
        type: 'model.retired',
        sessionID: id,
        payload: {
          originalModel: input.model,
          fallbackModel: effectiveModel,
          reason: 'retired',
        },
        timestamp: now,
      })
    }
    // Derive the provider from the resolved model prefix ("google/gemini-2.0-flash" → "google")
    const provider = effectiveModel.includes('/')
      ? effectiveModel.split('/')[0]
      : ((getConfig().routing as { defaultProvider?: string } | undefined)?.defaultProvider ??
        'openrouter')
    const session = {
      id,
      title: input.title ?? (input.agent ? `${input.agent} session` : 'New Session'),
      model: effectiveModel,
      provider,
      createdAt: now,
      updatedAt: now,
      parentID: input.parentID ?? null,
      agent: (input.agent && isKnownAgent(input.agent) ? input.agent : null) as string | null,
      ownerID: ownerID as string | null,
      orgID: orgID as string | null,
      tokensIn: null as number | null,
      tokensOut: null as number | null,
      costUsd: null as number | null,
      cwd: cwd as string | null,
      projectId: projectId as string | null,
    }
    await this.deps.db.insert(this.deps.db.schema.sessions).values(session as never)
    if (input.emitEvent !== false) {
      this.deps.bus.publish({
        type: 'session.created',
        payload: JSON.parse(JSON.stringify(session)) as JsonValue,
        timestamp: now,
      })
    }
    return session
  }

  async getSession(id: string) {
    return this.deps.db.query.sessions.findFirst({ where: (s, { eq }) => eq(s.id, id) })
  }

  async deleteSession(id: string) {
    await this.deleteSessionInternal(id, new Set<string>(), false)
  }

  private async deleteSessionInternal(
    id: string,
    visited: Set<string>,
    emitDeletedEvent: boolean,
  ): Promise<void> {
    if (visited.has(id)) return
    visited.add(id)

    // Abort active prompt loops & background subagent/orchestrate jobs first
    this.abortSession(id)
    try {
      const { cancelJobsForParent } = await import('../tools/task.js')
      await cancelJobsForParent(this.deps.db, id, this.deps.bus)
    } catch {}
    try {
      const { cancelOrchestrateJobsForParent } = await import('../tools/orchestrate.js')
      await cancelOrchestrateJobsForParent(this.deps.db, id, this.deps.bus)
    } catch {}

    // Handle child sessions cleanly: cascade-delete ephemeral subagent children,
    // and detach user forks (parentID = null) so no dangling parentID remains.
    try {
      const children = await this.deps.db.query.sessions.findMany({
        where: (s, { eq }) => eq(s.parentID, id),
      })
      if (children.length > 0) {
        const parentJobs = await this.deps.db.query.jobs.findMany({
          where: (j, { eq }) => eq(j.parentSessionID, id),
        })
        const jobChildIds = new Set(
          parentJobs.map((j) => j.childSessionID).filter((cid): cid is string => Boolean(cid)),
        )
        for (const child of children) {
          const isSubagentChild =
            jobChildIds.has(child.id) || (child.title ?? '').startsWith('↳ ')
          if (isSubagentChild) {
            await this.deleteSessionInternal(child.id, visited, true)
          } else {
            await this.deps.db
              .update(this.deps.db.schema.sessions)
              .set({ parentID: null, updatedAt: Date.now() })
              .where(eq(this.deps.db.schema.sessions.id, child.id))
          }
        }
      }
    } catch (e) {
      console.warn('[session] child cleanup on delete failed:', String(e))
    }

    // P3.5: audit evidence deliberately SURVIVES session deletion (deleting a
    // session must not erase the compliance trail). Stamp its attribution onto
    // the rows first so they stay owner/org-scopable once the session is gone.
    try {
      const session = await this.getSession(id)
      if (session) {
        this.deps.db.sqlite
          .prepare(
            'UPDATE audit_entries SET owner_id = ?, org_id = ? WHERE session_id = ? AND owner_id IS NULL',
          )
          .run(session.ownerID ?? null, session.orgID ?? null, id)
      }
    } catch (e) {
      console.warn('[session] audit attribution on delete failed:', String(e))
    }
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
      .delete(this.deps.db.schema.jobs)
      .where(eq(this.deps.db.schema.jobs.childSessionID, id))
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
    if (emitDeletedEvent) {
      this.deps.bus.publish({
        type: 'session.deleted',
        payload: { id },
        timestamp: Date.now(),
      })
    }
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
      ownerID: source.ownerID ?? null,
      orgID: (source as { orgID?: string | null }).orgID ?? null,
      cwd: source.cwd ?? undefined,
      projectId: source.projectId ?? undefined,
      emitEvent: false,
    })

    const now = Date.now()
    // Wrap message + parts copy in a transaction: all-or-nothing on failure
    await this.deps.db.transaction(async (tx) => {
      for (const m of selected) {
        const newMessageID = crypto.randomUUID()
        await tx.insert(this.deps.db.schema.messages).values({
          id: newMessageID,
          sessionID: fork.id,
          role: m.role,
          createdAt: m.createdAt ?? now,
        })
        for (const p of m.parts ?? []) {
          const { id, ...rest } = p
          void id
          await tx.insert(this.deps.db.schema.parts).values({
            id: crypto.randomUUID(),
            ...rest,
            messageID: newMessageID,
            sessionID: fork.id,
          })
        }
      }
    })

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
    cwd?: string
    signal?: AbortSignal
    onSessionCreated?: (childSessionID: string) => void | Promise<void>
    maxDepth?: number
  }): Promise<{ sessionID: string; text: string }> {
    // Validate agent name
    const agent = opts.agent
    if (agent && !isKnownAgent(agent)) {
      const err = new Error(`Unknown agent "${agent}"`)
      ;(err as { code?: string }).code = 'UNKNOWN_AGENT'
      throw err
    }

    // Recursion depth guard — walk parentID chain (with cycle detection) before creating child session
    const cfgDepth = (
      getConfig() as MiraConfig & { orchestration?: { maxDepth?: number } }
    ).orchestration?.maxDepth
    const maxDepth = opts.maxDepth ?? cfgDepth ?? 4
    let depth = 0
    let cursor: string | null | undefined = opts.parentID
    const seen = new Set<string>()
    let directParent: Awaited<ReturnType<SessionPrompt['getSession']>> | undefined
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor)
      let p: Awaited<ReturnType<SessionPrompt['getSession']>> | undefined
      try {
        p = await this.getSession(cursor)
      } catch {}
      if (!p) break
      if (depth === 0) directParent = p
      depth++
      if (depth >= maxDepth) {
        const err = new Error(`Subagent recursion depth limit (${maxDepth}) exceeded`)
        ;(err as { code?: string }).code = 'MAX_DEPTH_EXCEEDED'
        throw err
      }
      cursor = p.parentID
    }

    // Per-agent model routing: explicit > agent.model > parent.model > default (Kilo K1+K8)
    const effectiveModel =
      resolveEffectiveModel({
        explicitModel: opts.model,
        agent: agent ?? null,
        sessionModel: directParent?.model ?? undefined,
        task: 'stream',
      }) || undefined
    // Emit model.retired if explicit model was retired
    if (opts.model && isRetired(opts.model) && opts.model !== effectiveModel) {
      this.deps.bus.publish({
        type: 'model.retired',
        sessionID: opts.parentID,
        payload: {
          originalModel: opts.model,
          fallbackModel: effectiveModel,
          reason: 'retired',
          context: 'subagent',
        },
        timestamp: Date.now(),
      })
    }
    const parentCwd = directParent?.cwd ?? undefined
    const parentProjectId = directParent?.projectId ?? undefined
    const resolvedCwd = opts.cwd ?? parentCwd
    const s = await this.createSession({
      title: opts.title ?? `↳ ${opts.prompt.slice(0, 48)}`,
      parentID: opts.parentID,
      agent: agent,
      model: effectiveModel,
      cwd: resolvedCwd,
      projectId: parentProjectId,
      ownerID: directParent?.ownerID ?? null,
      orgID: directParent?.orgID ?? null,
    })
    if (opts.onSessionCreated) {
      await opts.onSessionCreated(s.id)
    }
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
      const persona = agent ? getAgentTemplates()[agent]?.system : undefined
      const subOwner = s.ownerID ?? directParent?.ownerID ?? 'default'
      const basePrompt = await buildSystemPrompt(
        s.cwd ?? resolvedCwd ?? process.cwd(),
        await getUserNameForOwner(this.deps.db, subOwner),
      )
      const systemPrompt = persona ? `${persona}\n\n${basePrompt}` : basePrompt

      // Persist initial user prompt & assistant message placeholder so parts.* FK
      // constraints succeed and inspecting the child session shows the full transcript.
      const msgNow = Date.now()
      const userMessageID = crypto.randomUUID()
      const assistantMessageID = crypto.randomUUID()
      await this.deps.db.insert(this.deps.db.schema.messages).values({
        id: userMessageID,
        sessionID: s.id,
        role: 'user',
        createdAt: msgNow,
      })
      await this.deps.db.insert(this.deps.db.schema.parts).values({
        id: crypto.randomUUID(),
        messageID: userMessageID,
        sessionID: s.id,
        type: 'text',
        text: opts.prompt,
        createdAt: msgNow,
      })
      await this.deps.db.insert(this.deps.db.schema.messages).values({
        id: assistantMessageID,
        sessionID: s.id,
        role: 'assistant',
        createdAt: msgNow + 1,
      })

      await this.runLoop({
        sessionID: s.id,
        assistantMessageID,
        userText: opts.prompt,
        model: runModel,
        systemPrompt,
        send,
        writer: noopWriter,
        agent: agent ?? s.agent,
        signal: opts.signal,
      })
    } catch (err) {
      // Prefer a signal-abort over a generic error message so an explicitly
      // cancelled job reports "cancelled" rather than a misleading stack trace.
      text = opts.signal?.aborted ? '[subagent cancelled]' : `[subagent error] ${String(err)}`
    } finally {
      try {
        const now = Date.now()
        await this.deps.db
          .update(this.deps.db.schema.sessions)
          .set({ updatedAt: now })
          .where(eq(this.deps.db.schema.sessions.id, s.id))
      } catch {}
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
    let effectiveAgent = options?.agent ?? session.agent ?? null
    if (effectiveAgent && !isKnownAgent(effectiveAgent)) {
      console.warn(`[session] unknown agent "${effectiveAgent}" — nullifying`)
      effectiveAgent = null
    }
    const model = resolveEffectiveModel({
      explicitModel: modelOverride,
      agent: effectiveAgent,
      sessionModel: session.model,
      task: 'stream',
    })
    // Emit model.retired if override was retired and fallback occurred
    if (modelOverride && isRetired(modelOverride) && modelOverride !== model) {
      this.deps.bus.publish({
        type: 'model.retired',
        sessionID,
        payload: {
          originalModel: modelOverride,
          fallbackModel: model,
          reason: 'retired',
          context: 'stream',
        },
        timestamp: Date.now(),
      })
    }
    const effectiveOwner = session.ownerID ?? options?.callerOwner ?? 'default'
    const presentOwner = options?.callerOwner ?? undefined
    const activeOwner = presentOwner ?? effectiveOwner
    const introducedName = extractIntroducedUserName(userText)
    if (introducedName) {
      try {
        const updatedUser = await setUserNameForOwner(this.deps.db, activeOwner, introducedName)
        this.deps.bus.publish({
          type: 'me.updated',
          sessionID,
          payload: { owner: activeOwner, name: updatedUser.name },
          timestamp: updatedUser.updatedAt,
        })
      } catch {}
    }

    const ownerUser = await getUserByOwner(this.deps.db, effectiveOwner)
    const presentUserName = presentOwner
      ? await getUserNameForOwner(this.deps.db, presentOwner)
      : undefined
    const rawBasePrompt = await buildSystemPrompt(
      session.cwd ?? process.cwd(),
      ownerUser.name,
      // Who is present this turn (P3.3): same-org member ≠ absent session owner
      presentUserName,
    )
    const profileBio =
      ownerUser.profile &&
      typeof ownerUser.profile === 'object' &&
      typeof ownerUser.profile.bio === 'string'
        ? ownerUser.profile.bio.trim()
        : ''
    const basePrompt = profileBio
      ? `${rawBasePrompt}\n\nUser profile note: ${profileBio}`
      : rawBasePrompt
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
    // Auto-title (once): a still-default session takes its name from the first
    // user prompt. Fire-and-forget — titling must never delay or fail the turn.
    void maybeAutoTitle(this.deps.db, this.deps.bus, sessionID, session.title, userText).catch(
      () => {},
    )
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
      // Backpressure: wait if the writer is not ready
      if (!writer.ready) {
        // Skip this chunk if the consumer is too slow — prevents unbounded buffering
        return
      }
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
    // Validate agent name early — unknown agents are nullified
    if (opts.agent && !isKnownAgent(opts.agent)) {
      opts.agent = null
    }
    const { sessionID, assistantMessageID, model, systemPrompt, send, writer } = opts
    const tracer = otelTrace.getTracer('mira-server')
    const span = tracer.startSpan('session.prompt.loop', {
      attributes: { session_id: sessionID, prompt_id: assistantMessageID },
    })
    const limits = getLoopLimits()
    const MAX_STEPS = opts.maxSteps ?? limits.maxSteps
    const loopAC = new AbortController()
    const onOuterAbort = () => loopAC.abort()
    if (opts.signal) {
      if (opts.signal.aborted) loopAC.abort()
      else opts.signal.addEventListener('abort', onOuterAbort, { once: true })
    }
    let loopSet = this.activeLoops.get(sessionID)
    if (!loopSet) {
      loopSet = new Set()
      this.activeLoops.set(sessionID, loopSet)
    }
    loopSet.add(loopAC)
    const loopSignal = loopAC.signal

    let step = 0
    let accumulatedText = ''
    let accumulatedReasoning = ''
    let turnHadError = false
    this.getDoomDetector(sessionID).reset()
    const maxDoomRecoveriesRaw = Number(process.env.MIRA_DOOM_MAX_RECOVERIES ?? 3)
    const MAX_DOOM_RECOVERIES =
      Number.isFinite(maxDoomRecoveriesRaw) && maxDoomRecoveriesRaw >= 0
        ? Math.floor(maxDoomRecoveriesRaw)
        : 3
    let doomRecoveryCount = 0
    let activeDoomGuidance: string | null = null
    const doomAdjustmentHistory: string[] = []
    const blockedLoopFingerprints = new Map<
      string,
      { reason: string; tool: string; pattern?: string[] }
    >()
    const lf = initLangfuse()
    const trace = lf?.trace?.('session') ?? { update: () => {}, end: () => {} }
    // usage-learning counters for recordSession at finalize
    const t0 = Date.now()
    let toolCallCount = 0,
      toolErrorCount = 0,
      doomLoopCount = 0,
      compactionCount = 0
    let totalTokensIn = 0,
      totalTokensOut = 0

    try {
    // Load conversation history
    let messages = await this.loadContext(sessionID, systemPrompt)
    // Resolve session cwd for tool execution (P0-1: thread cwd through prompt/tools)
    let sessionCwd: string | undefined
    try {
      const s = await this.getSession(sessionID)
      sessionCwd = s?.cwd ?? undefined
    } catch {}

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
      let stepDoomed = false
      let stepAdjusted = false

      // Honour an explicit cancellation (e.g. cancelJob / /session/:id/abort) between steps —
      // abort the run promptly rather than waiting for the next stream call.
      if (loopSignal.aborted) {
        send('aborted', { step, reason: 'cancelled' })
        break loop
      }

      // ── Cost cap guard (Kilo K8) — perTask / perSession in USD, per subgateway ───────
      try {
        const lane = resolveLane(model)
        const laneCapNum = laneCostCap(lane)
        const globalCap = (
          getConfig() as MiraConfig & { costCap?: { perTask?: number; perSession?: number } }
        ).costCap
        const effectiveCap: { perTask?: number; perSession?: number } | undefined = globalCap ?? (
          Number.isFinite(laneCapNum) ? { perTask: laneCapNum, perSession: laneCapNum } : undefined
        )
        const curCost = estimateCostUSD(model, totalTokensIn, totalTokensOut)
        if (effectiveCap?.perTask !== undefined && curCost > effectiveCap.perTask) {
          const msg = `Cost cap exceeded: $${curCost.toFixed(4)} > $${effectiveCap.perTask.toFixed(4)} per-task limit (model ${model}, lane ${lane}, step ${step}). Aborting.`
          turnHadError = true
          send('error', { error: msg })
          this.deps.bus.publish({
            type: 'server.error',
            sessionID,
            payload: {
              error: msg,
              source: 'cost-cap',
              cap: effectiveCap.perTask,
              lane,
            } as JsonValue,
            timestamp: Date.now(),
          })
          accumulatedText += `\n\n[System: ${msg}]\n`
          await this.upsertTextPart(assistantMessageID, sessionID, accumulatedText)
          break loop
        }
        if (effectiveCap?.perSession !== undefined) {
          const sessCost = sessionBaseCost + curCost
          if (sessCost > effectiveCap.perSession) {
            const msg = `Cost cap exceeded: $${sessCost.toFixed(4)} > $${effectiveCap.perSession.toFixed(4)} per-session limit (model ${model}, lane ${lane}, step ${step}). Aborting.`
            turnHadError = true
            send('error', { error: msg })
            this.deps.bus.publish({
              type: 'server.error',
              sessionID,
              payload: {
                error: msg,
                source: 'cost-cap',
                cap: effectiveCap.perSession,
                lane,
              } as JsonValue,
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
        // Compaction uses cheap lane (oracle: summarize→compaction, compaction uses cheap model)
        const compactionGateway = (() => {
          const router = getRouter(this.deps.gateway)
          if (router) return router.getCompactionGateway()
          // Fallback: use cheap lane via registry if available
          const reg = getRegistry(this.deps.gateway)
          if (reg) return reg.getOrDefault('compaction')
          return this.deps.gateway
        })()
        let result: Awaited<ReturnType<typeof compactMessages>>
        try {
          result = await compactMessages(compactionGateway, messages, {
            smallModel: limits.smallModel,
            contextLimit,
            threshold,
          })
        } catch (compErr) {
          // Compaction failed — log and stop the loop to avoid exceeding context window
          const errMsg = compErr instanceof Error ? compErr.message : String(compErr)
          console.error(
            `[session] compaction failed at step ${step} (session ${sessionID}):`,
            errMsg,
          )
          send('error', { error: `Compaction failed: ${errMsg}` })
          this.deps.bus.publish({
            type: 'server.error',
            sessionID,
            payload: {
              error: `Compaction failed: ${errMsg}`,
              source: 'compaction',
              step,
            } as JsonValue,
            timestamp: Date.now(),
          })
          break loop
        }
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

      // ── LLM.stream (Vercel AI SDK v5) with transient retry ──
      send('step_start', { step, model })
      let streamMessages = pruneReasoning(messages)
      streamMessages = summarizeToolTraces(streamMessages, step)
      let stepText = ''
      let stepReasoning = ''
      const toolCalls: Array<{ id: string; name: string; args: Record<string, JsonValue> }> = []
      let lastFlush = Date.now()
      let lastPersistedLen = accumulatedText.length

      const isTransientStreamErr = (err: unknown): boolean => {
        if (!err || loopSignal.aborted) return false
        const e = err as { name?: string; code?: string; status?: number; statusCode?: number; message?: string }
        if (e.name === 'AbortError') return false
        if (e.code === 'NO_API_KEY' || e.code === 'UNAUTHORIZED') return false
        const status = e.status ?? e.statusCode
        if (status && [400, 401, 403, 404, 410].includes(status)) return false
        if (status && (status === 429 || status >= 500)) return true
        const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
        if (msg.includes('gateway 400') || msg.includes('gateway 401') || msg.includes('gateway 403') || msg.includes('gateway 404') || msg.includes('gateway 410')) return false
        return (
          msg.includes('429') ||
          msg.includes('502') ||
          msg.includes('503') ||
          msg.includes('504') ||
          msg.includes('timeout') ||
          msg.includes('timed out') ||
          msg.includes('econnreset') ||
          msg.includes('etimedout') ||
          msg.includes('socket hang up') ||
          msg.includes('fetch failed') ||
          msg.includes('network')
        )
      }

      const effectiveCwd = sessionCwd ?? process.cwd()
      const approachingHint = this.getDoomDetector(sessionID).getApproachingWarning()
      const guidanceSections: string[] = [
        `[Workspace Context]\nCurrent working directory (cwd): ${effectiveCwd}. Use relative paths (e.g. ".") or paths inside ${effectiveCwd} when calling read, glob, grep, edit, or write. Do not invent paths outside cwd (such as /workspace).`,
      ]
      if (activeDoomGuidance) {
        guidanceSections.push(`[DOOM-LOOP DETECTED — ADJUST STRATEGY NOW]\n${activeDoomGuidance}`)
      } else if (doomAdjustmentHistory.length > 0) {
        guidanceSections.push(
          `[Prior doom-loop adjustments in this turn — do NOT repeat blocked approaches]\n${doomAdjustmentHistory.map((g) => `- ${g}`).join('\n')}`,
        )
      }
      if (approachingHint) {
        guidanceSections.push(`[Loop Awareness]\n${approachingHint}`)
      }
      const effectiveSystemPrompt =
        guidanceSections.length > 0
          ? `${systemPrompt}\n\n${guidanceSections.join('\n\n')}`
          : systemPrompt
      activeDoomGuidance = null

      const maxStreamAttempts = 3
      let streamDone = false
      for (let attempt = 1; attempt <= maxStreamAttempts && !streamDone; attempt++) {
        try {
          const stream = await this.deps.gateway.stream({
            model,
            messages: streamMessages,
            tools: this.filterToolsForAgent(opts.agent), // lane-contract enforcement (agent allowlist)
            system: effectiveSystemPrompt,
            signal: loopSignal,
            sessionID,
          })

          for await (const chunk of stream) {
            if (chunk.type === 'reasoning-delta' && chunk.text) {
              stepReasoning += chunk.text
              accumulatedReasoning += chunk.text
              send('reasoning_delta', { delta: chunk.text, step })
            } else if (chunk.type === 'text-delta' && chunk.text) {
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
                if (!accumulatedText.trim() && accumulatedReasoning.trim()) {
                  accumulatedText = accumulatedReasoning.trim()
                  send('text_delta', { delta: accumulatedText, step })
                }
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
              turnHadError = true
              send('error', chunk)
              break loop
            }
          }
          streamDone = true
        } catch (streamErr) {
          const canRetry =
            attempt < maxStreamAttempts &&
            stepText.length === 0 &&
            toolCalls.length === 0 &&
            isTransientStreamErr(streamErr)
          if (canRetry) {
            const backoffMs = attempt * 900
            console.warn(
              `[mira] transient stream error (session ${sessionID}, attempt ${attempt}/${maxStreamAttempts}), retrying in ${backoffMs}ms: ${streamErr instanceof Error ? streamErr.message : String(streamErr)}`,
            )
            await new Promise((r) => setTimeout(r, backoffMs))
            continue
          }
          turnHadError = true
          const errObj = streamErr as { message?: string; code?: string; provider?: string }
          const errCode = typeof errObj?.code === 'string' ? errObj.code : undefined
          const errProvider = typeof errObj?.provider === 'string' ? errObj.provider : undefined
          const errMsg = streamErr instanceof Error ? streamErr.message : String(streamErr)
          if (errCode === 'NO_API_KEY') {
            console.warn(`[mira] session ${sessionID} paused: ${errMsg}`)
          } else {
            console.error(`[mira] stream error (session ${sessionID}): ${errMsg}`)
          }
          send('error', {
            error: errMsg,
            ...(errCode ? { code: errCode } : {}),
            ...(errProvider ? { provider: errProvider } : {}),
          })
          this.deps.bus.publish({
            type: 'server.error',
            sessionID,
            payload: {
              error: errMsg,
              source: errCode === 'NO_API_KEY' ? 'provider' : 'stream',
              ...(errCode ? { code: errCode } : {}),
              ...(errProvider ? { provider: errProvider } : {}),
            } as JsonValue,
            timestamp: Date.now(),
          })
          const notice =
            errCode === 'NO_API_KEY'
              ? `⚠️ ${errMsg}. Open Connect to configure a provider API key.`
              : `⚠️ ${errMsg}`
          accumulatedText = accumulatedText ? `${accumulatedText}\n\n${notice}` : notice
          await this.upsertTextPart(assistantMessageID, sessionID, accumulatedText)
          lastPersistedLen = accumulatedText.length
          break loop
        }
      }

      // If accumulatedText is still empty but we have reasoning and no tool calls, promote it
      if (!accumulatedText.trim() && accumulatedReasoning.trim() && toolCalls.length === 0) {
        accumulatedText = accumulatedReasoning.trim()
        send('text_delta', { delta: accumulatedText, step })
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
        if (stepAdjusted) {
          const skipped = 'Skipped due to doom-loop strategy adjustment — review the adjustment guidance and change approach.'
          send('tool_result', { toolCallID: tc.id, name: tc.name, result: { error: skipped }, isError: true })
          await this.persistToolResult(assistantMessageID, sessionID, tc, { error: skipped }, true)
          toolResults.push({
            toolCallID: tc.id,
            name: tc.name,
            result: { error: skipped },
            isError: true,
          })
          continue
        }

        // Doom-loop detection — per-session (two-stage: warn & adjust first, hard-break if repeated)
        const detector = this.getDoomDetector(sessionID)
        const fp = detector.fingerprintOf(tc.name, tc.args)
        const priorBlocked = blockedLoopFingerprints.get(fp)
        const doomSignal = priorBlocked
          ? {
              detected: true,
              reason: priorBlocked.reason,
              tool: tc.name,
              pattern: priorBlocked.pattern,
            }
          : detector.check({ name: tc.name, args: tc.args })
        if (doomSignal.detected) {
          if (doomRecoveryCount < MAX_DOOM_RECOVERIES) {
            doomRecoveryCount++
            if (!priorBlocked) {
              blockedLoopFingerprints.set(fp, {
                reason: doomSignal.reason ?? 'repeating tool call',
                tool: tc.name,
                pattern: doomSignal.pattern,
              })
            }
            detector.reset()
            const extraHint =
              tc.name === 'bash'
                ? ' If bash failed due to sandbox/container runtime limits, stop calling bash and use glob, grep, read, write, or edit tools directly instead.'
                : ` Use paths inside cwd "${effectiveCwd}" (or relative ".") instead of external paths.`
            const adjustMsg = `${priorBlocked ? 'FINAL ADJUSTMENT WARNING: ' : ''}Doom-loop detected (${doomSignal.reason ?? 'repeating tool call'}) for tool "${tc.name}" at step ${step} (recovery ${doomRecoveryCount}/${MAX_DOOM_RECOVERIES}). Execution of this repeated call was blocked so you can adjust strategy. Do NOT repeat "${tc.name}" with the same arguments; switch tools or arguments, or report findings to the user.${extraHint}`
            send('doom_loop_adjusted', {
              tool: tc.name,
              args: tc.args,
              step,
              reason: doomSignal.reason,
              pattern: doomSignal.pattern,
              attempt: doomRecoveryCount,
              maxAttempts: MAX_DOOM_RECOVERIES,
              message: adjustMsg,
            })
            send('tool_result', {
              toolCallID: tc.id,
              name: tc.name,
              result: { error: adjustMsg, doomLoopDetected: true, action: 'adjust' },
              isError: true,
            })
            await this.persistToolResult(assistantMessageID, sessionID, tc, { error: adjustMsg }, true)
            toolResults.push({
              toolCallID: tc.id,
              name: tc.name,
              result: { error: adjustMsg, doomLoopDetected: true, action: 'adjust' },
              isError: true,
            })
            activeDoomGuidance = adjustMsg
            doomAdjustmentHistory.push(
              `Step ${step}: Avoid repeating ${tc.name} with args ${JSON.stringify(tc.args).slice(0, 100)} (${doomSignal.reason ?? 'repeating tool call'})`,
            )
            stepAdjusted = true
            continue
          }

          const msg = `Doom-loop detected: ${doomSignal.reason ?? 'repeating tool call'} — tool "${tc.name}". Breaking loop and asking user.`
          send('doom_loop', {
            tool: tc.name,
            args: tc.args,
            step,
            reason: doomSignal.reason,
            pattern: doomSignal.pattern,
          })
          this.deps.bus.publish({
            type: 'server.error',
            sessionID,
            payload: {
              error: msg,
              source: 'doom-loop',
              tool: tc.name,
              pattern: doomSignal.pattern,
            } as JsonValue,
            timestamp: Date.now(),
          })
          await this.persistToolResult(assistantMessageID, sessionID, tc, { error: msg }, true)
          doomLoopCount++
          stepDoomed = true
          this.persistDoomPattern({
            sessionID,
            tool: tc.name,
            reason: doomSignal.reason ?? 'repeating tool call',
            pattern: doomSignal.pattern,
            args: tc.args,
            step,
          })
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
          // Template-level bash allowlist (e.g. plan agent: read+bash, no writes).
          // Denied here even when the permission layer would merely ask.
          if (!perm && tpl?.bashAllowlist?.length && tc.name === 'bash') {
            const cmd = (tc.args as Record<string, JsonValue>).command as string | undefined
            if (!cmd || !isBashCommandAllowed(cmd, tpl.bashAllowlist)) {
              perm = {
                action: 'deny',
                reason: `lane contract: agent "${opts.agent}" — bash command not in template allowlist (${(cmd ?? '').slice(0, 60)})`,
              }
            }
          }
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
          // Publish permission.ask → Web/TUI shows prompt → user replies via WS or REST → permission.reply
          // Nonce prevents reply spoofing — must be echoed back in permission.reply
          const nonce = crypto.randomUUID()
          const cfgTimeout = Number(
            process.env.MIRA_PERMISSION_TIMEOUT_MS ??
              (getConfig().loop as { permissionTimeoutMs?: number } | undefined)?.permissionTimeoutMs ??
              300_000,
          )
          const permissionTimeoutMs = Number.isFinite(cfgTimeout) && cfgTimeout > 0 ? cfgTimeout : 300_000
          const expiresAt = Date.now() + permissionTimeoutMs
          const askPayload = {
            sessionID,
            toolCallID: tc.id,
            tool: tc.name,
            args: tc.args,
            nonce,
            reason: perm.reason ?? 'Requires user approval',
            risk: perm.risk?.riskLevel ?? null,
            blastRadius: perm.approvalPayload?.blastRadius ?? null,
            canUndo: perm.approvalPayload?.canUndo ?? perm.risk?.isReversible ?? null,
            timeoutMs: permissionTimeoutMs,
            expiresAt,
          }
          send('permission_ask', askPayload)
          this.deps.bus.publish({
            type: 'permission.ask',
            sessionID,
            payload: askPayload,
            timestamp: Date.now(),
          })

          const onAbortDuringPerm = () => {
            this.deps.bus.cancelPermissionWait?.(tc.id, 'deny')
          }
          loopSignal.addEventListener('abort', onAbortDuringPerm, { once: true })

          let decision: 'allow' | 'deny' = 'deny'
          let timedOut = false
          let timeoutErrMsg = ''
          try {
            decision = await this.deps.bus.waitForPermissionReply(
              tc.id,
              nonce,
              permissionTimeoutMs,
              {
                sessionID,
                tool: tc.name,
                args: tc.args,
                reason: perm.reason,
                risk: perm.risk?.riskLevel,
                blastRadius: perm.approvalPayload?.blastRadius,
                canUndo: perm.approvalPayload?.canUndo ?? perm.risk?.isReversible,
              },
            )
          } catch (permErr) {
            timedOut = true
            timeoutErrMsg = permErr instanceof Error ? permErr.message : String(permErr)
          } finally {
            loopSignal.removeEventListener('abort', onAbortDuringPerm)
          }

          if (loopSignal.aborted) {
            const err = `Aborted while waiting permission for ${tc.name}`
            send('tool_result', { toolCallID: tc.id, name: tc.name, error: err, isError: true })
            await this.persistToolResult(assistantMessageID, sessionID, tc, { error: err }, true)
            break loop
          }

          if (timedOut) {
            const guidance = `${timeoutErrMsg}. No approval was received before timeout; explain what you needed approval for and continue with any safe read-only steps or ask the user how to proceed.`
            send('permission_timeout', { toolCallID: tc.id, tool: tc.name, error: timeoutErrMsg })
            send('tool_result', {
              toolCallID: tc.id,
              name: tc.name,
              result: { error: guidance },
              isError: true,
            })
            this.deps.bus.publish({
              type: 'permission.timeout',
              sessionID,
              payload: {
                toolCallID: tc.id,
                tool: tc.name,
                error: timeoutErrMsg,
                timeoutMs: permissionTimeoutMs,
              } as JsonValue,
              timestamp: Date.now(),
            })
            await this.persistToolResult(assistantMessageID, sessionID, tc, { error: guidance }, true)
            toolResults.push({
              toolCallID: tc.id,
              name: tc.name,
              result: { error: guidance },
              isError: true,
            })
            continue
          }

          if (decision !== 'allow') {
            const err = `User denied ${tc.name}`
            send('tool_result', { toolCallID: tc.id, name: tc.name, error: err, isError: true })
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
            signal: loopSignal,
            cwd: sessionCwd ?? process.cwd(),
            agent: opts.agent ?? null,
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

        // Doom-loop detection for repeated errors (two-stage: warn & adjust first, hard-break if repeated)
        if (isError) {
          const errKey = `err:${tc.name}:${JSON.stringify(result ?? '').slice(0, 200)}`
          const priorErrBlocked = blockedLoopFingerprints.get(errKey)
          const errSignal = priorErrBlocked
            ? { detected: true, reason: priorErrBlocked.reason, tool: tc.name }
            : this.getDoomDetector(sessionID).checkError(tc.name, result)
          if (errSignal.detected) {
            if (doomRecoveryCount < MAX_DOOM_RECOVERIES) {
              doomRecoveryCount++
              if (!priorErrBlocked) {
                blockedLoopFingerprints.set(errKey, {
                  reason: errSignal.reason ?? 'repeating error',
                  tool: tc.name,
                })
              }
              if (!blockedLoopFingerprints.has(fp)) {
                blockedLoopFingerprints.set(fp, {
                  reason: errSignal.reason ?? 'repeating error',
                  tool: tc.name,
                })
              }
              this.getDoomDetector(sessionID).reset()
              const errSnippet = JSON.stringify(result ?? '').slice(0, 180)
              const envHint = errSnippet.toLowerCase().includes('outside allowed roots')
                ? ` Use relative paths (".") or paths inside cwd "${effectiveCwd}" instead.`
                : errSnippet.toLowerCase().includes('container runtime')
                  ? ' Bash is unavailable in this environment; use glob, grep, read, write, or edit directly.'
                  : ''
              const adjustMsg = `Doom-loop detected (${errSignal.reason ?? 'repeating error'}) on tool "${tc.name}" at step ${step} (recovery ${doomRecoveryCount}/${MAX_DOOM_RECOVERIES}; error: ${errSnippet}). Stop repeating this failing pattern.${envHint} Analyze why "${tc.name}" failed, try a different tool or valid arguments, or tell the user what is blocked.`
              send('doom_loop_adjusted', {
                tool: tc.name,
                args: tc.args,
                step,
                reason: errSignal.reason,
                attempt: doomRecoveryCount,
                maxAttempts: MAX_DOOM_RECOVERIES,
                message: adjustMsg,
              })
              await this.persistToolResult(
                assistantMessageID,
                sessionID,
                tc,
                { error: adjustMsg, originalError: result },
                true,
              )
              toolResults.push({
                toolCallID: tc.id,
                name: tc.name,
                result: {
                  error: adjustMsg,
                  originalError: result,
                  doomLoopDetected: true,
                  action: 'adjust',
                },
                isError: true,
              })
              this.deps.bus.publish({
                type: 'part.created',
                sessionID,
                payload: { tool: tc.name, toolCallID: tc.id, result: { error: adjustMsg } },
                timestamp: Date.now(),
              })
              activeDoomGuidance = adjustMsg
              doomAdjustmentHistory.push(
                `Step ${step}: Avoid repeating failing ${tc.name} with args ${JSON.stringify(tc.args).slice(0, 100)} (${errSignal.reason ?? 'repeating error'})`,
              )
              stepAdjusted = true
              continue
            }

            const msg = `Doom-loop detected: ${errSignal.reason ?? 'repeating error'} — tool "${tc.name}". Breaking loop and asking user.`
            send('doom_loop', {
              tool: tc.name,
              args: tc.args,
              step,
              reason: errSignal.reason,
            })
            this.deps.bus.publish({
              type: 'server.error',
              sessionID,
              payload: {
                error: msg,
                source: 'doom-loop',
                tool: tc.name,
              } as JsonValue,
              timestamp: Date.now(),
            })
            await this.persistToolResult(assistantMessageID, sessionID, tc, { error: msg }, true)
            doomLoopCount++
            stepDoomed = true
            this.persistDoomPattern({
              sessionID,
              tool: tc.name,
              reason: errSignal.reason ?? 'repeating error',
              args: tc.args,
              step,
            })
            accumulatedText += `\n\n[System: ${msg}]\n`
            messages.push({ role: 'assistant', content: accumulatedText })
            messages.push({
              role: 'user',
              content: `[Doom-loop guard: ${msg} — please clarify or adjust.]`,
            })
            // break loop (not just for) — same as tool-call doom
            break loop
          }
        }

        // P0-2: auto-append successful write/edit/finding_write to active_work.md (non-blocking, never throws)
        if (
          !isError &&
          (tc.name === 'write' || tc.name === 'edit' || tc.name === 'finding_write')
        ) {
          try {
            const args = tc.args as Record<string, unknown>
            let summary = ''
            let filePath: string | undefined
            if (tc.name === 'write') {
              filePath = typeof args.path === 'string' ? args.path : undefined
              summary =
                typeof args.content === 'string'
                  ? args.content.slice(0, 200)
                  : JSON.stringify(args).slice(0, 200)
            } else if (tc.name === 'edit') {
              filePath = typeof args.path === 'string' ? args.path : undefined
              summary =
                typeof args.newString === 'string'
                  ? args.newString.slice(0, 200)
                  : JSON.stringify(args).slice(0, 200)
            } else {
              // finding_write
              const title = typeof args.title === 'string' ? args.title : ''
              const evidence = typeof args.evidence === 'string' ? args.evidence : ''
              summary = `${title}${evidence ? ` — ${evidence}` : ''}`.slice(0, 200)
              filePath = title || undefined
            }
            void appendActiveWork({
              tool: tc.name,
              path: filePath,
              summary,
              cwd: sessionCwd ?? process.cwd(),
            })
          } catch (e) {
            console.warn('[prompt] appendActiveWork failed:', String(e))
          }
        }

        await this.persistToolResult(assistantMessageID, sessionID, tc, result, isError)
        toolResults.push({ toolCallID: tc.id, name: tc.name, result, isError })
        this.deps.bus.publish({
          type: 'part.created',
          sessionID,
          payload: { tool: tc.name, toolCallID: tc.id, result },
          timestamp: Date.now(),
        })
      }

      // Doom-loop detection for repeated LLM outputs — skip if already doomed or adjusted this step
      if (!stepDoomed && !stepAdjusted) {
        const llmSignal = this.getDoomDetector(sessionID).checkLLMOutput(stepText)
        if (llmSignal.detected) {
          if (doomRecoveryCount < MAX_DOOM_RECOVERIES) {
            doomRecoveryCount++
            this.getDoomDetector(sessionID).reset()
            const adjustMsg = `Doom-loop detected (${llmSignal.reason ?? 'repeating LLM output'}) at step ${step}. You repeated the same response without progress. Change your strategy: use a different diagnostic tool, adjust arguments, or provide a direct final answer to the user.`
            send('doom_loop_adjusted', {
              tool: 'llm-output',
              step,
              reason: llmSignal.reason,
              attempt: doomRecoveryCount,
              maxAttempts: MAX_DOOM_RECOVERIES,
              message: adjustMsg,
            })
            activeDoomGuidance = adjustMsg
            doomAdjustmentHistory.push(`Step ${step}: Avoid repeating identical assistant output`)
            stepAdjusted = true
          } else {
            const msg = `Doom-loop detected: ${llmSignal.reason ?? 'repeating LLM output'} — breaking loop and asking user.`
            send('doom_loop', {
              step,
              reason: llmSignal.reason,
            })
            this.deps.bus.publish({
              type: 'server.error',
              sessionID,
              payload: {
                error: msg,
                source: 'doom-loop',
                tool: 'llm-output',
              } as JsonValue,
              timestamp: Date.now(),
            })
            doomLoopCount++
            this.persistDoomPattern({
              sessionID,
              tool: 'llm-output',
              reason: llmSignal.reason ?? 'repeating LLM output',
              pattern: llmSignal.pattern,
              step,
              stepText,
            })
            accumulatedText += `\n\n[System: ${msg}]\n`
            messages.push({ role: 'assistant', content: accumulatedText })
            messages.push({
              role: 'user',
              content: `[Doom-loop guard: ${msg} — please clarify or adjust.]`,
            })
            break
          }
        }
      }

      // ── finish-step: append tool results to context for next iteration ──
      messages.push({ role: 'assistant', content: stepText, toolCalls })
      for (const tr of toolResults) {
        messages.push({
          role: 'tool',
          toolCallID: tr.toolCallID,
          toolResults: [tr],
          content: JSON.stringify(tr.result ?? null),
          isExecutorContext: true,
        })
      }

      // Also persist accumulated text so far
      await this.upsertTextPart(assistantMessageID, sessionID, accumulatedText)
    }

    if (step >= MAX_STEPS && !turnHadError && !loopSignal.aborted) {
      const limitNote = `\n\n[Reached maximum step limit (${MAX_STEPS}). Send "continue" to resume from here.]`
      if (!accumulatedText.includes('Reached maximum step limit')) {
        accumulatedText = accumulatedText ? `${accumulatedText}${limitNote}` : limitNote.trim()
        send('text_delta', { delta: limitNote, step })
      }
    }

    if (!turnHadError && !loopSignal.aborted && accumulatedText.trim().length === 0 && toolCallCount === 0) {
      if (accumulatedReasoning.trim().length > 0) {
        accumulatedText = accumulatedReasoning.trim()
      } else {
        accumulatedText = '(No response received from model)'
      }
      send('text_delta', { delta: accumulatedText, step })
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
          userFeedback: undefined,
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
        const costDelta = estimateCostUSD(model, totalTokensIn, totalTokensOut)
        this.deps.db.sqlite
          .prepare(
            `UPDATE sessions SET tokens_in = COALESCE(tokens_in, 0) + ?, tokens_out = COALESCE(tokens_out, 0) + ?, cost_usd = COALESCE(cost_usd, 0) + ?, updated_at = ? WHERE id = ?`,
          )
          .run(totalTokensIn, totalTokensOut, costDelta, Date.now(), sessionID)
        // Emit cost.warning if session is near or over cost cap
        const cfg = getConfig() as MiraConfig & { costCap?: { perSession?: number } }
        const perSessionCap = cfg.costCap?.perSession
        if (perSessionCap) {
          const sessCost = getSessionCost(sessionID)
          if (sessCost.costUSD >= perSessionCap * 0.9) {
            this.deps.bus.publish({
              type: 'cost.warning',
              sessionID,
              payload: {
                currentUSD: sessCost.costUSD,
                capUSD: perSessionCap,
                pct: Math.round((sessCost.costUSD / perSessionCap) * 100),
                inputTokens: sessCost.inputTokens,
                outputTokens: sessCost.outputTokens,
                requests: sessCost.requests,
              },
              timestamp: Date.now(),
            })
          }
        }
      } catch {}
    }
    try {
      await writer.close()
    } catch {}
    opts.onStreamClosed?.()

    // ── Drain queued messages: chain next turn automatically ──
    if (!turnHadError && !loopSignal.aborted) {
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
    }
    } finally {
      if (opts.signal) opts.signal.removeEventListener('abort', onOuterAbort)
      const set = this.activeLoops.get(sessionID)
      if (set) {
        set.delete(loopAC)
        if (set.size === 0) this.activeLoops.delete(sessionID)
      }
      span.end()
    }
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
    // Validate agent known — unknown agents get empty toolset
    if (!isKnownAgent(agent)) return {}
    const tpl = getAgentTemplates()[agent]
    if (!tpl) return {}
    if (!tpl.tools?.length) return all
    const allow = new Set<string>(tpl.tools)
    return Object.fromEntries(Object.entries(all).filter(([name]) => allow.has(name)))
  }

  private async loadContext(sessionID: string, systemPrompt: string): Promise<LoopMessage[]> {
    const messages = await this.getMessages(sessionID)
    const session = await this.getSession(sessionID)
    const sessionCwd = session?.cwd ?? process.cwd()
    // Hierarchical memory: systemPrompt already contains AGENTS.md via buildSystemPrompt (project instructions)
    // This method wires L1 working (messages) + L2 episodic (todos/findings) + L3 semantic (knowledge) + procedural (skills) + Memory Bank (Kilo K3)
    const context: LoopMessage[] = [{ role: 'system', content: systemPrompt }]
    // Ensure memory_bank exists on boot (idempotent, non-blocking) — P0-2
    try {
      void ensureMemoryBank(sessionCwd)
    } catch {}
    // Memory Bank (Kilo K3 parity) — flat file notes that survive restarts, injected before other memory
    try {
      const bank = await this.loadMemoryBank(sessionCwd)
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
    // Strategic memory: active long-term goals steer decisions toward stated objectives
    try {
      const gctx = sharedGoals()?.activeGoalsForContext()
      if (gctx) context.push({ role: 'system', content: gctx })
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
            content: `Relevant memory:\n${docs.map((d) => `- [§${d.id}] [${d.title}]: ${d.content.slice(0, 300)}`).join('\n')}`,
          })
        }
      } catch {}
    }
    // Doom-loop anti-patterns (HCM write-back recall): surface prior loop
    // patterns so the model avoids repeating them. Fire-and-forget safe.
    try {
      const doomDocs = this.deps.knowledge
        ? await (
            this.deps.knowledge.retrieve as (
              o: unknown,
            ) => Promise<Array<{ id: string; title: string; content: string; tags?: string[] }>>
          )({
            query: 'doom-loop anti-pattern avoid repeat',
            limit: 2,
            tier: 'semantic',
            minScore: 0.05,
          } as never)
        : await searchKnowledge('doom-loop anti-pattern avoid repeat', 2)
      const loops = (doomDocs ?? []).filter(
        (d) =>
          (d.tags ?? []).some((t) => t.toLowerCase().includes('doom')) ||
          `${d.title} ${d.content}`.toLowerCase().includes('doom loop'),
      )
      if (loops.length) {
        for (const d of loops) this.trackInjectedMemory(sessionID, d)
        context.push({
          role: 'system',
          content: `Known doom-loop anti-patterns — avoid repeating:\n${loops.map((d) => `- [§${d.id}] [${d.title}]: ${d.content.slice(0, 300)}`).join('\n')}`,
        })
      }
    } catch {}
    const availableToolResultIds = new Set<string>()
    for (const m of messages) {
      for (const p of m.parts ?? []) {
        if (p.type === 'tool-result' && p.toolCallID) {
          availableToolResultIds.add(p.toolCallID)
        }
      }
    }
    const emittedToolCallIds = new Set<string>()

    for (const m of messages) {
      const parts = m.parts ?? []
      const text = parts
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('\n')
      const pairedCalls = parts
        .filter(
          (p): p is typeof p & { toolCallID: string; tool: string } =>
            p.type === 'tool-call' &&
            !!p.toolCallID &&
            !!p.tool &&
            availableToolResultIds.has(p.toolCallID),
        )
        .map((p) => {
          emittedToolCallIds.add(p.toolCallID)
          return {
            id: p.toolCallID,
            name: p.tool,
            args: (p.args ?? {}) as Record<string, JsonValue>,
          }
        })

      if (pairedCalls.length > 0) {
        context.push({
          role: 'assistant',
          content: text,
          toolCalls: pairedCalls,
        })
      } else if (text && text.trim().length > 0) {
        context.push({ role: m.role, content: text })
      }

      for (const p of parts) {
        if (p.type !== 'tool-result' || !p.toolCallID) continue
        if (!emittedToolCallIds.has(p.toolCallID)) continue
        context.push({
          role: 'tool',
          content: JSON.stringify(p.result ?? null),
          toolCallID: p.toolCallID,
          isExecutorContext: true,
        })
      }
    }
    return context
  }

  /** Memory Bank loader — reads data/memory_bank/*.md if present (Kilo parity, flat file notes). */
  private async loadMemoryBank(cwd = process.cwd()): Promise<string | null> {
    // Resolve memory_bank sibling to the SQLite DB (MIRA_DB) or fallback to ./data/memory_bank
    const candidates: string[] = []
    const envDB = process.env.MIRA_DB
    if (envDB) {
      const slash = envDB.lastIndexOf('/')
      if (slash >= 0) candidates.push(`${envDB.slice(0, slash)}/memory_bank`)
    }
    candidates.push(`${cwd}/data/memory_bank`)
    candidates.push(`${cwd}/packages/server/data/memory_bank`)
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

// Mira Patch (2026-09-23): Reduce token cost: summarize tool results >500 chars, compact at 60% window, batch reads. Evidence: nvidia/meta/muse-glimmer-30b avg 46163 tokens (budget 20k); overall avg 23082 tokens/session


// Re-export types and helpers for backward compatibility
export type { LoopMessage, SessionPromptDeps, LoopOptions } from './types.js'
export {
  pruneReasoning,
  summarizeToolTraces,
  getRouter,
  getRegistry,
  isGatewayRouter,
  isSubgatewayRegistry,
  resolveLane,
  laneCostCap,
  tierModel,
  priceForModel,
  estimateCostUSD,
  getRetiredModels,
  isRetired,
  resolveEffectiveModel,
  resolveModelViaGateway,
} from './helpers.js'
