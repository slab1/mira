import { describe, test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Hono } from 'hono'
import { createDatabase, migrate } from '../storage/db.js'
import { SessionPrompt } from './prompt.js'
import { Bus } from '../bus/index.js'
import { PermissionManager } from '../permission/index.js'
import { ToolRegistry } from '../tools/registry.js'
import { taskTool, getJob } from '../tools/task.js'
import { sessionListTool } from '../tools/session.js'
import { mountSessionRoutes } from '../routes/session.js'
import { mountSessionExtrasRoutes } from '../routes/session-extras.js'
import { sessionVisibleTo } from '../auth/session-access.js'
import type { Gateway, GatewayChunk } from '../gateway/index.js'
import type { BusEvent } from '../types/index.js'

const stubGateway: Gateway = {
  stream: () =>
    Promise.resolve(
      (async function* () {
        yield { type: 'text-delta', text: 'done' } as GatewayChunk
        yield { type: 'finish', finishReason: 'stop' } as GatewayChunk
      })(),
    ),
  complete: async () => ({ text: '' }),
  summarize: async () => '',
  listModels: async () => [],
  stats: () => ({
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUSD: 0,
    avgLatencyMs: 0,
    byModel: {},
  }),
}

describe('Parent and child session lifecycle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mira-parent-child-'))

  afterAll(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })

  test('createSession inherits ownerID, orgID, cwd, projectId, and model from parent and controls session.created event', async () => {
    const db = createDatabase(join(dir, 'inherit.db'))
    await migrate(db)
    const bus = new Bus()
    const events: BusEvent[] = []
    bus.subscribeAll((e) => events.push(e))

    const permissions = new PermissionManager({})
    const tools = new ToolRegistry({ db, bus, permissions, gateway: stubGateway })
    const sp = new SessionPrompt({ db, bus, gateway: stubGateway, tools, permissions })

    const parent = await sp.createSession({
      title: 'Parent Root',
      model: 'openai/gpt-4o',
      ownerID: 'alice',
      orgID: 'org-1',
      cwd: '/tmp/workspace-alpha',
      projectId: 'proj-alpha',
    })
    expect(events.filter((e) => e.type === 'session.created').length).toBe(1)

    const child = await sp.createSession({
      title: 'Child Auto',
      parentID: parent.id,
    })
    expect(child.parentID).toBe(parent.id)
    expect(child.ownerID).toBe('alice')
    expect(child.orgID).toBe('org-1')
    expect(child.cwd).toBe('/tmp/workspace-alpha')
    expect(child.projectId).toBe('proj-alpha')
    expect(child.model).toBe('openai/gpt-4o')
    expect(events.filter((e) => e.type === 'session.created').length).toBe(2)

    const silentChild = await sp.createSession({
      title: 'Child Silent',
      parentID: parent.id,
      model: 'anthropic/claude-sonnet-4',
      cwd: '/tmp/override',
      emitEvent: false,
    })
    expect(silentChild.model).toBe('anthropic/claude-sonnet-4')
    expect(silentChild.cwd).toBe('/tmp/override')
    expect(events.filter((e) => e.type === 'session.created').length).toBe(2)
  })

  test('runSubagent fires onSessionCreated before stream, inherits parent context, and enforces maxDepth', async () => {
    const db = createDatabase(join(dir, 'subagent.db'))
    await migrate(db)
    const bus = new Bus()
    const permissions = new PermissionManager({})
    const tools = new ToolRegistry({ db, bus, permissions, gateway: stubGateway })

    const timeline: string[] = []
    let capturedModel = ''
    let capturedCwd: string | null = null
    const gateway: Gateway = {
      ...stubGateway,
      stream: (req) => {
        timeline.push('stream:' + req.sessionID)
        capturedModel = req.model
        return Promise.resolve(
          (async function* () {
            yield { type: 'text-delta', text: 'subagent output' } as GatewayChunk
            yield { type: 'finish', finishReason: 'stop' } as GatewayChunk
          })(),
        )
      },
    }
    const sp = new SessionPrompt({ db, bus, gateway, tools, permissions })

    const parent = await sp.createSession({
      title: 'Parent',
      model: 'openai/gpt-4o',
      cwd: '/tmp/repo-root',
      projectId: 'proj-1',
      ownerID: 'bob',
      orgID: 'org-x',
    })

    let earlyChildID = ''
    const res = await sp.runSubagent({
      prompt: 'Inspect architecture',
      parentID: parent.id,
      title: 'Inspect arch',
      onSessionCreated: async (childID) => {
        earlyChildID = childID
        timeline.push('created:' + childID)
        const row = await sp.getSession(childID)
        capturedCwd = row?.cwd ?? null
      },
    })

    expect(earlyChildID).toBe(res.sessionID)
    expect(timeline).toEqual([`created:${res.sessionID}`, `stream:${res.sessionID}`])
    expect(capturedModel).toBe('openai/gpt-4o')
    expect(capturedCwd as string | null).toBe('/tmp/repo-root')
    expect(res.text).toContain('subagent output')

    const childMsgs = await sp.getMessages(res.sessionID)
    expect(childMsgs.length).toBe(2)
    expect(childMsgs[0].role).toBe('user')
    expect(childMsgs[1].role).toBe('assistant')

    const childRow = await sp.getSession(res.sessionID)
    expect(childRow?.ownerID).toBe('bob')
    expect(childRow?.orgID).toBe('org-x')
    expect(childRow?.projectId).toBe('proj-1')

    // Depth guard: parent -> res.sessionID (depth 2) -> attempting maxDepth=2 rejects
    let depthErr: unknown = null
    try {
      await sp.runSubagent({
        prompt: 'Too deep',
        parentID: res.sessionID,
        maxDepth: 2,
      })
    } catch (e) {
      depthErr = e
    }
    expect((depthErr as { code?: string })?.code).toBe('MAX_DEPTH_EXCEEDED')
  })

  test('taskTool emits job.created, links childSessionID immediately via onSessionCreated, and propagates fg abort', async () => {
    const db = createDatabase(join(dir, 'task-wiring.db'))
    await migrate(db)
    const bus = new Bus()
    const events: BusEvent[] = []
    bus.subscribeAll((e) => events.push(e))
    const permissions = new PermissionManager({})
    const tools = new ToolRegistry({ db, bus, permissions, gateway: stubGateway })
    const sp = new SessionPrompt({ db, bus, gateway: stubGateway, tools, permissions })

    const parent = await sp.createSession({ title: 'Task Parent', cwd: '/tmp/proj' })
    const fgAbort = new AbortController()
    let seenJobChildDuringRun: string | null | undefined = null
    let runnerAborted = false

    tools.setSubagentRunner(async (opts) => {
      const child = await sp.createSession({
        title: opts.title ?? '↳ child',
        parentID: opts.parentID,
        cwd: opts.cwd,
      })
      await opts.onSessionCreated?.(child.id)
      // Inspect DB job row BEFORE runner resolves
      const rows = await db.query.jobs.findMany({
        where: (j, { eq }) => eq(j.parentSessionID, opts.parentID),
      })
      seenJobChildDuringRun = rows[0]?.childSessionID

      if (opts.signal) {
        await new Promise<void>((resolve) => {
          opts.signal!.addEventListener(
            'abort',
            () => {
              runnerAborted = true
              resolve()
            },
            { once: true },
          )
          fgAbort.abort()
        })
      }
      return { sessionID: child.id, text: 'aborted-early' }
    })

    const out = await taskTool.execute(
      { description: 'Run check', prompt: 'Check things', background: false },
      {
        sessionID: parent.id,
        messageID: 'msg-1',
        cwd: '/tmp/proj',
        signal: fgAbort.signal,
        db,
        bus,
        subagentRunner: async (o) => {
          return await (tools as unknown as { subagentRunner: (x: typeof o) => Promise<{ sessionID: string; text: string }> }).subagentRunner(o)
        },
      },
    )

    expect(runnerAborted).toBe(true)
    expect(seenJobChildDuringRun as string | null | undefined).toBe(out.childSessionID)
    expect(events.some((e) => e.type === 'job.created')).toBe(true)
    expect(
      events.some(
        (e) =>
          e.type === 'job.updated' &&
          (e.payload as { status?: string; childSessionID?: string }).status === 'running' &&
          (e.payload as { childSessionID?: string }).childSessionID === out.childSessionID,
      ),
    ).toBe(true)
  })

  test('SessionPrompt.abortSession stops an active runLoop', async () => {
    const db = createDatabase(join(dir, 'abort-loop.db'))
    await migrate(db)
    const bus = new Bus()
    const permissions = new PermissionManager({})
    const tools = new ToolRegistry({ db, bus, permissions, gateway: stubGateway })

    let abortedSignalSeen = false
    const gateway: Gateway = {
      ...stubGateway,
      stream: (req) =>
        Promise.resolve(
          (async function* () {
            await new Promise<void>((resolve) => {
              if (req.signal?.aborted) {
                abortedSignalSeen = true
                resolve()
                return
              }
              req.signal?.addEventListener(
                'abort',
                () => {
                  abortedSignalSeen = true
                  resolve()
                },
                { once: true },
              )
            })
            yield { type: 'finish', finishReason: 'stop' } as GatewayChunk
          })(),
        ),
    }

    const sp = new SessionPrompt({ db, bus, gateway, tools, permissions })
    const s = await sp.createSession({ title: 'Abortable' })
    const assistantMessageID = crypto.randomUUID()
    await db.insert(db.schema.messages).values([
      { id: crypto.randomUUID(), sessionID: s.id, role: 'user', createdAt: Date.now() },
      { id: assistantMessageID, sessionID: s.id, role: 'assistant', createdAt: Date.now() },
    ])

    const writer = {
      write: () => {},
      close: async () => {},
    } as unknown as WritableStreamDefaultWriter<Uint8Array>

    const loopPromise = (
      sp as unknown as { runLoop: (o: Record<string, unknown>) => Promise<void> }
    ).runLoop({
      sessionID: s.id,
      assistantMessageID,
      userText: 'hang until aborted',
      model: 'openai/gpt-4o',
      systemPrompt: 'sys',
      send: () => {},
      writer,
    })

    await new Promise((r) => setTimeout(r, 25))
    const count = sp.abortSession(s.id)
    expect(count).toBe(1)
    await loopPromise
    expect(abortedSignalSeen).toBe(true)
  })

  test('deleteSession cancels running jobs, cascade-deletes subagent children, and detaches forks', async () => {
    const db = createDatabase(join(dir, 'delete-cascade.db'))
    await migrate(db)
    const bus = new Bus()
    const events: BusEvent[] = []
    bus.subscribeAll((e) => events.push(e))
    const permissions = new PermissionManager({})
    const tools = new ToolRegistry({ db, bus, permissions, gateway: stubGateway })
    const sp = new SessionPrompt({ db, bus, gateway: stubGateway, tools, permissions })

    const parent = await sp.createSession({ title: 'Parent Session' })
    await db.insert(db.schema.messages).values({
      id: 'm-1',
      sessionID: parent.id,
      role: 'user',
      createdAt: Date.now(),
    })

    // 1. User fork — should be preserved with parentID = null
    const forked = await sp.forkSession({ sourceSessionID: parent.id, title: 'User Branch' })

    // 2. Background subagent child + running job
    let bgSignalAborted = false
    tools.setSubagentRunner(async (opts) => {
      const child = await sp.createSession({
        title: opts.title ?? '↳ bg child',
        parentID: opts.parentID,
      })
      await opts.onSessionCreated?.(child.id)
      await new Promise<void>((resolve) => {
        opts.signal?.addEventListener(
          'abort',
          () => {
            bgSignalAborted = true
            resolve()
          },
          { once: true },
        )
      })
      return { sessionID: child.id, text: 'stopped' }
    })

    const bgResp = await taskTool.execute(
      { description: 'Background work', prompt: 'Do bg work', background: true },
      {
        sessionID: parent.id,
        messageID: 'm-1',
        cwd: process.cwd(),
        db,
        bus,
        subagentRunner: async (o) =>
          await (tools as unknown as { subagentRunner: (x: typeof o) => Promise<{ sessionID: string; text: string }> }).subagentRunner(o),
      },
    )

    // Wait briefly for setImmediate runner to create child and link job.childSessionID
    await new Promise((r) => setTimeout(r, 40))
    const jobBefore = await getJob(db, bgResp.jobID!)
    expect(jobBefore?.childSessionID).toBeTruthy()
    const subagentChildID = jobBefore!.childSessionID!

    // 3. Another subagent child by '↳ ' naming convention (even without a job row)
    const namedChild = await sp.createSession({
      title: '↳ secondary task',
      parentID: parent.id,
    })

    await sp.deleteSession(parent.id)

    expect(bgSignalAborted).toBe(true)
    expect(await sp.getSession(parent.id)).toBeUndefined()
    expect(await sp.getSession(subagentChildID)).toBeUndefined()
    expect(await sp.getSession(namedChild.id)).toBeUndefined()

    const preservedFork = await sp.getSession(forked.sessionID)
    expect(preservedFork).toBeDefined()
    expect(preservedFork?.parentID).toBeNull()

    const deletedEvents = events.filter((e) => e.type === 'session.deleted')
    const deletedIds = deletedEvents.map((e) => (e.payload as { id?: string }).id)
    expect(deletedIds).toContain(subagentChildID)
    expect(deletedIds).toContain(namedChild.id)
  })

  test('REST routes (/session parentID, /children, /fork, /abort) and session_list hierarchy filters', async () => {
    const db = createDatabase(join(dir, 'routes.db'))
    await migrate(db)
    const bus = new Bus()
    const permissions = new PermissionManager({})
    const tools = new ToolRegistry({ db, bus, permissions, gateway: stubGateway })
    const sp = new SessionPrompt({ db, bus, gateway: stubGateway, tools, permissions })

    const OWNERS: Record<string, string> = { 'tok-a': 'alice', 'tok-b': 'bob' }
    const resolveOwner = (t: string) => OWNERS[t]
    const bearerOf = (h?: string) => (h?.startsWith('Bearer ') ? h.slice(7) : '')
    const orgOfOwner = () => undefined
    const orgOfSession = async (id: string) => (await sp.getSession(id))?.orgID ?? null
    const authorizedSession = async (id: string, c: { req: { header: (n: string) => string | undefined } }) => {
      const s = await sp.getSession(id)
      if (!s) return null
      const caller = resolveOwner(bearerOf(c.req.header('Authorization')))
      return sessionVisibleTo({ ownerID: s.ownerID ?? null, orgID: s.orgID ?? null }, caller, orgOfOwner)
        ? s
        : null
    }

    const app = new Hono<{ Variables: { requestId: string } }>()
    const cache = new Map<string, { owner: string | null; org: string | null; ts: number }>()
    mountSessionRoutes(app, {
      db,
      bus,
      prompt: sp,
      authorizedSession,
      ownerOfSession: async (id) => (await sp.getSession(id))?.ownerID ?? null,
      orgOfOwner,
      orgOfSession,
      resolveOwner,
      bearerOf,
      OWNERSHIP_ENABLED: true,
      sessionOwnerCache: cache,
    })
    mountSessionExtrasRoutes(app, {
      db,
      bus,
      prompt: sp,
      authorizedSession,
      ownerOfSession: async (id) => (await sp.getSession(id))?.ownerID ?? null,
      orgOfOwner,
      orgOfSession,
      resolveOwner,
      bearerOf,
      API_KEY_OWNERS: new Map([
        ['tok-a', 'alice'],
        ['tok-b', 'bob'],
      ]),
      sessionOwnerCache: cache,
    })

    // Create parent as Alice
    const pRes = await app.request('/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok-a' },
      body: JSON.stringify({ title: 'Alice Root', cwd: '/tmp/alice' }),
    })
    expect(pRes.status).toBe(201)
    const parent = (await pRes.json()) as { id: string; parentID: string | null }

    // Bob cannot attach a child under Alice's parentID
    const crossOwnerChild = await app.request('/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok-b' },
      body: JSON.stringify({ title: 'Unauthorized Child', parentID: parent.id }),
    })
    expect(crossOwnerChild.status).toBe(404)

    // Alice creates a child with parentID
    const cRes = await app.request('/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok-a' },
      body: JSON.stringify({ title: 'Alice Child', parentID: parent.id }),
    })
    expect(cRes.status).toBe(201)
    const child = (await cRes.json()) as { id: string; parentID: string | null; cwd: string | null }
    expect(child.parentID).toBe(parent.id)
    expect(child.cwd).toBe('/tmp/alice')

    // Alice forks parent
    const fRes = await app.request(`/session/${parent.id}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok-a' },
      body: JSON.stringify({ title: 'Alice Fork' }),
    })
    expect(fRes.status).toBe(201)
    const forked = (await fRes.json()) as { id: string; session: { parentID: string | null } }
    expect(forked.session.parentID).toBe(parent.id)

    // GET /session/:id/children returns both child and fork
    const chRes = await app.request(`/session/${parent.id}/children`, {
      headers: { Authorization: 'Bearer tok-a' },
    })
    expect(chRes.status).toBe(200)
    const children = (await chRes.json()) as Array<{ id: string }>
    expect(children.map((x) => x.id).sort()).toEqual([child.id, forked.id].sort())

    // POST /session/:id/abort returns ok + aborted count
    const aRes = await app.request(`/session/${parent.id}/abort`, {
      method: 'POST',
      headers: { Authorization: 'Bearer tok-a' },
    })
    expect(aRes.status).toBe(200)
    expect(await aRes.json()).toEqual({ ok: true, aborted: 0 })

    // session_list hierarchy filters
    const childrenOut = (await sessionListTool.execute(
      { childrenOfCurrent: true, limit: 10 },
      { sessionID: parent.id, messageID: 'm', db, bus },
    )) as { count: number; sessions: Array<{ id: string }> }
    expect(childrenOut.count).toBe(2)

    const rootsOut = (await sessionListTool.execute(
      { rootsOnly: true, limit: 10 },
      { sessionID: parent.id, messageID: 'm', db, bus },
    )) as { count: number; sessions: Array<{ id: string }> }
    expect(rootsOut.sessions.map((s) => s.id)).toEqual([parent.id])
  })
})
