/**
 * §5 acceptance — approval must be real, authenticated, and independent.
 *
 * docs/LONG_TERM_RISK_AND_SCALABILITY_PLAN.md §5:
 *   "High-risk changes must require a real, authenticated human decision. A
 *    mocked approval implementation must not be represented as production human
 *    approval." and "A candidate must not be allowed to rewrite the policy that
 *    approves that same candidate and then approve itself under the new policy."
 *
 * The previous ApprovalGate had four defects, each covered below.
 */

import { describe, test, expect } from 'bun:test'
import { ApprovalGate, type ApproverIdentity } from './approval.js'
import type { ImprovementProposal } from './proposal.js'
import type { RiskAssessment } from './risk.js'

const proposal = (over: Partial<ImprovementProposal> = {}): ImprovementProposal =>
  ({
    id: 'prop_1',
    painPointId: 'latency',
    kind: 'fix',
    targetFile: 'a.ts',
    reason: 'because',
    change: 'x',
    severity: 'high',
    score: 1,
    state: 'proposed',
    createdAt: 1,
    ...over,
  }) as unknown as ImprovementProposal

const HIGH: RiskAssessment = { level: 'high', score: 0.9, reasons: ['touches auth'] }
const MEDIUM: RiskAssessment = { level: 'medium', score: 0.5, reasons: ['behaviour change'] }
const alice: ApproverIdentity = { owner: 'alice', authenticated: true }
const unauth: ApproverIdentity = { owner: 'whoever', authenticated: false }

describe('§5: an id with no pending request cannot be approved', () => {
  test('approving an unknown id DENIES (it used to return approved:true)', () => {
    const g = new ApprovalGate()
    const r = g.approve('never-submitted', alice)
    expect(r.approved).toBe(false)
    expect(r.reason).toContain('no pending approval request')
  })

  test('approving twice returns the recorded decision, not a fresh invention', () => {
    const g = new ApprovalGate()
    g.requestApproval(proposal(), 3, HIGH)
    const first = g.approve('prop_1', alice)
    expect(first.approved).toBe(true)
    // second call replays the recorded decision
    const second = g.approve('prop_1', alice)
    expect(second.approved).toBe(true)
    expect(second.reason).toContain('recorded decision')
  })

  test('denying an unknown id does not deny (nothing was requested)', () => {
    const g = new ApprovalGate()
    const r = g.deny('never-submitted', alice)
    expect(r.approved).toBe(false)
    expect(r.reason).toContain('no pending')
  })
})

describe('§5: approval requires an authenticated identity', () => {
  test('an unauthenticated identity cannot approve', () => {
    const g = new ApprovalGate()
    g.requestApproval(proposal(), 3, HIGH)
    const r = g.approve('prop_1', unauth)
    expect(r.approved).toBe(false)
    expect(r.pending).toBe(true)
    expect(r.reason).toContain('not authenticated')
    // and it is still pending, so a real approver can still act
    expect(g.isPending('prop_1')).toBe(true)
  })

  test('an unauthenticated identity cannot deny either', () => {
    const g = new ApprovalGate()
    g.requestApproval(proposal(), 3, HIGH)
    const r = g.deny('prop_1', unauth)
    expect(r.approved).toBe(false)
    expect(r.reason).toContain('not authenticated')
    expect(g.isPending('prop_1')).toBe(true)
  })

  test('an authenticated approval is marked authoritative', () => {
    const g = new ApprovalGate()
    g.requestApproval(proposal(), 3, HIGH)
    expect(g.approve('prop_1', alice).authoritative).toBe(true)
  })
})

describe('§5: a proposal may not approve itself', () => {
  test('the author cannot approve their own proposal', () => {
    const g = new ApprovalGate()
    g.requestApproval(proposal({ author: 'coder' } as never), 3, HIGH)
    const r = g.approve('prop_1', { owner: 'coder', authenticated: true })
    expect(r.approved).toBe(false)
    expect(r.reason).toContain('may not approve it')
    expect(g.isPending('prop_1')).toBe(true)
  })

  test('the check honours by/agent as the author field too', () => {
    for (const field of ['author', 'by', 'agent']) {
      const g = new ApprovalGate()
      g.requestApproval(proposal({ [field]: 'agent-x' } as never), 3, HIGH)
      const r = g.approve('prop_1', { owner: 'agent-x', authenticated: true })
      expect(r.approved, field).toBe(false)
    }
  })

  test('a different human may approve it', () => {
    const g = new ApprovalGate()
    g.requestApproval(proposal({ author: 'coder' } as never), 3, HIGH)
    expect(g.approve('prop_1', alice).approved).toBe(true)
  })

  test('a proposal with no author is not blocked', () => {
    const g = new ApprovalGate()
    g.requestApproval(proposal(), 3, HIGH)
    expect(g.approve('prop_1', alice).approved).toBe(true)
  })
})

describe('§5: a mock approval is never presented as a human one', () => {
  test('mock approval is opt-in and off by default', () => {
    const g = new ApprovalGate()
    // level 4 == Canary, where requiresApproval() is true for medium risk
    const r = g.requestApproval(proposal(), 4, MEDIUM)
    expect(r.approved).toBe(false)
    expect(r.pending).toBe(true)
    expect(r.reason).toContain('no mock approver is configured')
  })

  test('even when enabled, a mock approval is not authoritative', () => {
    const g = new ApprovalGate({ allowMockApproval: true })
    const r = g.requestApproval(proposal(), 4, MEDIUM)
    expect(r.approved).toBe(true)
    expect(r.approver).toBe('mock-human')
    // the key property: it cannot stand in for a human on a high-risk change
    expect(r.authoritative).toBe(false)
  })

  test('a low-risk proposal needing no approval is approved but still not authoritative', () => {
    const g = new ApprovalGate()
    const r = g.requestApproval(proposal(), 0, { level: 'low', score: 0.1, reasons: [] })
    expect(r.approved).toBe(true)
    expect(r.approver).toBe('auto')
    expect(r.authoritative).toBeFalsy()
    // but it is explicitly marked as a §18 Level 5 policy decision
    expect(r.policyAuto).toBe(true)
  })

  test('MIRA_APPROVAL_AUTO_LOW=0: even low risk waits for an authenticated human', () => {
    const g = new ApprovalGate({ autoApproveLowRisk: false })
    const r = g.requestApproval(proposal(), 0, { level: 'low', score: 0.1, reasons: [] })
    expect(r.approved).toBe(false)
    expect(r.pending).toBe(true)
    expect(r.policyAuto).toBeUndefined()
    expect(r.reason).toContain('MIRA_APPROVAL_AUTO_LOW=0')
    // and an authenticated non-author human can then approve it
    const a = g.approve(proposal().id, { owner: 'human', authenticated: true })
    expect(a.approved).toBe(true)
    expect(a.authoritative).toBe(true)
  })

  test('high risk always goes pending, even with mock approval enabled', () => {
    const g = new ApprovalGate({ allowMockApproval: true })
    const r = g.requestApproval(proposal(), 3, HIGH)
    expect(r.approved).toBe(false)
    expect(r.pending).toBe(true)
  })
})
