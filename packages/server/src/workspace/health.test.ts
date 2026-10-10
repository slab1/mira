import { describe, test, expect, beforeEach } from 'bun:test'
import { computeProjectHealth } from './health.js'
import { createWorkspaceIntelligence, setSharedWorkspace } from './intelligence.js'
import { writeFinding } from '../tools/findings.js'
import { createGovernanceGate } from '../patching/governance/index.js'
import { createDatabase, migrate, type MiraDB } from '../storage/db.js'

let db: MiraDB
let workspace: ReturnType<typeof createWorkspaceIntelligence>

beforeEach(async () => {
  db = createDatabase(':memory:')
  await migrate(db)
  workspace = createWorkspaceIntelligence({ db })
  setSharedWorkspace(workspace)
})

describe('computeProjectHealth', () => {
  test('fresh project with no evidence → composite 100, all components neutral', async () => {
    const h = await computeProjectHealth({ db, workspace })
    expect(h.score).toBe(100)
    expect(h.grade).toBe('A')
    for (const c of h.components) expect(c.observations).toBe(0)
    // neutral components must say so honestly
    const defects = h.components.find((x) => x.key === 'defects')!
    expect(defects.detail).toContain('no open findings')
  })

  test('open critical findings drag the defects component down', async () => {
    await writeFinding(db, { title: 'auth bypass', severity: 'critical' })
    await writeFinding(db, { title: 'minor papercut', severity: 'minor' })
    const h = await computeProjectHealth({ db, workspace })
    const defects = h.components.find((x) => x.key === 'defects')!
    expect(defects.observations).toBe(2)
    expect(defects.score).toBe(0) // 10*10 + 1.5*10 > 100 penalty
    expect(defects.detail).toContain('1 critical')
    expect(h.score).toBeLessThan(100)
  })

  test('resolved findings do not count', async () => {
    const f = await writeFinding(db, { title: 'fixed thing', severity: 'major' })
    const { resolveFinding } = await import('../tools/findings.js')
    await resolveFinding(db, f.id)
    const h = await computeProjectHealth({ db, workspace })
    const defects = h.components.find((x) => x.key === 'defects')!
    expect(defects.observations).toBe(0)
  })

  test('guardrail deny rate penalizes the guardrails component', async () => {
    const sqlite = db.sqlite
    const insert = sqlite.prepare(
      `INSERT INTO audit_entries (id, session_id, tool, decision, reason, args, result, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    insert.run('a1', 's1', 'bash', 'allow', 'ok', '{}', '{}', Date.now())
    insert.run('a2', 's2', 'bash', 'deny', 'blocked', '{}', '{}', Date.now())
    const h = await computeProjectHealth({ db, workspace })
    const guard = h.components.find((x) => x.key === 'guardrails')!
    expect(guard.observations).toBe(2)
    expect(guard.score).toBeLessThan(60) // 50% deny rate → 100 - 200 capped at 0... check detail
    expect(guard.detail).toContain('50.0% deny rate')
  })

  test('governance rollbacks penalize the evolution component', async () => {
    const governance = createGovernanceGate({ db, rootDir: process.cwd() })
    const proposal = await governance.createProposal(
      {
        id: 'patch_t1',
        painPointId: 'over-eager',
        kind: 'engine',
        targetFile: 'src/x.ts',
        reason: 'test',
        change: 'x',
        verification: 'tsc --noEmit',
        severity: 'medium',
        score: 0.5,
        createdAt: Date.now(),
      } as Parameters<typeof governance.createProposal>[0],
      { passed: true, verified: true, reason: 'test' } as Parameters<
        typeof governance.createProposal
      >[1],
    )
    await governance.rollback(proposal.id, 'test rollback')
    const h = await computeProjectHealth({ db, workspace, governance })
    const evolution = h.components.find((x) => x.key === 'evolution')!
    expect(evolution.observations).toBe(1)
    expect(evolution.detail).toContain('rolled back')
    expect(evolution.score).toBeLessThan(100)
  })

  test('tech-debt workspace items penalize the debt component', async () => {
    workspace.upsert({ kind: 'tech-debt', title: 'hotspot: a.ts', priority: 'high' })
    workspace.upsert({ kind: 'issue', title: 'bug', priority: 'medium' })
    const h = await computeProjectHealth({ db, workspace })
    const debt = h.components.find((x) => x.key === 'debt')!
    expect(debt.observations).toBe(2)
    expect(debt.detail).toContain('1 tech-debt + 1 direct issue items')
  })

  test('components with no data are excluded from the composite', async () => {
    // only defects have evidence; composite must equal defects score alone
    await writeFinding(db, { title: 'one minor thing', severity: 'minor' })
    const h = await computeProjectHealth({ db, workspace })
    const defects = h.components.find((x) => x.key === 'defects')!
    expect(h.score).toBe(defects.score) // 100 - 1.5*10 = 85
  })

  test('grades map to score bands', async () => {
    await writeFinding(db, { title: 'major', severity: 'major' })
    const h = await computeProjectHealth({ db, workspace })
    expect(h.score).toBe(60)
    expect(h.grade).toBe('C')
  })
})
