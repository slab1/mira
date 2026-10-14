/**
 * End-to-end reachability: can a governance proposal EVER be promoted?
 *
 * 0d4b6a2 made promotion fail closed on a human approval bound to the exact
 * artifact. But the two systems that have to agree on that artifact are built
 * separately:
 *
 *   - GovernanceGate.createProposal() is called by PatchingEngine.runCycle()
 *     from the patching subsystem, and never touches ApprovalGate.
 *   - ApprovalGate.requestApproval() is called by the evolution observe flow,
 *     and never creates a governance proposal.
 *
 * So before this file existed there was no evidence that an approval could ever
 * MATCH a promotable artifact. If it cannot, the fail-closed gate is not a
 * security control — it is a permanent outage wearing one.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGovernanceGate } from './index.js'
import {
  authorizePromotion,
  getActiveApprovalGate,
  raiseApprovalForArtifact,
  setActiveApprovalGate,
} from '../../evolution/approval.js'
import { createDatabase } from '../../storage/db.js'
import { ApprovalGate } from '../../evolution/approval.js'
import type { ImprovementProposal } from '../../evolution/proposal.js'

const PATCH = {
  id: 'cand_prop_9',
  painPointId: 'correctness',
  kind: 'fix',
  targetFile: 'src/auth.ts',
  reason: 'rotate the secret',
  change: '--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1 @@\n-secret\n+rotated\n',
  verification: 'tsc --noEmit',
  severity: 'major',
  score: 9,
  createdAt: 1,
  diff: '--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1 @@\n-secret\n+rotated\n',
} as never
const VERIFY = { passed: true, testsPassed: 1, testsFailed: 0 } as never

let dir = ''
let db: ReturnType<typeof createDatabase>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mira-reach-'))
  db = createDatabase(join(dir, 'm.db'))
  // The bridge needs the live gate, exactly as mountEvolutionRoutes publishes it.
  setActiveApprovalGate(new ApprovalGate())
})
afterEach(() => {
  setActiveApprovalGate(null)
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

describe('a promotable proposal must be able to obtain an approval', () => {
  test('creating a governance proposal raises an approval bound to its artifact', async () => {
    // This is the bridge. Without it, nothing can ever authorize a promotion
    // and the fail-closed gate blocks every promote() forever.
    const g = createGovernanceGate({
      db,
      rootDir: process.cwd(),
      onProposalCreated: (proposal) => {
        raiseApprovalForArtifact(
          {
            id: proposal.id,
            title: proposal.reason,
            createdBy: 'patching-engine',
            risk: 'high',
          } as unknown as ImprovementProposal,
          { targetFile: proposal.targetFile, change: proposal.change },
        )
      },
    })
    const p = await g.createProposal(PATCH, VERIFY)

    // The approval request now exists and names the same bytes the promoter
    // will apply.
    const r = authorizePromotion({ targetFile: p.targetFile, change: p.change })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('no authoritative human approval')

    // And it is reachable as a pending request an operator can act on.
    expect(getActiveApprovalGate()?.isPending(p.id)).toBe(true)
  })

  test('the whole loop closes: propose -> human approves -> promote succeeds', async () => {
    const gate = new ApprovalGate()
    setActiveApprovalGate(gate)

    const g = createGovernanceGate({
      db,
      rootDir: process.cwd(),
      onProposalCreated: (proposal) => {
        raiseApprovalForArtifact(
          {
            id: proposal.id,
            createdBy: 'patching-engine',
            risk: 'high',
          } as unknown as ImprovementProposal,
          { targetFile: proposal.targetFile, change: proposal.change },
        )
      },
      approvalCheck: (proposal) =>
        authorizePromotion({ targetFile: proposal.targetFile, change: proposal.change }),
      benchmark: { run: async () => ({ passed: true, reason: 'ok', before: { p95Ms: 100 } }) },
      canary: { start: async () => ({ passed: true, reason: 'ok', metrics: { p95Ms: 100 } }) },
      promoter: { promote: async () => ({ applied: true, prUrl: 'https://x/pr/1' }) },
    })

    const p = await g.createProposal(PATCH, VERIFY)
    await g.advance(p.id)
    await g.advance(p.id)
    await g.advance(p.id)

    // Before an operator acts, promotion is refused. This is the security
    // property, and it must not be a permanent block.
    const before = await g.promote(p.id)
    expect(before.applied).toBe(false)
    expect(before.reason).toContain('approval_required')

    // An authenticated operator approves the exact change.
    const decision = gate.approve(p.id, { owner: 'alice', authenticated: true, role: 'operator' })
    expect(decision.approved).toBe(true)
    expect(decision.authoritative).toBe(true)

    // Now promotion proceeds.
    const after = await g.promote(p.id)
    expect(after.applied).toBe(true)
    expect((await g.get(p.id))?.state).toBe('PROMOTED')
  })

  test('an approval for one change does not authorize a different one', async () => {
    const gate = new ApprovalGate()
    setActiveApprovalGate(gate)
    const g = createGovernanceGate({
      db,
      rootDir: process.cwd(),
      onProposalCreated: (proposal) => {
        raiseApprovalForArtifact(
          {
            id: proposal.id,
            createdBy: 'patching-engine',
            risk: 'high',
          } as unknown as ImprovementProposal,
          { targetFile: proposal.targetFile, change: proposal.change },
        )
      },
      approvalCheck: (proposal) =>
        authorizePromotion({ targetFile: proposal.targetFile, change: proposal.change }),
      promoter: { promote: async () => ({ applied: true, prUrl: 'https://x/pr/1' }) },
    })
    const p = await g.createProposal(PATCH, VERIFY)
    gate.approve(p.id, { owner: 'alice', authenticated: true, role: 'operator' })

    // Same file, different diff — must not be authorized.
    const r = authorizePromotion({
      targetFile: p.targetFile,
      change: `${p.change}\n+extra-line\n`,
    })
    expect(r.ok).toBe(false)
  })
})
