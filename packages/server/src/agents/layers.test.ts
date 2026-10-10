import { describe, test, expect, beforeEach } from 'bun:test'
import { linkTaskGoal, taskGoal, recordTaskOutcome } from './layers.js'
import { loadContext } from '../learning/ledger.js'
import { taskTool } from '../tools/task.js'
import { sessions } from '../storage/schema.js'
import { createDatabase, migrate, type MiraDB } from '../storage/db.js'

// The test preload redirects the RCSI ledger to a temp file — read back
// through loadContext() to assert the learning hand-off landed.
// NOTE: strategy stats ACCUMULATE per key process-wide, so each test uses a
// distinct agent persona to keep assertions exact.

let db: MiraDB

beforeEach(async () => {
  db = createDatabase(':memory:')
  await migrate(db)
  // jobs.parentSessionID has an FK to sessions — create the parent row
  await db.insert(sessions).values({
    id: 'parent-1',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
})

describe('layer linkage registry', () => {
  test('linkTaskGoal / taskGoal roundtrip', () => {
    linkTaskGoal('task-1', 'goal_abc')
    expect(taskGoal('task-1')).toBe('goal_abc')
    expect(taskGoal('task-unknown')).toBeUndefined()
  })
})

describe('recordTaskOutcome → learning layer', () => {
  test('completed+VERIFIED counts as success for the agent strategy', () => {
    recordTaskOutcome({
      taskID: 't1',
      agent: 'coder-ok',
      status: 'completed',
      verificationState: 'VERIFIED',
    })
    const stats = loadContext().strategy_effectiveness?.['agent:coder-ok']
    expect(stats).toBeDefined()
    expect(stats!.successes).toBe(1)
    expect(stats!.success_rate).toBe(1)
  })

  test('completed but UNVERIFIED does NOT count as success', () => {
    recordTaskOutcome({
      taskID: 't2',
      agent: 'coder-unverified',
      status: 'completed',
      verificationState: 'UNVERIFIED',
    })
    const stats = loadContext().strategy_effectiveness?.['agent:coder-unverified']
    expect(stats!.successes).toBe(0)
    expect(stats!.success_rate).toBe(0)
  })

  test('failed tasks record failures and the strategy log carries goal linkage', () => {
    recordTaskOutcome({
      taskID: 't3',
      agent: 'fixer-failed',
      status: 'failed',
      goalId: 'goal_ship',
    })
    const ctx = loadContext()
    expect(ctx.strategy_effectiveness?.['agent:fixer-failed']?.successes).toBe(0)
    const entry = ctx.strategy_log?.find((s) => s.outcome?.includes('goal=goal_ship'))
    expect(entry).toBeDefined()
    expect(entry!.strategy_chosen).toBe('agent:fixer-failed')
  })

  test('default agent persona keys to agent:general', () => {
    recordTaskOutcome({ taskID: 't4', status: 'cancelled' })
    expect(loadContext().strategy_effectiveness?.['agent:general']).toBeDefined()
  })
})

describe('task tool → layers end-to-end', () => {
  function fakeRunner(opts: { fail?: boolean } = {}) {
    return async () => {
      if (opts.fail) throw new Error('subagent blew up')
      return { sessionID: 'child-sess-1', text: 'did the thing' }
    }
  }

  test('foreground task with goalId records outcome against the goal', async () => {
    const out = (await taskTool.execute(
      { description: 'wire layers', prompt: 'do it', subagent_type: 'coder', goalId: 'goal_p25' },
      {
        sessionID: 'parent-1',
        messageID: 'm1',
        db,
        subagentRunner: fakeRunner() as never,
      },
    )) as { status: string; verification?: { state: string } }

    expect(out.status).toBe('completed')
    expect(out.verification?.state).toBeDefined()

    const entry = loadContext().strategy_log?.find((s) => s.outcome?.includes('goal=goal_p25'))
    expect(entry).toBeDefined()
    expect(entry!.strategy_chosen).toBe('agent:coder')
  })

  test('foreground failure records a failed outcome', async () => {
    await expect(
      taskTool.execute(
        { description: 'boom', prompt: 'fail', subagent_type: 'fixer' },
        {
          sessionID: 'parent-1',
          messageID: 'm1',
          db,
          subagentRunner: fakeRunner({ fail: true }) as never,
        },
      ),
    ).rejects.toThrow('subagent blew up')

    const ctx = loadContext()
    expect(ctx.strategy_effectiveness?.['agent:fixer']?.successes).toBe(0)
    const entry = ctx.strategy_log?.find((s) => s.outcome?.startsWith('failed'))
    expect(entry).toBeDefined()
  })

  test('background task records outcome on completion', async () => {
    await taskTool.execute(
      { description: 'bg work', prompt: 'go', background: true, subagent_type: 'researcher' },
      {
        sessionID: 'parent-1',
        messageID: 'm1',
        db,
        subagentRunner: fakeRunner() as never,
      },
    )
    // wait for the setImmediate background run to finish
    await new Promise((r) => setTimeout(r, 150))
    expect(loadContext().strategy_effectiveness?.['agent:researcher']).toBeDefined()
  })
})
