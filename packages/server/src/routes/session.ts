import type { Hono, Context } from 'hono'
import type { MiraDB } from '../storage/db.js'
import type { Bus } from '../bus/index.js'
import type { SessionPrompt } from '../session/prompt.js'
import { getJob, listJobs, cancelJob, type Job } from '../tools/task.js'
import type { JsonValue } from '../types/index.js'
import type { TodoStatus, TodoPriority } from '../types/index.js'
import { isKnownAgent } from '../agents/templates.js'
import { z } from 'zod'
import { desc } from 'drizzle-orm'
import { sessions } from '../storage/schema.js'

/** Typed session row — mirrors the Drizzle `sessions` schema. */
interface SessionRow {
  id: string
  title: string
  model: string
  provider: string
  createdAt: number
  updatedAt: number
  parentID: string | null
  agent: string | null
  ownerID: string | null
  tokensIn: number | null
  tokensOut: number | null
  costUsd: number | null
  cwd: string | null
  projectId: string | null
}

/** Zod schema for POST /session body validation. */
const createSessionSchema = z.object({
  model: z.string().min(1).optional(),
  title: z.string().max(200).optional(),
  agent: z.string().min(1).max(100).optional(),
  cwd: z.string().optional(),
  projectId: z.string().optional(),
})

/** Zod schemas for the versioned session export/import envelope (P2-2). */
const exportPartSchema = z
  .object({
    type: z.string(),
    text: z.string().nullable().optional(),
    tool: z.string().nullable().optional(),
    toolCallID: z.string().nullable().optional(),
    args: z.custom<JsonValue>().nullable().optional(),
    result: z.custom<JsonValue>().nullable().optional(),
    isError: z.boolean().nullable().optional(),
    createdAt: z.number().nullable().optional(),
  })
  .passthrough()

const exportMessageSchema = z
  .object({
    role: z.string(),
    createdAt: z.number().nullable().optional(),
    parts: z.array(exportPartSchema).optional(),
  })
  .passthrough()

const exportTodoSchema = z
  .object({
    content: z.string().min(1).max(2000),
    status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']).optional(),
    priority: z.enum(['high', 'medium', 'low']).optional(),
    createdAt: z.number().nullable().optional(),
  })
  .passthrough()

const sessionImportSchema = z
  .object({
    // New envelope marker. Absent (or the legacy "0.1.0" string) = legacy body.
    version: z.unknown().optional(),
    session: z
      .object({
        title: z.string().max(200).nullable().optional(),
        model: z.string().min(1).nullable().optional(),
        agent: z.string().max(100).nullable().optional(),
        parentID: z.string().nullable().optional(),
        cwd: z.string().nullable().optional(),
        projectId: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
    messages: z.array(exportMessageSchema).optional(),
    todos: z.array(exportTodoSchema).optional(),
    // Legacy top-level aliases (pre-envelope import bodies)
    title: z.string().max(200).nullable().optional(),
    model: z.string().min(1).nullable().optional(),
    agent: z.string().max(100).nullable().optional(),
  })
  .passthrough()

function requireId(c: Context): string | null {
  const v = c.req.param('id')
  return v && v.length > 0 ? v : null
}

export function mountSessionRoutes(
  app: Hono<{ Variables: { requestId: string } }>,
  deps: {
    db: MiraDB
    bus: Bus
    prompt: SessionPrompt
    authorizedSession: (id: string, c: Context) => Promise<SessionRow | null>
    ownerOfSession: (id: string) => Promise<string | null>
    resolveOwner: (t: string) => string | undefined
    bearerOf: (h?: string) => string
    OWNERSHIP_ENABLED: boolean | (() => boolean)
    sessionOwnerCache: Map<string, { owner: string | null; ts: number }>
  },
) {
  const { db, bus, prompt } = deps
  const isOwnershipEnabled = () =>
    typeof deps.OWNERSHIP_ENABLED === 'function'
      ? (deps.OWNERSHIP_ENABLED as () => boolean)()
      : !!deps.OWNERSHIP_ENABLED

  app.get('/session', async (c: Context) => {
    const owner = isOwnershipEnabled()
      ? deps.resolveOwner(deps.bearerOf(c.req.header('Authorization')))
      : undefined
    const all = (await db.query.sessions.findMany({
      orderBy: desc(sessions.updatedAt),
    })) as SessionRow[]
    return c.json(owner ? all.filter((s) => !s.ownerID || s.ownerID === owner) : all)
  })
  app.post('/session', async (c: Context) => {
    const parsed = createSessionSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid session',
          issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        },
        400,
      )
    }
    const body = parsed.data
    const rawSession = await prompt.createSession({
      ...body,
      ownerID: isOwnershipEnabled()
        ? (deps.resolveOwner(deps.bearerOf(c.req.header('Authorization'))) ?? 'default')
        : null,
    })
    // Proper type bridge: prompt.createSession returns Session-like object, narrow to SessionRow via runtime check
    const session: SessionRow = {
      id: rawSession.id,
      title: rawSession.title,
      model: rawSession.model,
      provider: rawSession.provider,
      createdAt: rawSession.createdAt,
      updatedAt: rawSession.updatedAt,
      parentID: rawSession.parentID ?? null,
      agent: rawSession.agent ?? null,
      ownerID: rawSession.ownerID ?? null,
      tokensIn: (rawSession as Partial<SessionRow>).tokensIn ?? null,
      tokensOut: (rawSession as Partial<SessionRow>).tokensOut ?? null,
      costUsd: (rawSession as Partial<SessionRow>).costUsd ?? null,
      cwd: (rawSession as Partial<SessionRow>).cwd ?? null,
      projectId: (rawSession as Partial<SessionRow>).projectId ?? null,
    }
    deps.sessionOwnerCache.set(session.id, { owner: session.ownerID ?? null, ts: Date.now() })
    bus.publish({
      type: 'session.created',
      payload: JSON.parse(JSON.stringify(session)) as JsonValue,
      timestamp: Date.now(),
    })
    return c.json(session, 201)
  })
  app.get('/session/:id', async (c: Context) => {
    const id = requireId(c)
    if (!id) return c.json({ error: 'not found' }, 404)
    const session = await deps.authorizedSession(id, c)
    if (!session) return c.json({ error: 'not found' }, 404)
    return c.json(session)
  })
  app.delete('/session/:id', async (c: Context) => {
    const id = requireId(c)
    if (!id) return c.json({ error: 'not found' }, 404)
    if (!(await deps.authorizedSession(id, c))) return c.json({ error: 'not found' }, 404)
    deps.sessionOwnerCache.delete(id)
    await prompt.deleteSession(id)
    bus.publish({ type: 'session.deleted', payload: { id }, timestamp: Date.now() })
    return c.json({ ok: true })
  })

  // ── Session export/import (P2-2, versioned JSON envelope) ──────────
  // NOTE: session-extras.ts also registers these paths, but this module is
  // mounted first so these handlers win. They preserve the legacy contract
  // (bare export defaults to the markdown transcript, `?format=json` opts
  // into the versioned envelope; version-less import bodies accepted) to
  // keep the CLI/e2e flows working.
  app.get('/session/:id/export', async (c: Context) => {
    const id = requireId(c)
    if (!id) return c.json({ error: 'not found' }, 404)
    const session = await deps.authorizedSession(id, c)
    if (!session) return c.json({ error: 'not found' }, 404)
    if ((c.req.query('format') ?? 'md') === 'md') {
      const s = session as unknown as Record<string, unknown>
      const lines: string[] = [
        `# ${s.title ?? 'Session'}`,
        '',
        `- Model: \`${s.model ?? 'unknown'}\``,
        `- Exported: ${new Date().toISOString()}`,
        '',
      ]
      for (const m of await prompt.getMessages(id)) {
        const role = m.role === 'user' ? '🙋 User' : m.role === 'assistant' ? '🤖 Mira' : m.role
        lines.push(`## ${role}`)
        for (const p of m.parts ?? []) {
          if (p.type === 'text' && p.text) lines.push(p.text)
          else if (p.type === 'tool-call') lines.push(`> 🔧 \`${p.tool}\``)
          else if (p.type === 'tool-result')
            lines.push(p.isError ? `> ⚠️ tool error` : `> ✓ result`)
        }
        lines.push('')
      }
      return c.text(lines.join('\n'), 200, { 'Content-Type': 'text/markdown; charset=utf-8' })
    }
    const messages = await prompt.getMessages(id)
    const todos = await prompt.getTodos(id)
    return c.json({ version: 1, exportedAt: new Date().toISOString(), session, messages, todos })
  })
  app.post('/session/import', async (c: Context) => {
    const raw = await c.req.json().catch(() => null)
    const parsed = sessionImportSchema.safeParse(raw)
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid import',
          issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        },
        400,
      )
    }
    const body = parsed.data
    // Reject unknown envelope versions; absent (or legacy "0.1.0") = legacy body.
    if (body.version !== undefined && body.version !== 1 && body.version !== '0.1.0') {
      return c.json({ error: `unsupported import version ${JSON.stringify(body.version)}` }, 400)
    }
    const srcSession = body.session ?? {}
    const srcTitle = body.title ?? srcSession.title
    const title = srcTitle ? `${srcTitle} (import)` : 'Imported Session'
    const model = body.model ?? srcSession.model
    const agent = body.agent ?? srcSession.agent
    if (agent && !isKnownAgent(agent)) return c.json({ error: `unknown agent "${agent}"` }, 400)
    // parentID is dropped unless the referenced parent session still exists.
    let parentID: string | undefined
    const candidateParent = srcSession.parentID ?? null
    if (candidateParent) {
      try {
        const parent = await prompt.getSession(candidateParent)
        if (parent) parentID = candidateParent
      } catch {
        /* treat as missing → drop */
      }
    }
    const owner = isOwnershipEnabled()
      ? (deps.resolveOwner(deps.bearerOf(c.req.header('Authorization'))) ?? 'default')
      : null
    const created = await prompt.createSession({
      title,
      model: model ?? undefined,
      parentID,
      agent: agent ?? undefined,
      ownerID: owner,
      cwd: srcSession.cwd ?? undefined,
      projectId: srcSession.projectId ?? undefined,
    })
    let copiedMessages = 0
    let copiedParts = 0
    for (const m of body.messages ?? []) {
      const mid = crypto.randomUUID()
      try {
        await db.insert(db.schema.messages).values({
          id: mid,
          sessionID: created.id,
          role: m.role as 'user' | 'assistant' | 'system',
          createdAt: m.createdAt ?? Date.now(),
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
            createdAt: p.createdAt ?? Date.now(),
          })
          copiedParts++
        }
      } catch {
        /* skip malformed message, keep the rest */
      }
    }
    let copiedTodos = 0
    for (const t of body.todos ?? []) {
      await db.insert(db.schema.todos).values({
        id: crypto.randomUUID(),
        sessionID: created.id,
        content: t.content,
        status: (t.status ?? 'pending') as TodoStatus,
        priority: (t.priority ?? 'medium') as TodoPriority,
        createdAt: t.createdAt ?? Date.now(),
      })
      copiedTodos++
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
        copiedTodos,
      } as JsonValue,
      timestamp: Date.now(),
    })
    return c.json(
      { id: created.id, session: created, copiedMessages, copiedParts, copiedTodos },
      201,
    )
  })

  app.get('/session/:id/jobs', async (c: Context) => {
    const id = requireId(c)
    if (!id) return c.json({ error: 'session not found' }, 404)
    if (!(await deps.authorizedSession(id, c))) return c.json({ error: 'session not found' }, 404)
    return c.json(await listJobs(db, id))
  })
  app.get('/job/:id', async (c: Context) => {
    const id = requireId(c)
    if (!id) return c.json({ error: 'not found' }, 404)
    const job = await getJob(db, id)
    if (!job || !(await deps.authorizedSession(job.parentSessionID, c)))
      return c.json({ error: 'not found' }, 404)
    return c.json(job)
  })
  app.post('/job/:id/cancel', async (c: Context) => {
    const id = requireId(c)
    if (!id) return c.json({ error: 'not found' }, 404)
    const job = await getJob(db, id)
    if (!job || !(await deps.authorizedSession(job.parentSessionID, c)))
      return c.json({ error: 'not found' }, 404)
    const cancelled = await cancelJob(db, id)
    bus.publish({ type: 'job.cancelled', payload: { jobID: job.id }, timestamp: Date.now() })
    return c.json(cancelled)
  })
  app.get('/jobs', async (c: Context) => {
    const owner = isOwnershipEnabled()
      ? deps.resolveOwner(deps.bearerOf(c.req.header('Authorization')))
      : undefined
    const all = await listJobs(db)
    if (!owner) return c.json(all)
    const filtered: typeof all = []
    for (const j of all) {
      const o = await deps.ownerOfSession(j.parentSessionID)
      if (o === null || o === owner) filtered.push(j)
    }
    return c.json(filtered)
  })
  app.get('/task/:id', async (c: Context) => {
    const id = requireId(c)
    if (!id) return c.json({ error: 'not found' }, 404)
    const job = await getJob(db, id)
    if (!job || !(await deps.authorizedSession(job.parentSessionID, c)))
      return c.json({ error: 'not found' }, 404)
    return c.json(job)
  })
  app.post('/task/:id/cancel', async (c: Context) => {
    const id = requireId(c)
    if (!id) return c.json({ error: 'not found' }, 404)
    const job = await getJob(db, id)
    if (!job || !(await deps.authorizedSession(job.parentSessionID, c)))
      return c.json({ error: 'not found' }, 404)
    const cancelled = await cancelJob(db, id)
    bus.publish({ type: 'job.cancelled', payload: { jobID: job.id }, timestamp: Date.now() })
    return c.json(cancelled)
  })
  app.get('/jobs/:id', async (c: Context) => {
    const id = requireId(c)
    if (!id) return c.json({ error: 'not found' }, 404)
    const job = await getJob(db, id)
    if (!job || !(await deps.authorizedSession(job.parentSessionID, c)))
      return c.json({ error: 'not found' }, 404)
    return c.json(job)
  })
}
