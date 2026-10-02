import type { Bus } from '../bus/index.js'
import type { MiraDB } from '../storage/db.js'
import type { Todo, JsonValue, MiraConfig } from '../types/index.js'
import { eq } from 'drizzle-orm'
import { getConfig } from '../config/index.js'
import { getAgentTemplates, isKnownAgent } from '../agents/templates.js'
import { buildRegistry, resolveModel, resolveWithFallbacks } from '../gateway/provider.js'

/** Tier model resolution helper */
function tierModel(tier: string | undefined, fallbackSmall?: string): string {
  switch (tier) {
    case 'cheap':
      return fallbackSmall ?? 'claude-3.5-sonnet'
    case 'max':
      return 'claude-opus-4'
    case 'balanced':
    default:
      return 'claude-sonnet-4'
  }
}

/** Model retirement helpers */
function getRetiredModels(): Set<string> {
  try {
    const cfg = getConfig() as MiraConfig & { routing?: { retiredModels?: string[] } }
    const list = cfg.routing?.retiredModels ?? []
    const set = new Set(list.map((s) => s.toLowerCase()))
    if (set.size === 0) {
      return new Set([
        'claude-3-opus-20240229',
        'claude-3-sonnet-20240229',
        'claude-3-haiku-20240307',
        'gpt-4-0314',
        'gpt-4-0613',
      ])
    }
    return set
  } catch (e) {
    console.error('[session.session-crud] error:', e)
    return new Set([
      'claude-3-opus-20240229',
      'claude-3-sonnet-20240229',
      'claude-3-haiku-20240307',
      'gpt-4-0314',
      'gpt-4-0613',
    ])
  }
}

function isRetired(modelID: string): boolean {
  const m = modelID.toLowerCase()
  const retired = getRetiredModels()
  for (const r of retired) {
    if (m.includes(r)) return true
  }
  return false
}

/** Resolve model via gateway registry */
function resolveModelViaGateway(candidate: string): string {
  try {
    const resolved = resolveModel(buildRegistry(getConfig()), candidate)
    if (resolved?.providerKey && typeof resolved?.modelID === 'string' && resolved.modelID) {
      return `${resolved.providerKey}/${resolved.modelID}`
    }
  } catch (e) {
    console.error('[session.session-crud] error:', e)
  }
  return candidate
}

/** Effective model resolution (copied from prompt.ts) */
export function resolveEffectiveModel(input: {
  explicitModel?: string
  agent?: string | null
  sessionModel?: string
  task?: 'summarize' | 'stream' | 'complete' | 'vision'
}): string {
  const candidate = ((): string => {
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
        let tier = cfg.autoModel.tier
        if (input.task) {
          if (input.task === 'summarize' || input.task === 'complete') {
            tier = 'cheap'
          } else if (input.task === 'vision') {
            tier = 'max'
          } else if (input.task === 'stream') {
            tier = tier ?? 'balanced'
          }
        }
        return tierModel(tier, cfg.smallModel)
      }
    } catch (e) {
      console.error('[session.session-crud] error:', e)
    }
    if (input.sessionModel) return input.sessionModel
    try {
      return getConfig().model
    } catch (e) {
      console.error('[session.session-crud] error:', e)
      return 'claude-sonnet-4'
    }
  })()
  let resolved = resolveModelViaGateway(candidate)
  if (isRetired(resolved)) {
    console.warn(`[mira] model "${resolved}" is retired, attempting fallback chain`)
    try {
      const registry = buildRegistry(getConfig())
      const fallbackResolved = resolveWithFallbacks(registry, candidate)[0]
      if (
        fallbackResolved?.providerKey &&
        fallbackResolved?.modelID &&
        !isRetired(`${fallbackResolved.providerKey}/${fallbackResolved.modelID}`)
      ) {
        resolved = `${fallbackResolved.providerKey}/${fallbackResolved.modelID}`
      } else {
        const fallback = tierModel('balanced')
        resolved = resolveModelViaGateway(fallback)
      }
    } catch (e) {
      console.error('[session.session-crud] error:', e)
      const fallback = tierModel('balanced')
      resolved = resolveModelViaGateway(fallback)
    }
  }
  return resolved
}

export class SessionCrud {
  constructor(
    private db: MiraDB,
    private bus: Bus,
  ) {}

  async createSession(input: {
    title?: string
    model?: string
    parentID?: string
    agent?: string
    ownerID?: string | null
    cwd?: string
    projectId?: string
  }) {
    const id = crypto.randomUUID()
    const now = Date.now()
    let ownerID = input.ownerID ?? null
    if (!ownerID && input.parentID) {
      try {
        const parent = await this.getSession(input.parentID)
        ownerID = parent?.ownerID ?? null
      } catch (e) {
        console.error('[session.session-crud] error:', e)
      }
    }
    const effectiveModel = resolveEffectiveModel({
      explicitModel: input.model,
      agent: input.agent ?? null,
      sessionModel: 'claude-sonnet-4',
    })
    if (input.model && isRetired(input.model) && input.model !== effectiveModel) {
      this.bus.publish({
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
    const provider = effectiveModel.includes('/') ? effectiveModel.split('/')[0] : 'anthropic'
    const session = {
      id,
      title: input.title ?? (input.agent ? `${input.agent} session` : 'New Session'),
      model: effectiveModel,
      provider,
      createdAt: now,
      updatedAt: now,
      parentID: input.parentID,
      agent: (input.agent && isKnownAgent(input.agent) ? input.agent : null) as string | null,
      ownerID: ownerID as string | null,
      tokensIn: null as number | null,
      tokensOut: null as number | null,
      costUsd: null as number | null,
      cwd: input.cwd ?? (null as string | null),
      projectId: input.projectId ?? (null as string | null),
    }
    await this.db.insert(this.db.schema.sessions).values(session as never)
    return session
  }

  async getSession(id: string) {
    return this.db.query.sessions.findFirst({ where: (s, { eq }) => eq(s.id, id) })
  }

  async deleteSession(id: string) {
    await this.db.delete(this.db.schema.messages).where(eq(this.db.schema.messages.sessionID, id))
    await this.db.delete(this.db.schema.parts).where(eq(this.db.schema.parts.sessionID, id))
    await this.db.delete(this.db.schema.todos).where(eq(this.db.schema.todos.sessionID, id))
    await this.db
      .delete(this.db.schema.fileSnapshots)
      .where(eq(this.db.schema.fileSnapshots.sessionID, id))
    await this.db.delete(this.db.schema.jobs).where(eq(this.db.schema.jobs.parentSessionID, id))
    await this.db.delete(this.db.schema.findings).where(eq(this.db.schema.findings.sessionID, id))
    await this.db
      .delete(this.db.schema.knowledgeEntries)
      .where(eq(this.db.schema.knowledgeEntries.sessionID, id))
    this.db.sqlite.prepare('DELETE FROM message_queue WHERE session_id = ?').run(id)
    await this.db.delete(this.db.schema.sessions).where(eq(this.db.schema.sessions.id, id))
  }

  async getMessages(sessionID: string) {
    return this.db.query.messages.findMany({
      where: (m, { eq }) => eq(m.sessionID, sessionID),
      with: { parts: true },
      orderBy: (m, { asc }) => [asc(m.createdAt)],
    })
  }

  async getTodos(sessionID: string) {
    return this.db.query.todos.findMany({
      where: (t, { eq }) => eq(t.sessionID, sessionID),
    })
  }

  async setTodos(sessionID: string, todos: Todo[]) {
    await this.db.delete(this.db.schema.todos).where(eq(this.db.schema.todos.sessionID, sessionID))
    if (todos.length) {
      await this.db.insert(this.db.schema.todos).values(
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

  async forkSession(opts: {
    sourceSessionID: string
    messageID?: string
    title?: string
  }): Promise<{ sessionID: string; copiedMessages: number }> {
    const source = await this.getSession(opts.sourceSessionID)
    if (!source) throw new Error('source session not found')
    const history = await this.getMessages(opts.sourceSessionID)
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
      cwd: source.cwd ?? undefined,
      projectId: source.projectId ?? undefined,
    })
    const now = Date.now()
    await this.db.transaction(async (tx) => {
      for (const m of selected) {
        const newMessageID = crypto.randomUUID()
        await tx.insert(this.db.schema.messages).values({
          id: newMessageID,
          sessionID: fork.id,
          role: m.role,
          createdAt: m.createdAt ?? now,
        })
        for (const p of m.parts ?? []) {
          const { ...rest } = p
          await tx.insert(this.db.schema.parts).values({
            id: crypto.randomUUID(),
            ...rest,
            messageID: newMessageID,
            sessionID: fork.id,
          })
        }
      }
    })
    this.bus.publish({
      type: 'session.created',
      payload: { ...fork, forkedFrom: source.id },
      timestamp: now,
    })
    return { sessionID: fork.id, copiedMessages: selected.length }
  }

  async upsertTextPart(messageID: string, sessionID: string, text: string) {
    const existing = await this.db.query.parts.findFirst({
      where: (p, { and, eq }) => and(eq(p.messageID, messageID), eq(p.type, 'text')),
    })
    if (existing) {
      await this.db
        .update(this.db.schema.parts)
        .set({ text })
        .where(eq(this.db.schema.parts.id, existing.id))
    } else {
      await this.db.insert(this.db.schema.parts).values({
        id: crypto.randomUUID(),
        messageID,
        sessionID,
        type: 'text',
        text,
        createdAt: Date.now(),
      })
    }
  }

  async persistToolResult(
    messageID: string,
    sessionID: string,
    tc: { id: string; name: string; args: Record<string, JsonValue> },
    result: JsonValue,
    isError = false,
  ) {
    await this.db.insert(this.db.schema.parts).values({
      id: crypto.randomUUID(),
      messageID,
      sessionID,
      type: 'tool-call',
      tool: tc.name,
      toolCallID: tc.id,
      args: tc.args,
      createdAt: Date.now(),
    })
    await this.db.insert(this.db.schema.parts).values({
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
