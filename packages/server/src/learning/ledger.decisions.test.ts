import { describe, test, expect, beforeAll } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendDecision, loadContext, getWorkflowTrace } from './ledger.js'
import { ApprovalGate } from '../evolution/approval.js'
import type { ImprovementProposal } from '../evolution/proposal.js'
import type { RiskAssessment } from '../evolution/risk.js'

// Belt and braces: the bunfig preload only applies when `bun test` runs from
// the repo root. Running this file from packages/server (or via a direct
// script) skips it — without this, appendDecision writes the REPO's
// shared/context.json (observed: test entries leaked into git status).
beforeAll(() => {
  process.env.MIRA_CONTEXT_PATH ??= join(
    mkdtempSync(join(tmpdir(), 'mira-ledger-decisions-test-')),
    'context.json',
  )
})

// Hermetic: the test preload (tests/preload.ts via bunfig.toml) redirects the
// shared ledger to a temp file, so assertions can be exact and the repo's
// shared/context.json is never touched.

describe('appendDecision with evidence/alternatives', () => {
  test('persists evidence and alternatives fields', () => {
    const entry = appendDecision({
      decision: 'test:decision',
      context: 'unit test context',
      by: 'tester',
      evidence: ['metric p95 improved 20%', 'file:line src/a.ts:10'],
      alternatives: ['do nothing', 'roll back'],
    })
    expect(entry.evidence).toEqual(['metric p95 improved 20%', 'file:line src/a.ts:10'])
    expect(entry.alternatives).toEqual(['do nothing', 'roll back'])

    const ctx = loadContext()
    const found = ctx.decisions?.find((d) => d.decision === 'test:decision' && d.by === 'tester')
    expect(found).toBeDefined()
    expect(found?.evidence?.length).toBe(2)
    expect(found?.alternatives?.length).toBe(2)
  })

  test('auto-generates id when omitted', () => {
    const entry = appendDecision({ decision: 'test:autoid', context: 'y', by: 'tester' })
    expect(entry.id).toMatch(/^dec_/)
  })

  test('getWorkflowTrace returns the decision', () => {
    appendDecision({ decision: 'test:tracecheck', evidence: ['e1'], by: 'tester' })
    const trace = getWorkflowTrace()
    const entry = trace.decisions.find((d) => d.decision === 'test:tracecheck')
    expect(entry).toBeDefined()
    expect(entry?.evidence).toContain('e1')
  })
})

describe('ApprovalGate decision log wiring', () => {
  const proposal: ImprovementProposal = {
    id: 'prop_log_1',
    type: 'fix',
    risk: 'high',
    priority: 'p1',
    expectedImpact: 'test',
  } as unknown as ImprovementProposal

  const risk: RiskAssessment = {
    level: 'high',
    score: 0.9,
    reasons: ['touches auth module', 'no test coverage'],
  }

  test('human approve logs decision with risk evidence', () => {
    const gate = new ApprovalGate({})
    gate.requestApproval(proposal, 3, risk)
    expect(gate.isPending('prop_log_1')).toBe(true)

    const result = gate.approve('prop_log_1', { owner: 'alice', authenticated: true })
    expect(result.approved).toBe(true)

    const ctx = loadContext()
    const entry = ctx.decisions?.find((d) => d.decision === 'approval:approved' && d.by === 'alice')
    expect(entry).toBeDefined()
    expect(entry?.evidence).toContain('touches auth module')
    expect(entry?.alternatives).toContain('deny')
  })

  test('human deny logs decision with alternatives', () => {
    const gate = new ApprovalGate({})
    gate.requestApproval(proposal, 3, risk)
    gate.deny('prop_log_1', { owner: 'bob', authenticated: true })

    const ctx = loadContext()
    const entry = ctx.decisions?.find((d) => d.decision === 'approval:denied' && d.by === 'bob')
    expect(entry).toBeDefined()
    expect(entry?.alternatives).toContain('approve')
  })
})
