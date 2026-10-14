/**
 * Sprint 1 approval-integrity items: server-side approver capability
 * enforcement, atomic decision transitions, and stale-request expiry.
 *
 * Context: docs/APPROVAL_SYSTEM_REVIEW.md Sprint 1. Item 3 (enforce approver
 * capabilities on the server) was previously enforced only by the HTTP RBAC
 * middleware, so the capability did not hold for any other caller of the gate.
 * Item 6 (explicit states + transactional transitions) previously wrote the
 * decision and cleared the pending request as two separate writes.
 */
import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApprovalGate, createSqliteApprovalStore, type ApprovalStore } from './approval.js'
import { createDatabase } from '../storage/db.js'
import type { ImprovementProposal } from './proposal.js'
import type { RiskAssessment } from './risk.js'

const proposal = (over: Partial<ImprovementProposal> = {}): ImprovementProposal =>
  ({
    id: 'prop_cap',
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

// A gate that always produces a pending high-risk request.
function gateWithPending(opts?: ConstructorParameters<typeof ApprovalGate>[0]) {
  const g = new ApprovalGate(opts)
  g.requestApproval(proposal(), 1, HIGH)
  return g
}

describe('item 3: approver capability is enforced in the gate, not just the route', () => {
  test('a viewer-role identity cannot approve', () => {
    const g = gateWithPending()
    const r = g.approve('prop_cap', { owner: 'bob', authenticated: true, role: 'viewer' })
    expect(r.approved).toBe(false)
    expect(r.reason).toContain('lacks the "operator" approval capability')
    expect(g.isPending('prop_cap')).toBe(true)
  })

  test('a viewer-role identity cannot deny', () => {
    const g = gateWithPending()
    const r = g.deny('prop_cap', { owner: 'bob', authenticated: true, role: 'viewer' })
    expect(r.reason).toContain('lacks the "operator" approval capability')
    // Still pending — a rejected denial must not resolve the case.
    expect(g.isPending('prop_cap')).toBe(true)
  })

  test('an identity with no role fails closed (cannot approve by omission)', () => {
    const g = gateWithPending()
    const r = g.approve('prop_cap', { owner: 'bob', authenticated: true })
    expect(r.approved).toBe(false)
    expect(r.reason).toContain('capability not established')
  })

  test('operator and admin may approve', () => {
    const g1 = gateWithPending()
    expect(
      g1.approve('prop_cap', { owner: 'op', authenticated: true, role: 'operator' }).approved,
    ).toBe(true)
    const g2 = gateWithPending()
    expect(
      g2.approve('prop_cap', { owner: 'ad', authenticated: true, role: 'admin' }).approved,
    ).toBe(true)
  })

  test('minApproverRole can be relaxed for open single-operator deployments', () => {
    const g = gateWithPending({ minApproverRole: 'viewer' })
    const r = g.approve('prop_cap', { owner: 'bob', authenticated: true, role: 'viewer' })
    expect(r.approved).toBe(true)
  })

  test('capability is checked before the two-person quorum is recorded', () => {
    const g = gateWithPending({ operators: ['a', 'b'], twoPersonRule: true })
    const rejected = g.approve('prop_cap', { owner: 'c', authenticated: true, role: 'viewer' })
    expect(rejected.approved).toBe(false)
    // A rejected approver must not have advanced the quorum.
    expect(g.getPending('prop_cap')?.approvers ?? []).toEqual([])
  })
})

describe('item 6: stale approval requests expire', () => {
  test('a request older than maxRequestAgeMs cannot be approved', () => {
    const g = new ApprovalGate({ maxRequestAgeMs: 1000 })
    g.requestApproval(proposal(), 1, HIGH)
    // Backdate the request past the limit.
    const req = g.getPending('prop_cap')!
    req.requestedAt = Date.now() - 10_000
    const r = g.approve('prop_cap', { owner: 'op', authenticated: true, role: 'operator' })
    expect(r.approved).toBe(false)
    expect(r.reason).toContain('expired')
  })

  test('an expired request cannot be denied either', () => {
    const g = new ApprovalGate({ maxRequestAgeMs: 1000 })
    g.requestApproval(proposal(), 1, HIGH)
    g.getPending('prop_cap')!.requestedAt = Date.now() - 10_000
    const r = g.deny('prop_cap', { owner: 'op', authenticated: true, role: 'operator' })
    expect(r.reason).toContain('expired')
    expect(g.isPending('prop_cap')).toBe(true)
  })

  test('a fresh request is unaffected', () => {
    const g = new ApprovalGate({ maxRequestAgeMs: 3_600_000 })
    g.requestApproval(proposal(), 1, HIGH)
    expect(
      g.approve('prop_cap', { owner: 'op', authenticated: true, role: 'operator' }).approved,
    ).toBe(true)
  })

  test('maxRequestAgeMs: 0 disables expiry', () => {
    const g = new ApprovalGate({ maxRequestAgeMs: 0 })
    g.requestApproval(proposal(), 1, HIGH)
    g.getPending('prop_cap')!.requestedAt = 0
    expect(
      g.approve('prop_cap', { owner: 'op', authenticated: true, role: 'operator' }).approved,
    ).toBe(true)
  })
})

describe('item 6: decision transition is atomic', () => {
  const dirs: string[] = []
  function store(): ApprovalStore {
    const dir = mkdtempSync(join(tmpdir(), 'mira-approval-'))
    dirs.push(dir)
    return createSqliteApprovalStore(createDatabase(join(dir, 'm.db')))
  }
  function cleanup() {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  }

  test('commitDecision moves the case from pending to decided in one step', () => {
    const s = store()
    const g = new ApprovalGate({ store: s })
    g.requestApproval(proposal(), 1, HIGH)
    expect(s.loadPending().map((p) => p.id)).toEqual(['prop_cap'])

    const r = g.approve('prop_cap', { owner: 'op', authenticated: true, role: 'operator' })
    expect(r.approved).toBe(true)

    // Neither stranded: exactly one queue holds the case.
    expect(s.loadPending().map((p) => p.id)).toEqual([])
    expect(s.loadDecided().map((d) => d.id)).toEqual(['prop_cap'])
    cleanup()
  })

  test('a denial also lands decided and clears pending atomically', () => {
    const s = store()
    const g = new ApprovalGate({ store: s })
    g.requestApproval(proposal(), 1, HIGH)
    g.deny('prop_cap', { owner: 'op', authenticated: true, role: 'operator' })
    expect(s.loadPending().map((p) => p.id)).toEqual([])
    expect(s.loadDecided().map((d) => d.id)).toEqual(['prop_cap'])
    cleanup()
  })

  test('the decided state survives a restart (replay returns the recorded answer)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mira-approval-restart-'))
    dirs.push(dir)
    const dbPath = join(dir, 'm.db')
    const g1 = new ApprovalGate({ store: createSqliteApprovalStore(createDatabase(dbPath)) })
    g1.requestApproval(proposal(), 1, HIGH)
    g1.approve('prop_cap', { owner: 'op', authenticated: true, role: 'operator' })

    // New process, same DB.
    const g2 = new ApprovalGate({ store: createSqliteApprovalStore(createDatabase(dbPath)) })
    const replay = g2.approve('prop_cap', {
      owner: 'someone-else',
      authenticated: true,
      role: 'operator',
    })
    expect(replay.approved).toBe(true)
    expect(replay.approver).toBe('op')
    expect(replay.reason).toContain('recorded decision')
    cleanup()
  })

  test('a still-pending request survives a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mira-approval-pending-'))
    dirs.push(dir)
    const dbPath = join(dir, 'm.db')
    const g1 = new ApprovalGate({ store: createSqliteApprovalStore(createDatabase(dbPath)) })
    g1.requestApproval(proposal(), 1, HIGH)

    const g2 = new ApprovalGate({ store: createSqliteApprovalStore(createDatabase(dbPath)) })
    expect(g2.isPending('prop_cap')).toBe(true)
    cleanup()
  })

  test('a store without commitDecision still works via the two-step fallback', () => {
    // Proves the optional method is genuinely optional (back-compat).
    const calls: string[] = []
    const s: ApprovalStore = {
      loadPending: () => [],
      loadDecided: () => [],
      savePending: () => void calls.push('savePending'),
      deletePending: () => void calls.push('deletePending'),
      saveDecided: () => void calls.push('saveDecided'),
    }
    const g = new ApprovalGate({ store: s })
    g.requestApproval(proposal(), 1, HIGH)
    g.approve('prop_cap', { owner: 'op', authenticated: true, role: 'operator' })
    expect(calls).toContain('deletePending')
    expect(calls).toContain('saveDecided')
  })
})
