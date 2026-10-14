/**
 * Human approval on the promotion path, and artifact-bound approvals.
 *
 * The gap these cover: ApprovalGate gated the observe/propose flow, but the
 * path that actually turns a candidate into a real change —
 * GovernanceGate.promote() → Promoter → createPullRequestForPatch — never
 * consulted it. Nothing in packages/server/src/patching/ referenced approval at
 * all, so a measured candidate could be promoted with no human decision.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGovernanceGate, type GovernanceGateDeps } from './index.js'
import { artifactHash } from '../../evolution/artifact-hash.js'
import { ApprovalGate, createSqliteApprovalStore } from '../../evolution/approval.js'
import { createDatabase } from '../../storage/db.js'
import type { ImprovementProposal } from '../../evolution/proposal.js'
import type { RiskAssessment } from '../../evolution/risk.js'

const PATCH = {
  id: 'cand_prop_1',
  painPointId: 'correctness',
  kind: 'fix',
  targetFile: 'src/auth.ts',
  reason: 'reason',
  change: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n',
  verification: 'tsc --noEmit',
  severity: 'major',
  score: 9,
  createdAt: Date.now(),
  diff: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n',
} as never
const VERIFY = { passed: true, testsPassed: 1, testsFailed: 0 } as never

const EVIDENCED_STAGES = {
  benchmark: { run: async () => ({ passed: true, reason: 'ok', before: { p95Ms: 100 } }) },
  canary: { start: async () => ({ passed: true, reason: 'ok', metrics: { p95Ms: 100 } }) },
}

let dir = ''
let db: ReturnType<typeof createDatabase>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mira-promote-approval-'))
  db = createDatabase(join(dir, 'm.db'))
})
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

const promoted = { applied: true, prUrl: 'https://x/pr/1' }

/** Drive a proposal all the way to CANARY_PASSED. */
async function readyToPromote(over: Partial<GovernanceGateDeps> = {}) {
  const g = createGovernanceGate({
    db,
    rootDir: process.cwd(),
    ...EVIDENCED_STAGES,
    ...over,
  })
  const p = await g.createProposal(PATCH, VERIFY)
  await g.advance(p.id)
  await g.advance(p.id)
  await g.advance(p.id)
  return { g, p }
}

describe('promotion requires a human approval (fail-closed)', () => {
  test('no approvalCheck wired blocks promotion', async () => {
    let promoterRan = false
    const { g, p } = await readyToPromote({
      promoter: {
        promote: async () => {
          promoterRan = true
          return promoted
        },
      },
    })
    const r = await g.promote(p.id)
    expect(r.applied).toBe(false)
    expect(r.reason).toBe('approval_check_missing')
    expect(promoterRan).toBe(false)
  })

  test('an approval check that refuses blocks promotion', async () => {
    let promoterRan = false
    const { g, p } = await readyToPromote({
      approvalCheck: () => ({ ok: false, reason: 'not approved' }),
      promoter: {
        promote: async () => {
          promoterRan = true
          return promoted
        },
      },
    })
    const r = await g.promote(p.id)
    expect(r.applied).toBe(false)
    expect(r.reason).toContain('approval_required')
    expect(r.reason).toContain('not approved')
    expect(promoterRan).toBe(false)
  })

  test('a malformed approval verdict (ok undefined) blocks promotion', async () => {
    const { g, p } = await readyToPromote({
      approvalCheck: () => undefined as unknown as { ok: boolean },
      promoter: { promote: async () => promoted },
    })
    const r = await g.promote(p.id)
    expect(r.applied).toBe(false)
    expect(r.reason).toContain('approval_required')
  })

  test('an approving checker lets promotion through', async () => {
    const { g, p } = await readyToPromote({
      approvalCheck: () => ({ ok: true }),
      promoter: { promote: async () => promoted },
    })
    expect((await g.promote(p.id)).applied).toBe(true)
  })

  test('approval is checked against the candidate actually being promoted', async () => {
    const seen: Array<{ targetFile: string | null; change: string | null }> = []
    const { g, p } = await readyToPromote({
      approvalCheck: (proposal) => {
        seen.push({ targetFile: proposal.targetFile, change: proposal.change })
        return { ok: true }
      },
      promoter: { promote: async () => promoted },
    })
    await g.promote(p.id)
    expect(seen).toHaveLength(1)
    expect(seen[0].targetFile).toBe('src/auth.ts')
    expect(seen[0].change).toBe((PATCH as { change: string }).change)
  })

  test('earlier gate diagnostics keep their precedence over approval', async () => {
    // A row at CANARY_PASSED with no stage metadata must still report the
    // stage failure — the operator needs the actionable reason, and approval
    // is the last gate, not the first.
    const g = createGovernanceGate({ db, rootDir: process.cwd() })
    const p = await g.createProposal(PATCH, VERIFY)
    g.store.update(p.id, {
      state: 'CANARY_PASSED',
      metadata: { verifyResult: VERIFY },
      updatedAt: Date.now(),
    })
    const r = await g.promote(p.id)
    expect(r.applied).toBe(false)
    expect(r.reason).toContain('stage_missing')
  })
})

describe('approvals are bound to the exact artifact', () => {
  const ARTIFACT = { targetFile: 'src/auth.ts', change: (PATCH as { change: string }).change }
  const OTHER = { targetFile: 'src/auth.ts', change: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+EVIL\n' }
  const HIGH: RiskAssessment = { level: 'high', score: 0.9, reasons: ['touches auth'] }
  const proposal = {
    id: 'prop_1',
    createdBy: 'agent',
    risk: 'high',
  } as unknown as ImprovementProposal
  const op = { owner: 'alice', authenticated: true, role: 'operator' as const }

  function gateWithApproval(artifact: unknown) {
    const g = new ApprovalGate({
      store: createSqliteApprovalStore(createDatabase(join(dir, 'a.db'))),
    })
    g.requestApproval(proposal, 1, HIGH, artifact as never)
    return g
  }

  test('an approved artifact authorizes exactly that artifact', () => {
    const g = gateWithApproval(ARTIFACT)
    expect(g.approve('prop_1', op).approved).toBe(true)
    expect(g.authorizesArtifact(ARTIFACT).ok).toBe(true)
  })

  test('it does NOT authorize a different diff on the same file', () => {
    const g = gateWithApproval(ARTIFACT)
    g.approve('prop_1', op)
    const r = g.authorizesArtifact(OTHER)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('no authoritative human approval')
  })

  test('it does NOT authorize the same diff on a different file', () => {
    const g = gateWithApproval(ARTIFACT)
    g.approve('prop_1', op)
    expect(g.authorizesArtifact({ ...ARTIFACT, targetFile: 'src/other.ts' }).ok).toBe(false)
  })

  test('an unapproved artifact authorizes nothing', () => {
    const g = gateWithApproval(ARTIFACT)
    expect(g.authorizesArtifact(ARTIFACT).ok).toBe(false)
  })

  test('a denied request does not authorize the artifact', () => {
    const g = gateWithApproval(ARTIFACT)
    g.deny('prop_1', op)
    expect(g.authorizesArtifact(ARTIFACT).ok).toBe(false)
  })

  test('a policy auto-approval never authorizes an artifact', () => {
    // Low-risk policy auto-approval returns approved:true with
    // authoritative:false. It must not create an artifact authorization.
    const g = new ApprovalGate()
    const res = g.requestApproval(
      { id: 'low', createdBy: 'system' } as unknown as ImprovementProposal,
      0,
      { level: 'low', score: 0.1, reasons: [] },
      ARTIFACT,
    )
    expect(res.approved).toBe(true)
    expect(res.authoritative).toBe(false)
    expect(g.authorizesArtifact(ARTIFACT).ok).toBe(false)
  })

  test('a decision is refused when the stored artifact is mutated after the fact', () => {
    const g = gateWithApproval(ARTIFACT)
    // Simulate the artifact being edited between "operator saw it" and "decision".
    g.getPending('prop_1')!.artifact = { ...OTHER }
    const r = g.approve('prop_1', op)
    expect(r.approved).toBe(false)
    expect(r.reason).toContain('artifact changed')
  })

  test('a decision is refused when the artifact is missing but a hash was recorded', () => {
    const g = gateWithApproval(ARTIFACT)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(g.getPending('prop_1') as any).artifact = undefined
    const r = g.approve('prop_1', op)
    expect(r.approved).toBe(false)
    expect(r.reason).toContain('unverifiable content')
  })

  test('the artifact binding survives a restart', () => {
    const dbPath = join(dir, 'restart.db')
    const g1 = new ApprovalGate({ store: createSqliteApprovalStore(createDatabase(dbPath)) })
    g1.requestApproval(proposal, 1, HIGH, ARTIFACT)
    expect(g1.approve('prop_1', op).approved).toBe(true)

    // New process, same DB — the approval must still authorize the artifact.
    const g2 = new ApprovalGate({ store: createSqliteApprovalStore(createDatabase(dbPath)) })
    expect(g2.authorizesArtifact(ARTIFACT).ok).toBe(true)
    expect(g2.authorizesArtifact(OTHER).ok).toBe(false)
  })

  test('artifactHash is stable and collision-resistant across field boundaries', () => {
    expect(artifactHash(ARTIFACT)).toBe(artifactHash({ ...ARTIFACT }))
    // Shifting the separator must not collide.
    expect(artifactHash({ targetFile: 'a', change: 'bc' })).not.toBe(
      artifactHash({ targetFile: 'ab', change: 'c' }),
    )
  })
})
