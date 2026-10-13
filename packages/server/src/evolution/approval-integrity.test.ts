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

describe('human operator is the approval authority', () => {
  test('authenticated human approval is marked approverKind "human-operator"', () => {
    const g = new ApprovalGate()
    g.requestApproval(proposal(), 3, HIGH)
    const r = g.approve(proposal().id, { owner: 'human', authenticated: true })
    expect(r.approved).toBe(true)
    expect(r.authoritative).toBe(true)
    expect(r.approverKind).toBe('human-operator')
    expect(r.reason).toContain('human operator')
  })

  test('MIRA_OPERATORS: only designated operators may approve (fail-closed)', () => {
    const g = new ApprovalGate({ operators: ['the-operator'] })
    g.requestApproval(proposal(), 3, HIGH)
    // authenticated but not an operator → refused, stays pending
    const r = g.approve(proposal().id, { owner: 'random-human', authenticated: true })
    expect(r.approved).toBe(false)
    expect(r.pending).toBe(true)
    expect(r.reason).toContain('not a designated operator')
    // the designated operator succeeds
    const r2 = g.approve(proposal().id, { owner: 'the-operator', authenticated: true })
    expect(r2.approved).toBe(true)
    expect(r2.approverKind).toBe('human-operator')
  })

  test('MIRA_OPERATORS applies to deny() as well', () => {
    const g = new ApprovalGate({ operators: ['the-operator'] })
    g.requestApproval(proposal(), 3, HIGH)
    const r = g.deny(proposal().id, { owner: 'random-human', authenticated: true })
    expect(r.approved).toBe(false)
    expect(r.reason).toContain('not a designated operator')
    const r2 = g.deny(proposal().id, { owner: 'the-operator', authenticated: true })
    expect(r2.approved).toBe(false)
    expect(r2.approverKind).toBe('human-operator')
    expect(r2.reason).toContain('denied by human operator')
  })

  test('policy and mock decisions are labelled, never mistaken for operators', () => {
    const g = new ApprovalGate()
    const auto = g.requestApproval(proposal(), 0, { level: 'low', score: 0.1, reasons: [] })
    expect(auto.approverKind).toBe('policy')
    const g2 = new ApprovalGate({ allowMockApproval: true })
    const mock = g2.requestApproval(proposal(), 4, { level: 'medium', score: 0.5, reasons: [] })
    if (mock.approver === 'mock-human') expect(mock.approverKind).toBe('mock')
  })
})

describe('two-person rule — high-risk needs two distinct operators (§18)', () => {
  test('two designated operators: first approval is partial, duplicate ignored, second completes', () => {
    const g = new ApprovalGate({ operators: ['op-a', 'op-b'], twoPersonRule: true })
    g.requestApproval(proposal(), 3, HIGH)
    const first = g.approve(proposal().id, { owner: 'op-a', authenticated: true })
    expect(first.approved).toBe(false)
    expect(first.pending).toBe(true)
    expect(first.approvers).toEqual(['op-a'])
    expect(first.requiredApprovals).toBe(2)
    expect(first.reason).toContain('1 of 2')
    // same operator again does not double-count
    const dup = g.approve(proposal().id, { owner: 'op-a', authenticated: true })
    expect(dup.approved).toBe(false)
    expect(dup.reason).toContain('already approved')
    // second distinct operator completes the quorum
    const second = g.approve(proposal().id, { owner: 'op-b', authenticated: true })
    expect(second.approved).toBe(true)
    expect(second.approvers).toEqual(['op-a', 'op-b'])
    expect(second.reason).toContain('two-person rule')
  })

  test('single operator → two-person rule auto-off (a quorum of 1 is a deadlock)', () => {
    const g = new ApprovalGate({ operators: ['solo'], store: undefined })
    const r = g.requestApproval(proposal(), 3, HIGH)
    expect(r.requiredApprovals).toBe(1)
    const a = g.approve(proposal().id, { owner: 'solo', authenticated: true })
    expect(a.approved).toBe(true)
  })

  test('no operators configured → rule off by default (any authenticated non-author human)', () => {
    const g = new ApprovalGate()
    g.requestApproval(proposal(), 3, HIGH)
    const a = g.approve(proposal().id, { owner: 'human', authenticated: true })
    expect(a.approved).toBe(true)
    expect(a.requiredApprovals).toBeUndefined()
  })

  test('two-person quorum survives a restart via the durable request', () => {
    const pending = new Map<string, unknown>()
    const decided = new Map<string, unknown>()
    const store = {
      loadPending: () => [...pending.values()] as never[],
      loadDecided: () => [...decided.entries()].map(([id, result]) => ({ id, result })) as never[],
      savePending: (req: { id: string }) => pending.set(req.id, JSON.parse(JSON.stringify(req))),
      deletePending: (id: string) => pending.delete(id),
      saveDecided: (id: string, result: unknown) =>
        decided.set(id, JSON.parse(JSON.stringify(result))),
    }
    const g1 = new ApprovalGate({ operators: ['op-a', 'op-b'], twoPersonRule: true, store })
    g1.requestApproval(proposal(), 3, HIGH)
    g1.approve(proposal().id, { owner: 'op-a', authenticated: true })
    // restart: partial quorum persisted
    const g2 = new ApprovalGate({ operators: ['op-a', 'op-b'], twoPersonRule: true, store })
    const second = g2.approve(proposal().id, { owner: 'op-b', authenticated: true })
    expect(second.approved).toBe(true)
    expect(second.approvers).toEqual(['op-a', 'op-b'])
  })
})

describe('aging notifications — escalation is awareness, never approval', () => {
  test('aging emits once per window, re-emits next bucket; young items stay quiet', async () => {
    const { Bus } = await import('../bus/index.js')
    const bus = new Bus()
    const seen: Array<{ id: string; bucket: number }> = []
    bus.subscribeAll?.(
      (e: { type: string; payload?: { proposalId?: string; bucket?: number } }) => {
        if (e.type === 'evolution.approval_aging') {
          seen.push({ id: e.payload?.proposalId ?? '', bucket: e.payload?.bucket ?? 0 })
        }
      },
    )
    const g = new ApprovalGate({ bus, agingMs: 1000 })
    g.requestApproval(proposal(), 3, HIGH)
    const t0 = Date.now()
    // young → quiet
    expect(g.checkAging(t0 + 500)).toBe(0)
    // bucket 1
    expect(g.checkAging(t0 + 1500)).toBe(1)
    // same bucket → no duplicate
    expect(g.checkAging(t0 + 1900)).toBe(0)
    // bucket 2 → re-notify
    expect(g.checkAging(t0 + 2600)).toBe(1)
    expect(seen.filter((s) => s.bucket === 1)).toHaveLength(1)
    expect(seen.filter((s) => s.bucket === 2)).toHaveLength(1)
  })
})

describe('durable approval state — operator queue survives restart', () => {
  const fakeStore = () => {
    const pending = new Map<string, unknown>()
    const decided = new Map<string, unknown>()
    return {
      pending,
      decided,
      loadPending: () => [...pending.values()] as never[],
      loadDecided: () => [...decided.entries()].map(([id, result]) => ({ id, result })) as never[],
      savePending: (req: { id: string }) => pending.set(req.id, JSON.parse(JSON.stringify(req))),
      deletePending: (id: string) => pending.delete(id),
      saveDecided: (id: string, result: unknown) =>
        decided.set(id, JSON.parse(JSON.stringify(result))),
    }
  }

  test('pending request survives a restart; approve on the new gate works', () => {
    const store = fakeStore()
    const g1 = new ApprovalGate({ store })
    const pr = proposal()
    g1.requestApproval(pr, 3, HIGH)
    expect(store.pending.size).toBe(1)

    // "restart": brand-new gate over the same store
    const g2 = new ApprovalGate({ store })
    expect(g2.isPending(pr.id)).toBe(true)
    const r = g2.approve(pr.id, { owner: 'human', authenticated: true })
    expect(r.approved).toBe(true)
    expect(r.approverKind).toBe('human-operator')
    // decided replay is durable too
    expect(g2.approve(pr.id, { owner: 'human', authenticated: true }).reason).toContain(
      'recorded decision',
    )
  })

  test('decided replay survives a restart', () => {
    const store = fakeStore()
    const g1 = new ApprovalGate({ store })
    const pr = proposal()
    g1.requestApproval(pr, 3, HIGH)
    g1.approve(pr.id, { owner: 'human', authenticated: true })
    const g2 = new ApprovalGate({ store })
    const replay = g2.approve(pr.id, { owner: 'human', authenticated: true })
    expect(replay.approved).toBe(true)
    expect(replay.reason).toContain('recorded decision')
  })

  test('store failures never block requestApproval/approve (fail-soft)', () => {
    const throwing = {
      loadPending: () => {
        throw new Error('db gone')
      },
      loadDecided: () => {
        throw new Error('db gone')
      },
      savePending: () => {
        throw new Error('db gone')
      },
      deletePending: () => {
        throw new Error('db gone')
      },
      saveDecided: () => {
        throw new Error('db gone')
      },
    }
    const g = new ApprovalGate({ store: throwing })
    const pr = g.requestApproval(proposal(), 3, HIGH)
    expect(pr.pending).toBe(true)
    const r = g.approve(proposal().id, { owner: 'human', authenticated: true })
    expect(r.approved).toBe(true) // in-memory still works
  })
})
