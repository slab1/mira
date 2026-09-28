/**
 * Task Verification States — enforcement tests
 * (docs/VERIFICATION_STATES_DESIGN.md §5 a–e + §7 test plan)
 *
 * The executable form of §13: a job can only be VERIFIED through persisted
 * exit-code evidence (diagnose/bash parts of the child session) — prose claims
 * ("tests pass!") stay UNVERIFIED, raw SQL inherits the DB DEFAULTs, and BOTH
 * terminal writers (finishJob + orchestrate's inline UPDATE) leave every row
 * non-null and in-enum.
 */
import { describe, test, expect } from 'bun:test'
import { eq } from 'drizzle-orm'
import {
  buildVerificationPatch,
  classifyBashCommand,
  computeVerification,
  type VerificationPartInput,
} from './verification.js'
import { createDatabase, migrate, type MiraDB } from './storage/db.js'
import { sessions, messages, parts } from './storage/schema.js'
import { taskTool, getJob, listJobs, cancelJob } from './tools/task.js'
import { orchestrateTool, cancelOrchestrateJob } from './tools/orchestrate.js'
import { Bus } from './bus/index.js'
import type { ToolContext } from './tools/registry.js'

const NOW = 1_700_000_000_000
const ENUM = ['UNVERIFIED', 'PARTIALLY_VERIFIED', 'VERIFIED', 'FAILED_VERIFICATION'] as const

// ── helpers ─────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { sessionID: 'sess-v', messageID: 'msg-v', ...overrides } as ToolContext
}

interface CapturedEvent {
  type: string
  sessionID?: string
  payload?: unknown
}

function makeBus(captured: CapturedEvent[]): Bus {
  return {
    publish: (event: { type: string; sessionID?: string; payload?: unknown }): void => {
      captured.push({ type: event.type, sessionID: event.sessionID, payload: event.payload })
    },
  } as unknown as Bus
}

async function testDB(): Promise<MiraDB> {
  const db = createDatabase(':memory:')
  await migrate(db)
  return db
}

async function addSession(db: MiraDB, id: string): Promise<void> {
  await db.insert(sessions).values({ id, title: 't', createdAt: NOW, updatedAt: NOW })
}

/** Child session + one message + fake verification tool-result parts (§3 evidence). */
async function seedChild(
  db: MiraDB,
  childID: string,
  opts: {
    diag?: Array<{ check: 'typecheck' | 'test' | 'build'; ok: boolean; offset?: number }>
    bash?: Array<{ command: string; exitCode?: number; isError?: boolean; offset?: number }>
    proseOnly?: boolean
  } = {},
): Promise<string> {
  await addSession(db, childID)
  const messageID = `m-${childID}`
  await db.insert(messages).values({ id: messageID, sessionID: childID, role: 'assistant', createdAt: NOW })
  let i = 0
  for (const d of opts.diag ?? []) {
    await db.insert(parts).values({
      id: `p-${childID}-${i++}`,
      messageID,
      sessionID: childID,
      type: 'tool-result',
      tool: 'diagnose',
      toolCallID: `tc-${i}`,
      result: { ok: d.ok, checks: [d.check], results: [{ check: d.check, ok: d.ok }] },
      isError: false,
      createdAt: NOW + (d.offset ?? i),
    })
  }
  for (const b of opts.bash ?? []) {
    await db.insert(parts).values({
      id: `p-${childID}-${i++}`,
      messageID,
      sessionID: childID,
      type: 'tool-result',
      tool: 'bash',
      toolCallID: `tc-${i}`,
      // crash results carry no `command` → sibling tool-call supplies it (§1);
      // exitCode is only present when the tool actually returned one
      result: b.isError
        ? { error: 'spawn failed' }
        : b.exitCode === undefined
          ? { stdout: 'All tests passed!', stderr: '', command: b.command }
          : { stdout: '', stderr: b.exitCode === 0 ? '' : 'x', exitCode: b.exitCode, command: b.command },
      isError: b.isError ?? false,
      createdAt: NOW + (b.offset ?? i),
    })
    if (b.isError) {
      await db.insert(parts).values({
        id: `pc-${childID}-${i}`,
        messageID,
        sessionID: childID,
        type: 'tool-call',
        tool: 'bash',
        toolCallID: `tc-${i}`,
        args: { command: b.command },
        createdAt: NOW + (b.offset ?? i),
      })
    }
  }
  if (opts.proseOnly) {
    // prose claim persisted as a TEXT part — no exit codes, no verification
    await db.insert(parts).values({
      id: `pt-${childID}`,
      messageID,
      sessionID: childID,
      type: 'text',
      text: 'All 47 tests pass! Typecheck clean.',
      createdAt: NOW + 1,
    })
  }
  return childID
}

type RunOpts = { prompt: string; parentID: string; agent?: string; title?: string; signal?: AbortSignal }

function runnerSeed(
  db: MiraDB,
  seed: Parameters<typeof seedChild>[2],
  text = 'done',
): (opts: RunOpts) => Promise<{ sessionID: string; text: string }> {
  return async (opts: RunOpts) => {
    const childID = `child-${opts.parentID.slice(0, 6)}-${Math.random().toString(36).slice(2, 8)}`
    await seedChild(db, childID, seed)
    return { sessionID: childID, text }
  }
}

function payloadOf(e: CapturedEvent | undefined): Record<string, unknown> {
  return (e?.payload ?? {}) as Record<string, unknown>
}

// ── (a) §3 scenario table — computeVerification is pure & fail-closed ──

const t1 = NOW
const t2 = NOW + 1000
const t3 = NOW + 2000

function diag(check: 'typecheck' | 'test' | 'build', ok: boolean, at: number): VerificationPartInput {
  return {
    messageID: 'm1',
    toolCallID: `tc-${check}-${at}`,
    tool: 'diagnose',
    isError: false,
    createdAt: at,
    result: { ok, checks: [check], results: [{ check, ok }] },
  }
}

function bashP(command: string, exitCode: number | undefined, at: number): VerificationPartInput {
  return {
    messageID: 'm1',
    toolCallID: `tb-${at}`,
    tool: 'bash',
    isError: false,
    createdAt: at,
    // command always present; exitCode only when the tool returned one
    result:
      exitCode === undefined
        ? { stdout: 'All tests passed!', stderr: '', command }
        : { stdout: '', stderr: exitCode === 0 ? '' : 'x', exitCode, command },
  }
}

/** Tool-crash shape: `{error}` + isError=true — command only via sibling tool-call args. */
function bashCrashP(command: string, at: number): VerificationPartInput {
  return {
    messageID: 'm1',
    toolCallID: `tc-${at}`,
    tool: 'bash',
    isError: true,
    createdAt: at,
    result: { error: 'spawn failed' },
    command,
  }
}

const scenarios: Array<{ name: string; parts: VerificationPartInput[]; state: string }> = [
  { name: 'no entries → UNVERIFIED', parts: [], state: 'UNVERIFIED' },
  { name: 'diagnose[typecheck] ok → PARTIALLY_VERIFIED', parts: [diag('typecheck', true, t1)], state: 'PARTIALLY_VERIFIED' },
  { name: 'diagnose[test] ok → VERIFIED', parts: [diag('test', true, t1)], state: 'VERIFIED' },
  { name: 'diagnose[build] ok → PARTIALLY_VERIFIED', parts: [diag('build', true, t1)], state: 'PARTIALLY_VERIFIED' },
  {
    name: 'test ok then typecheck fail → FAILED_VERIFICATION',
    parts: [diag('test', true, t1), diag('typecheck', false, t2)],
    state: 'FAILED_VERIFICATION',
  },
  {
    name: 'typecheck fail then test ok (typecheck never re-run) → FAILED (fail-closed stickiness)',
    parts: [diag('typecheck', false, t1), diag('test', true, t2)],
    state: 'FAILED_VERIFICATION',
  },
  {
    name: 'failed class re-runs passing → PARTIALLY_VERIFIED (§2.1 transition)',
    parts: [diag('typecheck', false, t1), diag('typecheck', true, t2)],
    state: 'PARTIALLY_VERIFIED',
  },
  {
    name: 'failed class re-passes + test pass → VERIFIED (§2.1 transition)',
    parts: [diag('typecheck', false, t1), diag('test', true, t2), diag('typecheck', true, t3)],
    state: 'VERIFIED',
  },
  {
    name: 'latest-per-class: older test fail superseded by newer pass → VERIFIED',
    parts: [diag('test', false, t1), diag('test', true, t2)],
    state: 'VERIFIED',
  },
  {
    name: 'latest-per-class: older test pass superseded by newer fail → FAILED',
    parts: [diag('test', true, t1), diag('test', false, t2)],
    state: 'FAILED_VERIFICATION',
  },
  {
    name: 'one diagnose run, mixed checks (typecheck ok + test fail) → FAILED',
    parts: [
      {
        messageID: 'm1',
        toolCallID: 'tc-mixed',
        tool: 'diagnose',
        isError: false,
        createdAt: t1,
        result: {
          ok: false,
          checks: ['typecheck', 'test'],
          results: [
            { check: 'typecheck', ok: true },
            { check: 'test', ok: false },
          ],
        },
      },
    ],
    state: 'FAILED_VERIFICATION',
  },
  {
    name: 'one diagnose run, all checks pass → VERIFIED',
    parts: [
      {
        messageID: 'm1',
        toolCallID: 'tc-all',
        tool: 'diagnose',
        isError: false,
        createdAt: t1,
        result: {
          ok: true,
          checks: ['typecheck', 'test'],
          results: [
            { check: 'typecheck', ok: true },
            { check: 'test', ok: true },
          ],
        },
      },
    ],
    state: 'VERIFIED',
  },
  { name: 'bash `bun test` exit 0 → VERIFIED', parts: [bashP('bun test', 0, t1)], state: 'VERIFIED' },
  { name: 'bash `bun test src/x` exit 1 → FAILED', parts: [bashP('bun test src/x', 1, t1)], state: 'FAILED_VERIFICATION' },
  { name: 'bash `npm test` exit 0 → VERIFIED', parts: [bashP('npm test', 0, t1)], state: 'VERIFIED' },
  { name: 'bash `pytest -q` exit 0 → VERIFIED', parts: [bashP('pytest -q', 0, t1)], state: 'VERIFIED' },
  {
    name: 'bash `tsc --noEmit` exit 0 → PARTIALLY_VERIFIED',
    parts: [bashP('node node_modules/typescript/bin/tsc --noEmit', 0, t1)],
    state: 'PARTIALLY_VERIFIED',
  },
  { name: 'bash `bun run build` exit 0 → PARTIALLY_VERIFIED', parts: [bashP('bun run build', 0, t1)], state: 'PARTIALLY_VERIFIED' },
  { name: 'bash `ls` exit 0 → ignored (unrecognized) → UNVERIFIED', parts: [bashP('ls', 0, t1)], state: 'UNVERIFIED' },
  { name: 'bash `git status` exit 0 → ignored → UNVERIFIED', parts: [bashP('git status', 0, t1)], state: 'UNVERIFIED' },
  {
    name: 'evidence WITHOUT exit code (prose stdout claim) → UNVERIFIED',
    parts: [
      {
        messageID: 'm1',
        toolCallID: 'tc-prose',
        tool: 'bash',
        isError: false,
        createdAt: t1,
        result: { stdout: 'All tests passed!', stderr: '', command: 'echo tests passed' },
      },
    ],
    state: 'UNVERIFIED',
  },
  {
    name: 'evidence WITHOUT exit code (diagnose crash, no results[]) → UNVERIFIED',
    parts: [
      {
        messageID: 'm1',
        toolCallID: 'tc-crash',
        tool: 'diagnose',
        isError: true,
        createdAt: t1,
        result: { error: 'spawn failed' },
      },
    ],
    state: 'UNVERIFIED',
  },
  {
    name: 'bash tool-crash ({error}, isError) on MATCHING command → FAILED',
    parts: [bashCrashP('bun test', t1)],
    state: 'FAILED_VERIFICATION',
  },
  {
    name: 'matching command, missing exitCode, not isError → FAILED (fail-closed)',
    parts: [bashP('bun test', undefined, t1)],
    state: 'FAILED_VERIFICATION',
  },
  { name: 'non-tool parts (read/text) → UNVERIFIED', parts: [{ tool: 'read', messageID: 'm1', toolCallID: 'r1', createdAt: t1, result: { file: 'x' } }], state: 'UNVERIFIED' },
]

describe('computeVerification (§3 state machine, table-driven)', () => {
  for (const s of scenarios) {
    test(s.name, () => {
      expect(computeVerification(s.parts).state).toBe(s.state)
    })
  }
})

describe('classifyBashCommand (§3.2)', () => {
  test('verification commands map to the closed class set', () => {
    expect(classifyBashCommand('bun test')).toBe('test')
    expect(classifyBashCommand('bun test src/learning')).toBe('test')
    expect(classifyBashCommand('npm test')).toBe('test')
    expect(classifyBashCommand('pytest -q')).toBe('test')
    expect(classifyBashCommand('bunx tsc --noEmit')).toBe('typecheck')
    expect(classifyBashCommand('node node_modules/typescript/bin/tsc --noEmit -p packages/server')).toBe('typecheck')
    expect(classifyBashCommand('bun run build')).toBe('build')
  })
  test('unrecognized commands return null (fail-closed — ignored, never verified)', () => {
    expect(classifyBashCommand('ls -la')).toBeNull()
    expect(classifyBashCommand('git status')).toBeNull()
    expect(classifyBashCommand('echo All tests pass!')).toBeNull()
    expect(classifyBashCommand('bun run typecheck')).toBeNull() // not in design's pattern map → ignored
  })
})

describe('evidence (§4 — EvidenceRef reused, capped at 8)', () => {
  test('refs carry kind:message + {check, ok} extras + msg:<messageID>#<toolCallID>', () => {
    const out = computeVerification([diag('test', true, t1)])
    expect(out.evidence).toEqual([
      { kind: 'message', ref: 'msg:m1#tc-test-1700000000000', at: t1, check: 'test', ok: true },
    ])
  })
  test('cap 8 — newest kept, oldest dropped', () => {
    const ten = Array.from({ length: 10 }, (_, i) => diag('typecheck', true, NOW + i))
    const out = computeVerification(ten)
    expect(out.state).toBe('PARTIALLY_VERIFIED')
    expect(out.evidence.length).toBe(8)
    expect(out.evidence[0]?.at).toBe(NOW + 2) // dropped the 2 oldest
    expect(out.evidence[7]?.at).toBe(NOW + 9)
  })
  test('UNVERIFIED outcomes carry empty evidence (nothing classifiable)', () => {
    expect(computeVerification([bashP('ls', 0, t1)]).evidence).toEqual([])
    expect(computeVerification([]).evidence).toEqual([])
  })
})

describe('buildVerificationPatch (§5 input)', () => {
  test('no child link → undefined (caller keeps UNVERIFIED default)', async () => {
    const db = await testDB()
    expect(await buildVerificationPatch(db, undefined)).toBeUndefined()
    expect(await buildVerificationPatch(db, null)).toBeUndefined()
    expect(await buildVerificationPatch(db, '')).toBeUndefined()
  })
  test('child session with no verification parts → UNVERIFIED patch', async () => {
    const db = await testDB()
    await seedChild(db, 'child-none')
    const patch = await buildVerificationPatch(db, 'child-none')
    expect(patch?.verificationState).toBe('UNVERIFIED')
    expect(patch?.verificationEvidence).toEqual([])
    expect(patch?.verificationUpdatedAt).toBeGreaterThan(0)
  })
  test('reads only diagnose/bash tool-result parts of the child session', async () => {
    const db = await testDB()
    await seedChild(db, 'child-read', { diag: [{ check: 'test', ok: true }] })
    // sibling session with different evidence must NOT bleed in
    await seedChild(db, 'child-other', { diag: [{ check: 'typecheck', ok: false }] })
    const patch = await buildVerificationPatch(db, 'child-read')
    expect(patch?.verificationState).toBe('VERIFIED')
    expect(patch?.verificationEvidence.length).toBe(1)
  })
  test('bash crash part resolves command from sibling tool-call args', async () => {
    const db = await testDB()
    await seedChild(db, 'child-crash', { bash: [{ command: 'bun test', isError: true }] })
    const patch = await buildVerificationPatch(db, 'child-crash')
    expect(patch?.verificationState).toBe('FAILED_VERIFICATION')
    expect(patch?.verificationEvidence[0]).toMatchObject({ kind: 'message', check: 'test', ok: false })
  })
})

// ── (b) e2e settle through BOTH terminal writers + event ────────────

describe('e2e settles (§5 b — chokepoints)', () => {
  test('chokepoint 1: finishJob (fg task) settles VERIFIED from child parts + publishes event', async () => {
    const db = await testDB()
    await addSession(db, 'sess-fg')
    const events: CapturedEvent[] = []
    const bus = makeBus(events)
    const ctx = makeCtx({ sessionID: 'sess-fg', bus, subagentRunner: runnerSeed(db, { diag: [{ check: 'test', ok: true }] }) })
    ;(ctx as ToolContext & { db: MiraDB }).db = db

    const res = await taskTool.execute({ description: 'v', prompt: 'p' }, ctx)
    expect(res.status).toBe('completed')
    expect(res.verification?.state).toBe('VERIFIED')

    const row = await getJob(db, res.jobID as string)
    expect(row?.status).toBe('completed')
    expect(row?.verificationState).toBe('VERIFIED')
    expect(row?.verificationEvidence.length).toBe(1)
    expect(row?.verificationEvidence[0]?.kind).toBe('message')
    expect(row?.verificationEvidence[0]?.check).toBe('test')
    expect(row?.verificationUpdatedAt).toBeGreaterThan(0)

    // §6 discriminated event on the existing job.updated type
    const ev = events.find(
      (e) => e.type === 'job.updated' && payloadOf(e).kind === 'verification.state',
    )
    expect(ev).toBeDefined()
    const p = payloadOf(ev) as { jobID: string; verification: { state: string; at?: number } }
    expect(p.jobID).toBe(res.jobID)
    expect(p.verification.state).toBe('VERIFIED')
    expect(typeof p.verification.at).toBe('number')
  })

  test('chokepoint 1: fg settle with failing typecheck → FAILED_VERIFICATION', async () => {
    const db = await testDB()
    await addSession(db, 'sess-fg-fail')
    const events: CapturedEvent[] = []
    const ctx = makeCtx({
      sessionID: 'sess-fg-fail',
      bus: makeBus(events),
      subagentRunner: runnerSeed(db, { diag: [{ check: 'typecheck', ok: false }] }),
    })
    ;(ctx as ToolContext & { db: MiraDB }).db = db

    const res = await taskTool.execute({ description: 'v', prompt: 'p' }, ctx)
    expect(res.verification?.state).toBe('FAILED_VERIFICATION')
    const row = await getJob(db, res.jobID as string)
    expect(row?.verificationState).toBe('FAILED_VERIFICATION')
    // §8 fail-closed stickiness: agent is told to rerun the failed class
    expect(row?.verificationEvidence[0]?.ok).toBe(false)
    const ev = events.find(
      (e) => e.type === 'job.updated' && payloadOf(e).kind === 'verification.state',
    )
    expect(payloadOf(ev).verification).toMatchObject({ state: 'FAILED_VERIFICATION' })
  })

  test('chokepoint 1 background settle (:155 path) → VERIFIED', async () => {
    const db = await testDB()
    await addSession(db, 'sess-bg')
    const events: CapturedEvent[] = []
    const ctx = makeCtx({
      sessionID: 'sess-bg',
      bus: makeBus(events),
      subagentRunner: runnerSeed(db, { diag: [{ check: 'test', ok: true }] }),
    })
    ;(ctx as ToolContext & { db: MiraDB }).db = db

    const res = await taskTool.execute({ description: 'v', prompt: 'p', background: true }, ctx)
    expect(res.status).toBe('background')
    const deadline = Date.now() + 5000
    let row = await getJob(db, res.jobID as string)
    while (row?.status === 'running' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20))
      row = await getJob(db, res.jobID as string)
    }
    expect(row?.status).toBe('completed')
    expect(row?.verificationState).toBe('VERIFIED')
    // additive message.updated payload carries the view (§6)
    const msg = events.find(
      (e) => e.type === 'message.updated' && !!payloadOf(e).verification,
    )
    expect(payloadOf(msg).verification).toMatchObject({ state: 'VERIFIED' })
  }, 10_000)

  test('chokepoint 2: orchestrate inline terminal write settles VERIFIED (§8 easy-to-miss writer)', async () => {
    const db = await testDB()
    await addSession(db, 'sess-orch')
    const events: CapturedEvent[] = []
    const ctx = makeCtx({
      sessionID: 'sess-orch',
      bus: makeBus(events),
      subagentRunner: runnerSeed(db, { diag: [{ check: 'test', ok: true }] }),
    })
    ;(ctx as ToolContext & { db: MiraDB }).db = db

    await orchestrateTool.execute(
      { goal: 'verify me', tasks: [{ id: 'a', prompt: 'p', budgetSteps: 10 }], mergeStrategy: 'lead-synthesis' },
      ctx,
    )
    const rows = await listJobs(db, 'sess-orch')
    expect(rows.length).toBe(1)
    expect(rows[0]?.status).toBe('completed')
    expect(rows[0]?.verificationState).toBe('VERIFIED')
    expect(rows[0]?.verificationEvidence.length).toBe(1)

    // §7 step 5: `verification` included in the :496 job payload
    const ju = events.find((e) => e.type === 'job.updated' && payloadOf(e).taskID === 'a')
    expect(payloadOf(ju).verification).toMatchObject({ state: 'VERIFIED' })
  })

  test('chokepoint 2: orchestrate node failure (no child link) → UNVERIFIED, never crashes', async () => {
    const db = await testDB()
    await addSession(db, 'sess-orch-f')
    const ctx = makeCtx({
      sessionID: 'sess-orch-f',
      subagentRunner: async () => {
        throw new Error('node exploded')
      },
    })
    ;(ctx as ToolContext & { db: MiraDB }).db = db

    await orchestrateTool.execute(
      { goal: 'fail', tasks: [{ id: 'a', prompt: 'p', budgetSteps: 10 }], mergeStrategy: 'lead-synthesis' },
      ctx,
    )
    const rows = await listJobs(db, 'sess-orch-f')
    expect(rows[0]?.status).toBe('failed')
    expect(rows[0]?.verificationState).toBe('UNVERIFIED')
    expect(rows[0]?.verificationEvidence).toEqual([])
  })
})

// ── §13 keystone: claims without exit codes are impossible to verify ──

describe('ENFORCEMENT: VERIFIED unreachable without exit-code evidence (§5)', () => {
  test('agent prose "All tests pass!" with NO verify parts → stays UNVERIFIED, no event', async () => {
    const db = await testDB()
    await addSession(db, 'sess-claim')
    const events: CapturedEvent[] = []
    const ctx = makeCtx({
      sessionID: 'sess-claim',
      bus: makeBus(events),
      // child persisted a prose claim only — no diagnose/bash results
      subagentRunner: runnerSeed(db, { proseOnly: true }, 'All 47 tests pass! Typecheck clean.'),
    })
    ;(ctx as ToolContext & { db: MiraDB }).db = db

    const res = await taskTool.execute({ description: 'v', prompt: 'p' }, ctx)
    expect(res.status).toBe('completed')
    expect(res.result).toContain('tests pass') // the claim is in the prose…
    expect(res.verification?.state).toBe('UNVERIFIED') // …and the row contradicts it
    const row = await getJob(db, res.jobID as string)
    expect(row?.verificationState).toBe('UNVERIFIED')
    expect(row?.verificationEvidence).toEqual([])
    // gate: no verification.state event is published for UNVERIFIED settles (§6)
    expect(events.some((e) => payloadOf(e).kind === 'verification.state')).toBe(false)
  })

  test('tool result without exit codes (prose stdout) → UNVERIFIED through the real settle', async () => {
    const db = await testDB()
    await addSession(db, 'sess-noexit')
    const childID = 'child-noexit'
    await seedChild(db, childID, {
      bash: [{ command: 'echo All tests passed', exitCode: undefined, isError: false }],
    })
    const patch = await buildVerificationPatch(db, childID)
    expect(patch?.verificationState).toBe('UNVERIFIED')
    expect(patch?.verificationEvidence).toEqual([])
  })
})

// ── (d) failure path / (c) raw DEFAULTs / (e) evidence survival ─────

describe('settle edge cases (§5 c–e)', () => {
  test('(d) fg runner throws → no child link → row stays UNVERIFIED without crashing', async () => {
    const db = await testDB()
    await addSession(db, 'sess-throws')
    const ctx = makeCtx({
      sessionID: 'sess-throws',
      subagentRunner: async () => {
        throw new Error('runner exploded')
      },
    })
    ;(ctx as ToolContext & { db: MiraDB }).db = db

    await expect(taskTool.execute({ description: 'v', prompt: 'p' }, ctx)).rejects.toThrow('runner exploded')
    const rows = await listJobs(db, 'sess-throws')
    expect(rows[0]?.status).toBe('failed')
    expect(rows[0]?.verificationState).toBe('UNVERIFIED')
    expect(rows[0]?.verificationUpdatedAt).toBeNull() // never settled
  })

  test("(c) raw INSERT omitting the columns inherits the DB DEFAULTs ('UNVERIFIED'/'[]')", async () => {
    const db = await testDB()
    await addSession(db, 'sess-raw')
    db.sqlite.exec(
      `INSERT INTO jobs (id, parent_session_id, prompt, status, created_at, updated_at)
       VALUES ('raw-bypass', 'sess-raw', 'p', 'completed', ${Date.now()}, ${Date.now()})`,
    )
    const row = db.sqlite
      .prepare(
        `SELECT verification_state, verification_evidence, verification_updated_at FROM jobs WHERE id = 'raw-bypass'`,
      )
      .get() as Record<string, unknown>
    expect(row.verification_state).toBe('UNVERIFIED')
    expect(row.verification_evidence).toBe('[]')
    expect(row.verification_updated_at).toBeNull()
  })

  test('(e) delete the child parts AFTER settle → state + evidence survive (snapshotted in the job row)', async () => {
    const db = await testDB()
    await addSession(db, 'sess-survive')
    const ctx = makeCtx({
      sessionID: 'sess-survive',
      subagentRunner: runnerSeed(db, { diag: [{ check: 'test', ok: true }] }),
    })
    ;(ctx as ToolContext & { db: MiraDB }).db = db

    const res = await taskTool.execute({ description: 'v', prompt: 'p' }, ctx)
    expect((await getJob(db, res.jobID as string))?.verificationState).toBe('VERIFIED')

    // compaction/snapshot deletes remove the parts (design §2.4 risk)
    await db.delete(parts).where(eq(parts.sessionID, res.childSessionID as string))
    const gone = db.sqlite
      .prepare(`SELECT COUNT(*) as c FROM parts WHERE session_id = ?`)
      .get(res.childSessionID) as { c: number }
    expect(gone.c).toBe(0)

    const row = await getJob(db, res.jobID as string)
    expect(row?.verificationState).toBe('VERIFIED') // settled state persisted
    expect(row?.verificationEvidence.length).toBe(1) // evidence snapshotted into the row
  })

  test('cancel (§5.3) never verifies — cancelled row stays UNVERIFIED', async () => {
    const db = await testDB()
    await addSession(db, 'sess-cancel')
    const now = Date.now()
    db.sqlite.exec(
      `INSERT INTO jobs (id, parent_session_id, prompt, status, created_at, updated_at)
       VALUES ('job-cancel', 'sess-cancel', 'p', 'running', ${now}, ${now})`,
    )
    const cancelled = await cancelJob(db, 'job-cancel')
    expect(cancelled?.status).toBe('cancelled')
    expect(cancelled?.verificationState).toBe('UNVERIFIED')

    const o = await cancelOrchestrateJob(db, 'job-cancel')
    expect(o?.status).toBe('cancelled')
    expect(o?.verificationState).toBe('UNVERIFIED')
  })
})

// ── sweep: EVERY terminal write path leaves a non-null, in-enum state ──

describe('enforcement sweep (§5 b, both writers)', () => {
  test('fg completed / fg failed / bg completed / orchestrate completed / cancelled / raw → zero invalid rows', async () => {
    const db = await testDB()
    await addSession(db, 'sess-sweep')

    // 1. fg completed with evidence (chokepoint 1)
    const fg = await taskTool.execute(
      { description: 'a', prompt: 'p' },
      makeCtx({ sessionID: 'sess-sweep', db, subagentRunner: runnerSeed(db, { diag: [{ check: 'test', ok: true }] }) }),
    )
    expect(fg.jobID).toBeTruthy()

    // 2. fg failed without child link (chokepoint 1, failure path)
    await expect(
      taskTool.execute(
        { description: 'b', prompt: 'p' },
        makeCtx({
          sessionID: 'sess-sweep',
          db,
          subagentRunner: async () => {
            throw new Error('nope')
          },
        }),
      ),
    ).rejects.toThrow()

    // 3. bg completed with evidence (chokepoint 1, :155)
    const bg = await taskTool.execute(
      { description: 'c', prompt: 'p', background: true },
      makeCtx({ sessionID: 'sess-sweep', db, subagentRunner: runnerSeed(db, { diag: [{ check: 'test', ok: true }] }) }),
    )
    const deadline = Date.now() + 5000
    let bgRow = await getJob(db, bg.jobID as string)
    while (bgRow?.status === 'running' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20))
      bgRow = await getJob(db, bg.jobID as string)
    }
    expect(bgRow?.status).toBe('completed')

    // 4. orchestrate completed with evidence (chokepoint 2)
    await orchestrateTool.execute(
      { goal: 'sweep', tasks: [{ id: 'a', prompt: 'p', budgetSteps: 10 }], mergeStrategy: 'lead-synthesis' },
      makeCtx({ sessionID: 'sess-sweep', db, subagentRunner: runnerSeed(db, { diag: [{ check: 'test', ok: true }] }) }),
    )

    // 5. raw SQL bypass → DEFAULT backstop
    db.sqlite.exec(
      `INSERT INTO jobs (id, parent_session_id, prompt, status, created_at, updated_at)
       VALUES ('raw-sweep', 'sess-sweep', 'p', 'completed', ${Date.now()}, ${Date.now()})`,
    )

    // flush any fire-and-forget bg settle
    await new Promise((r) => setTimeout(r, 150))

    // THE assertion: non-null + in-enum on EVERY row (design §5 b sweep)
    const bad = db.sqlite
      .prepare(
        `SELECT COUNT(*) as c FROM jobs
         WHERE verification_state IS NULL
            OR verification_state NOT IN ('UNVERIFIED','PARTIALLY_VERIFIED','VERIFIED','FAILED_VERIFICATION')
            OR verification_evidence IS NULL`,
      )
      .get() as { c: number }
    expect(bad.c).toBe(0)

    const total = db.sqlite.prepare('SELECT COUNT(*) as c FROM jobs').get() as { c: number }
    expect(total.c).toBeGreaterThanOrEqual(5)

    // and the honest distribution: evidence-bearing rows verified, others not
    const verified = db.sqlite
      .prepare(`SELECT COUNT(*) as c FROM jobs WHERE verification_state = 'VERIFIED'`)
      .get() as { c: number }
    expect(verified.c).toBeGreaterThanOrEqual(3)
    const unverified = db.sqlite
      .prepare(`SELECT COUNT(*) as c FROM jobs WHERE verification_state = 'UNVERIFIED'`)
      .get() as { c: number }
    // fg-failure (no child link) + raw-SQL bypass
    expect(unverified.c).toBeGreaterThanOrEqual(2)
  }, 20_000)
})
