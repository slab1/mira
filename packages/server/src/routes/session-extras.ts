import type { Hono, Context } from 'hono'
import type { MiraDB } from '../storage/db.js'
import type { Bus } from '../bus/index.js'
import type { SessionPrompt } from '../session/prompt.js'
import { listJobs } from '../tools/task.js'
import { isKnownAgent } from '../agents/templates.js'
import type { JsonValue } from '../types/index.js'
import type { TodoStatus, TodoPriority } from '../types/index.js'
import { z } from 'zod'

const importSessionSchema = z
  .object({
    session: z
      .object({
        title: z.string().max(200).optional(),
        model: z.string().min(1).optional(),
        agent: z.string().max(100).optional(),
      })
      .passthrough()
      .optional(),
    messages: z
      .array(
        z
          .object({
            role: z.enum(['user', 'assistant', 'system']).or(z.string()),
            parts: z
              .array(
                z
                  .object({
                    type: z
                      .enum(['text', 'tool-call', 'tool-result', 'reasoning', 'file'])
                      .or(z.string()),
                    text: z.string().nullable().optional(),
                    tool: z.string().nullable().optional(),
                    toolCallID: z.string().nullable().optional(),
                    args: z.custom<JsonValue>().nullable().optional(),
                    result: z.custom<JsonValue>().nullable().optional(),
                    isError: z.boolean().nullable().optional(),
                  })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
    title: z.string().max(200).optional(),
    model: z.string().min(1).optional(),
    agent: z.string().max(100).optional(),
  })
  .passthrough()

const queuePushSchema = z.object({ prompt: z.string().min(1).max(20000) })

const todoSchema = z.array(
  z.object({
    content: z.string().min(1).max(2000),
    status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']).optional(),
    priority: z.enum(['high', 'medium', 'low']).optional(),
  }),
)

function requireId(c: Context): string | null {
  const v = c.req.param('id')
  return v && v.length > 0 ? v : null
}

export function mountSessionExtrasRoutes(
  app: Hono<{ Variables: { requestId: string } }>,
  deps: {
    db: MiraDB
    bus: Bus
    prompt: SessionPrompt
    authorizedSession: (id: string, c: Context) => Promise<{ id: string } | null>
    ownerOfSession: (id: string) => Promise<string | null>
    resolveOwner: (t: string) => string | undefined
    bearerOf: (h?: string) => string
    API_KEY_OWNERS: Map<string, string>
    sessionOwnerCache: Map<string, { owner: string | null; ts: number }>
  },
) {
  const { db, bus, prompt } = deps

  // Prompt — the core loop (streamed via SSE)
  app.post('/session/:id/prompt', async (c: Context) => {
    const id = requireId(c)
    if (!id) return c.json({ error: 'session not found' }, 404)
    const {
      prompt: text,
      model,
      agent,
      maxSteps,
    } = await c.req.json().catch(() => ({}) as Record<string, JsonValue>)
    if (!text?.trim?.()) return c.json({ error: 'empty prompt' }, 400)
    if (!(await deps.authorizedSession(id, c))) return c.json({ error: 'session not found' }, 404)
    if (
      agent !== undefined &&
      agent !== null &&
      typeof agent === 'string' &&
      agent.length > 0 &&
      !isKnownAgent(agent)
    ) {
      return c.json({ error: `unknown agent "${agent}"` }, 400)
    }
    const signal = (c.req.raw as Request & { signal?: AbortSignal })?.signal
    return prompt.streamResponse(id, text as string, model as string | undefined, {
      maxSteps: maxSteps as number | undefined,
      agent: (agent as string | undefined) ?? null,
      signal,
    })
  })

  // Messages & parts
  app.get('/session/:id/message', async (c: Context) => {
    const id = requireId(c)
    if (!id) return c.json({ error: 'not found' }, 404)
    if (!(await deps.authorizedSession(id, c))) return c.json({ error: 'not found' }, 404)
    const messages = await prompt.getMessages(id)
    return c.json(messages)
  })

  // Session export — shareable transcript (markdown or JSON)
  app.get('/session/:id/export', async (c: Context) => {
    const id = requireId(c)
    if (!id) return c.json({ error: 'not found' }, 404)
    const session = await deps.authorizedSession(id, c)
    if (!session) return c.json({ error: 'not found' }, 404)
    const messages = await prompt.getMessages(id)
    const format = c.req.query('format') ?? 'md'
    if (format === 'json') {
      return c.json({ session, messages, exportedAt: new Date().toISOString(), version: '0.1.0' })
    }
    const s = session as Record<string, unknown>
    const lines: string[] = [
      `# ${s.title ?? 'Session'}`,
      '',
      `- Model: \`${s.model ?? 'unknown'}\``,
      `- Exported: ${new Date().toISOString()}`,
      '',
    ]
    for (const m of messages) {
      const role = m.role === 'user' ? '🙋 User' : m.role === 'assistant' ? '🤖 Mira' : m.role
      lines.push(`## ${role}`)
      for (const p of m.parts ?? []) {
        if (p.type === 'text' && p.text) lines.push(p.text)
        else if (p.type === 'tool-call') lines.push(`> 🔧 \`${p.tool}\``)
        else if (p.type === 'tool-result') lines.push(p.isError ? `> ⚠️ tool error` : `> ✓ result`)
      }
      lines.push('')
    }
    return c.text(lines.join('\n'), 200, { 'Content-Type': 'text/markdown; charset=utf-8' })
  })

  // Session import
  app.post('/session/import', async (c: Context) => {
    const raw = await c.req.json().catch(() => null)
    const parsed = importSessionSchema.safeParse(raw)
    if (!parsed.success)
      return c.json(
        {
          error: 'invalid import',
          issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        },
        400,
      )
    const body = parsed.data as {
      session?: { title?: string; model?: string; agent?: string }
      messages?: Array<{
        role: string
        parts?: Array<{
          type: string
          text?: string
          tool?: string
          toolCallID?: string
          args?: JsonValue
          result?: JsonValue
          isError?: boolean
        }>
      }>
      title?: string
      model?: string
      agent?: string
    }
    const srcSession = body.session
    const title = body.title ?? srcSession?.title ?? 'Imported Session'
    const model = body.model ?? srcSession?.model
    const agent = body.agent ?? srcSession?.agent
    if (agent && !isKnownAgent(agent)) return c.json({ error: `unknown agent "${agent}"` }, 400)
    const owner =
      deps.API_KEY_OWNERS.size > 0
        ? (deps.resolveOwner(deps.bearerOf(c.req.header('Authorization'))) ?? 'default')
        : null
    const created = await prompt.createSession({ title, model, agent, ownerID: owner })
    const msgs = body.messages ?? []
    let copiedMessages = 0
    let copiedParts = 0
    for (const m of msgs) {
      const mid = crypto.randomUUID()
      try {
        await db.insert(db.schema.messages).values({
          id: mid,
          sessionID: created.id,
          role: m.role as 'user' | 'assistant' | 'system',
          createdAt: Date.now(),
        })
        copiedMessages++
        for (const p of m.parts ?? []) {
          await db.insert(db.schema.parts).values({
            id: crypto.randomUUID(),
            messageID: mid,
            sessionID: created.id,
            type: p.type as 'text' | 'tool-call' | 'tool-result' | 'reasoning' | 'file',
            text: p.text ?? null,
            tool: p.tool ?? null,
            toolCallID: p.toolCallID ?? null,
            args: (p.args ?? null) as Record<string, JsonValue> | null,
            result: (p.result ?? null) as JsonValue,
            isError: p.isError ?? null,
            createdAt: Date.now(),
          })
          copiedParts++
        }
      } catch {}
    }
    deps.sessionOwnerCache.set(created.id, {
      owner: (created as { ownerID?: string | null }).ownerID ?? owner,
      ts: Date.now(),
    })
    bus.publish({
      type: 'session.created',
      payload: {
        id: created.id,
        title: created.title,
        importedFrom: true,
        copiedMessages,
        copiedParts,
      } as JsonValue,
      timestamp: Date.now(),
    })
    return c.json({ session: created, copiedMessages, copiedParts }, 201)
  })

  // Agent Manager lite — active jobs + recent sessions
  app.get('/manager', async (c: Context) => {
    const owner =
      deps.API_KEY_OWNERS.size > 0
        ? deps.resolveOwner(deps.bearerOf(c.req.header('Authorization')))
        : undefined
    const allJobs = await listJobs(db)
    const activeJobs = allJobs.filter((j) => j.status === 'running').slice(0, 20)
    let jobs = activeJobs
    if (owner) {
      jobs = []
      for (const j of activeJobs) {
        const o = await deps.ownerOfSession(j.parentSessionID)
        if (o === null || o === owner) jobs.push(j)
      }
    }
    const sessions = (await db.query.sessions.findMany({
      orderBy: (s, { desc }) => [desc(s.updatedAt)],
      limit: 10,
    })) as Array<Record<string, JsonValue>>
    const filteredSessions = owner
      ? (sessions as Array<{ ownerID?: string | null }>).filter(
          (s) => !s.ownerID || s.ownerID === owner,
        )
      : sessions
    return c.json({
      activeJobs: jobs,
      recentSessions: filteredSessions.slice(0, 10),
      at: new Date().toISOString(),
    })
  })

  // Message queue — type while the agent streams
  app.post('/session/:id/queue', async (c: Context) => {
    const parsed = queuePushSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success)
      return c.json(
        {
          error: 'invalid queue push',
          issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        },
        400,
      )
    const text = parsed.data.prompt
    const id = requireId(c)
    if (!id) return c.json({ error: 'session not found' }, 404)
    if (!(await deps.authorizedSession(id, c))) return c.json({ error: 'session not found' }, 404)
    return c.json(prompt.queueMessage(id, String(text).trim()))
  })
  app.get('/session/:id/queue', (c: Context) => {
    const id = requireId(c)
    if (!id) return c.json({ error: 'not found' }, 404)
    return c.json(prompt.getQueue(id))
  })
  app.delete('/session/:id/queue', (c: Context) => {
    const id = requireId(c)
    if (!id) return c.json({ error: 'not found' }, 404)
    return c.json({ cleared: prompt.clearQueue(id) })
  })

  // File snapshots — undo/rewind agent file mutations
  app.get('/session/:id/snapshots', async (c: Context) => {
    const id = requireId(c)
    if (!id) return c.json({ error: 'not found' }, 404)
    if (!(await deps.authorizedSession(id, c))) return c.json({ error: 'not found' }, 404)
    const { listSnapshots } = await import('../storage/snapshots.js')
    return c.json(listSnapshots(db, id))
  })
  app.get('/session/:id/snapshots/:snapshotId', async (c: Context) => {
    const id = requireId(c)
    const snapshotId = c.req.param('snapshotId')
    if (!id || !snapshotId) return c.json({ error: 'not found' }, 404)
    if (!(await deps.authorizedSession(id, c))) return c.json({ error: 'not found' }, 404)
    const { getSnapshotContent } = await import('../storage/snapshots.js')
    const snapshot = getSnapshotContent(db, snapshotId)
    if (!snapshot) return c.json({ error: 'snapshot not found' }, 404)
    let currentContent: string | null = null
    try {
      const fs = await import('fs/promises')
      currentContent = await fs.readFile(snapshot.path, 'utf-8')
    } catch {
      currentContent = null
    }
    return c.json({
      path: snapshot.path,
      snapshotContent: snapshot.content,
      currentContent,
      existedBefore: snapshot.existedBefore,
    })
  })
  app.post('/session/:id/revert', async (c: Context) => {
    const body = await c.req.json().catch(() => ({}))
    const { revertLast, revertToMessage } = await import('../storage/snapshots.js')
    const id = requireId(c)
    if (!id) return c.json({ error: 'not found' }, 404)
    if (!(await deps.authorizedSession(id, c))) return c.json({ error: 'not found' }, 404)
    try {
      const reverted = body.messageID
        ? await revertToMessage(db, id, body.messageID)
        : [await revertLast(db, id)].filter(Boolean)
      bus.publish({
        type: 'session.updated',
        sessionID: id,
        payload: { reverted: reverted.length },
        timestamp: Date.now(),
      })
      return c.json({
        ok: true,
        reverted: reverted.length,
        files: reverted.filter(Boolean).map((r) => (r as { path: string }).path),
      })
    } catch (e) {
      return c.json({ ok: false, error: String(e) }, 400)
    }
  })

  // Todos
  app.get('/session/:id/todo', async (c: Context) => {
    const id = requireId(c)
    if (!id) return c.json({ error: 'not found' }, 404)
    if (!(await deps.authorizedSession(id, c))) return c.json({ error: 'not found' }, 404)
    return c.json(await prompt.getTodos(id))
  })
  app.post('/session/:id/todo', async (c: Context) => {
    const id = requireId(c)
    if (!id) return c.json({ error: 'not found' }, 404)
    if (!(await deps.authorizedSession(id, c))) return c.json({ error: 'not found' }, 404)
    const parsed = todoSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success)
      return c.json(
        {
          error: 'invalid todos',
          issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        },
        400,
      )
    const sid = id
    const todos = parsed.data.map((t) => ({
      id: crypto.randomUUID(),
      sessionID: sid,
      content: t.content,
      status: (t.status ?? 'pending') as TodoStatus,
      priority: (t.priority ?? 'medium') as TodoPriority,
      createdAt: Date.now(),
    }))
    const result = await prompt.setTodos(sid, todos)
    bus.publish({ type: 'todo.updated', sessionID: sid, payload: result, timestamp: Date.now() })
    return c.json(result)
  })
}
