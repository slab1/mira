import { describe, test, expect } from 'bun:test'
import {
  orchestrateTool,
  orchestrateJobAborts,
  cancelOrchestrateJob,
  getJob,
  listJobs,
} from './orchestrate.js'
import { cancelJob, settleJob } from './task.js'
import { createDatabase, migrate, type MiraDB } from '../storage/db.js'
import { sessions, jobs } from '../storage/schema.js'
import { Bus } from '../bus/index.js'
import type { ToolContext } from './registry.js'
import type { JsonValue } from '../types/index.js'

type RunnerOpts = {
  prompt: string
  parentID: string
  agent?: string
  title?: string
  signal?: AbortSignal
}
type Runner = (opts: RunnerOpts) => Promise<{ sessionID: string; text: string }>

interface CapturedEvent {
  type: string
  sessionID?: string
  payload?: unknown
}

function makeBus(captured: CapturedEvent[]): Bus {
  return {
    publish: (event: { type: string; sessionID?: string; payload?: JsonValue }): void => {
      captured.push({ type: event.type, sessionID: event.sessionID, payload: event.payload })
    },
  } as unknown as Bus
}

function baseCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { sessionID: 'sess-cancel-test', messageID: 'msg-1', ...overrides } as ToolContext
}

async function testDB(sessionID: string): Promise<MiraDB> {
  const db = createDatabase(':memory:')
  await migrate(db)
  const now = Date.now()
  await db.insert(sessions).values({ id: sessionID, title: 't', createdAt: now, updatedAt: now })
  return db
}

describe('cancelOrchestrateJob (H3-A)', () => {
  test('cancel flips running→cancelled + publishes job.cancelled', async () => {
    const db = await testDB('sess-cancel-1')
    const events: CapturedEvent[] = []
    const bus = makeBus(events)
    const now = Date.now()
    await db.insert(jobs).values({
      id: 'job-1',
      parentSessionID: 'sess-cancel-1',
      prompt: 'p',
      status: 'running',
      createdAt: now,
      updatedAt: now,
    })
    const cancelled = await cancelOrchestrateJob(db, 'job-1', { bus, sessionID: 'sess-cancel-1' })
    expect(cancelled?.status).toBe('cancelled')
    expect(events.filter((e) => e.type === 'job.cancelled')).toHaveLength(1)
    expect(events[0]?.sessionID).toBe('sess-cancel-1')
    expect(events[0]?.payload).toMatchObject({ jobID: 'job-1', status: 'cancelled' })
  })

  test('cancel unknown job is a no-op (undefined, never throws)', async () => {
    const db = await testDB('sess-cancel-2')
    const out = await cancelOrchestrateJob(db, 'does-not-exist')
    expect(out).toBeUndefined()
  })

  test('a cancellation wins over a late successful terminal write', async () => {
    const db = await testDB('sess-cancel-race')
    const now = Date.now()
    await db.insert(jobs).values({
      id: 'job-race',
      parentSessionID: 'sess-cancel-race',
      prompt: 'p',
      status: 'running',
      createdAt: now,
      updatedAt: now,
    })

    await cancelJob(db, 'job-race')
    const lateResult = await settleJob(db, 'job-race', { status: 'completed', result: 'late' })
    expect(lateResult).toBeUndefined()
    expect((await getJob(db, 'job-race'))?.status).toBe('cancelled')
  })

  test('abort signal reaches the in-flight wave node', async () => {
    const db = await testDB('sess-cancel-3')
    const events: CapturedEvent[] = []
    const bus = makeBus(events)
    let captured: AbortSignal | undefined
    let exited = false
    const runner: Runner = async (opts) => {
      captured = opts.signal
      try {
        await new Promise<void>((resolve, reject) => {
          if (opts.signal?.aborted) return reject(new Error('aborted'))
          opts.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      } finally {
        exited = true
      }
      throw new Error('aborted')
    }
    const ctx = baseCtx({
      sessionID: 'sess-cancel-3',
      subagentRunner: runner,
      bus,
    }) as ToolContext & { db: MiraDB }
    ctx.db = db
    const raw = (await orchestrateTool.execute(
      {
        goal: 'cancel me',
        tasks: [{ id: 'a', prompt: 'hang forever', budgetSteps: 10 }],
        mergeStrategy: 'lead-synthesis',
        background: true,
      },
      ctx,
    )) as { jobIDs?: Array<{ taskID: string; jobID: string }> }
    const jobID = raw.jobIDs?.[0]?.jobID as string
    expect(jobID).toBeTruthy()
    // Wait until the deferred wave runner registers its controller…
    const deadline = Date.now() + 5000
    while (!orchestrateJobAborts.has(jobID) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(orchestrateJobAborts.has(jobID)).toBe(true)
    // The standard job API used by both HTTP cancel routes must also stop DAG nodes.
    await cancelJob(db, jobID, { bus, sessionID: 'sess-cancel-3' })
    expect(captured?.aborted).toBe(true)
    // …and the node exits aborted (never runs to completion); cancel wins
    // the DB race (node terminal updates guard on status='running').
    const done = Date.now() + 5000
    while (!exited && Date.now() < done) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(exited).toBe(true)
    const row = await getJob(db, jobID)
    expect(row?.status).toBe('cancelled')
    expect(events.filter((e) => e.type === 'job.cancelled')).toHaveLength(1)
  }, 15_000)

  test('listJobs/getJob cover orchestrate-spawned rows (shared jobs table)', async () => {
    const db = await testDB('sess-cancel-4')
    const runner: Runner = async () => ({ sessionID: 's', text: 'ok' })
    const ctx = baseCtx({ sessionID: 'sess-cancel-4', subagentRunner: runner }) as ToolContext & {
      db: MiraDB
    }
    ctx.db = db
    await orchestrateTool.execute(
      {
        goal: 'board coverage',
        tasks: [
          { id: 'a', prompt: 'work a', budgetSteps: 10 },
          { id: 'b', prompt: 'work b', budgetSteps: 10 },
        ],
        mergeStrategy: 'lead-synthesis',
      },
      ctx,
    )
    const all = await listJobs(db, 'sess-cancel-4')
    expect(all.length).toBe(2)
    const one = await getJob(db, all[0]?.id as string)
    expect(one?.status).toBe('completed')
  }, 10_000)

  test('failed dependencies persist as skipped terminal rows through the whole chain', async () => {
    const db = await testDB('sess-skip-chain')
    let rootAttempts = 0
    const runner: Runner = async (opts) => {
      if (opts.prompt.includes(':: a]')) {
        rootAttempts++
        throw new Error('root failed')
      }
      return { sessionID: 'child', text: 'should not run' }
    }
    const ctx = baseCtx({ sessionID: 'sess-skip-chain', subagentRunner: runner }) as ToolContext & {
      db: MiraDB
    }
    ctx.db = db
    const raw = (await orchestrateTool.execute(
      {
        goal: 'skip dependents',
        mergeStrategy: 'lead-synthesis',
        tasks: [
          { id: 'a', prompt: 'root', budgetSteps: 10 },
          { id: 'b', prompt: 'second', budgetSteps: 10, dependsOn: ['a'] },
          { id: 'c', prompt: 'third', budgetSteps: 10, dependsOn: ['b'] },
        ],
      },
      ctx,
    )) as { skipped: number }
    const rows = await listJobs(db, 'sess-skip-chain')
    expect(rootAttempts).toBe(2)
    expect(raw.skipped).toBe(2)
    expect(rows.filter((row) => row.status === 'running')).toHaveLength(0)
    expect(rows.filter((row) => row.status === 'skipped')).toHaveLength(2)
    expect(rows.filter((row) => row.status === 'failed')).toHaveLength(1)
  })

  test('depth-budget denial settles the current and all future rows as skipped', async () => {
    const db = await testDB('sess-budget-skip')
    let calls = 0
    const runner: Runner = async () => {
      calls++
      return { sessionID: `child-${calls}`, text: 'ok' }
    }
    const tasks = [
      { id: 'a', prompt: 'a', budgetSteps: 10 },
      { id: 'b', prompt: 'b', budgetSteps: 10, dependsOn: ['a'] },
      { id: 'c', prompt: 'c', budgetSteps: 10, dependsOn: ['b'] },
      { id: 'd', prompt: 'd', budgetSteps: 10, dependsOn: ['c'] },
      { id: 'e', prompt: 'e', budgetSteps: 10, dependsOn: ['d'] },
    ]
    const ctx = baseCtx({
      sessionID: 'sess-budget-skip',
      subagentRunner: runner,
    }) as ToolContext & { db: MiraDB }
    ctx.db = db
    const raw = (await orchestrateTool.execute(
      {
        goal: 'depth budget',
        mergeStrategy: 'lead-synthesis',
        tasks,
      },
      ctx,
    )) as {
      completed: number
      skipped: number
    }
    const rows = await listJobs(db, 'sess-budget-skip')
    expect(calls).toBe(3)
    expect(raw).toMatchObject({ completed: 3, skipped: 2 })
    expect(rows.filter((row) => row.status === 'running')).toHaveLength(0)
    expect(rows.filter((row) => row.status === 'skipped')).toHaveLength(2)
  })

  test('cancelling a terminal job does not abort or emit a false cancellation', async () => {
    const db = await testDB('sess-cancel-terminal')
    const events: CapturedEvent[] = []
    const bus = makeBus(events)
    const now = Date.now()
    await db.insert(jobs).values({
      id: 'job-complete',
      parentSessionID: 'sess-cancel-terminal',
      prompt: 'p',
      status: 'completed',
      createdAt: now,
      updatedAt: now,
    })
    const controller = new AbortController()
    orchestrateJobAborts.set('job-complete', controller)
    try {
      const row = await cancelOrchestrateJob(db, 'job-complete', { bus })
      expect(row?.status).toBe('completed')
      expect(controller.signal.aborted).toBe(false)
      expect(events).toHaveLength(0)
    } finally {
      orchestrateJobAborts.delete('job-complete')
    }
  })
})
