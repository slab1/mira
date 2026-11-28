/**
 * Phase 1 Hardening Acceptance Tests (Criteria 1–7):
 *  1. Research unauthenticated -> 401; viewer -> 403 on write
 *  2. Research cross-user & cross-org isolation -> 404; legacy ownerless quarantined to admin
 *  3. Approval altered artifact hash refused
 *  4. Candidate mutated after approval invalidated -> promotion refused
 *  5. Self-approval refused (including case normalization) + signing required / TTL expiry
 *  6. Protected control-plane path / bypass / protect() removal / test weakening blocked
 *  7. Proposal routes enforce auth + non-viewer RBAC when mounted with auth
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { createDatabase, migrate } from '../storage/db.js'
import { Bus } from '../bus/index.js'
import { KnowledgeBase } from '../learning/knowledge.js'
import { OnlineResearchService } from '../research/online-research.js'
import { mountResearchRoutes } from '../routes/research.js'
import { ApprovalGate, type ApproverIdentity } from './approval.js'
import { SIGNING_KEY_ENV } from './approval-signing.js'
import { artifactHash } from './artifact-hash.js'
import { SecurityValidator } from './security.js'
import { SecurityScanner } from '../patching/security.js'
import { SecurityReview } from '../patching/governance/security-review.js'
import { RiskEngine } from './risk.js'
import { checkSelfModificationGate } from './modification-gate.js'
import { mountEvolutionProposalRoutes } from '../routes/evolution.js'
import { createGovernanceGate } from '../patching/governance/index.js'
import { createLearningSystem, mountLearningRoutes } from '../learning/index.js'
import type { ImprovementProposal } from './proposal.js'
import type { RiskAssessment } from './risk.js'
import type { Role } from '../auth/roles.js'

const HIGH_RISK: RiskAssessment = { level: 'high', score: 0.9, reasons: ['high risk test'] }

const makeProposal = (over: Partial<ImprovementProposal> = {}): ImprovementProposal =>
  ({
    id: 'p_phase1',
    title: 'Phase 1 test proposal',
    type: 'fix',
    risk: 'high',
    priority: 'P0',
    affectedEngine: 'tool',
    evidence: null,
    expectedImpact: 'improve speed',
    cause: 'slow loop',
    confidence: 0.9,
    createdAt: Date.now(),
    ...over,
  }) as ImprovementProposal

describe('Phase 1 AC1–AC2: Research ownership, org isolation & legacy quarantine', () => {
  let db: ReturnType<typeof createDatabase>
  let bus: Bus
  let service: OnlineResearchService
  let app: Hono<{ Variables: { requestId: string } }>

  const TOKENS: Record<string, { owner: string; role: Role; org?: string }> = {
    'tok-alice': { owner: 'alice', role: 'operator', org: 'org-a' },
    'tok-alice-mate': { owner: 'aaron', role: 'operator', org: 'org-a' },
    'tok-bob': { owner: 'bob', role: 'operator', org: 'org-b' },
    'tok-viewer': { owner: 'veronica', role: 'viewer', org: 'org-a' },
    'tok-admin': { owner: 'admin-user', role: 'admin', org: 'org-admin' },
  }

  beforeEach(async () => {
    db = createDatabase(':memory:')
    await migrate(db)
    bus = new Bus()
    const knowledge = new KnowledgeBase({ bus, db })
    service = new OnlineResearchService({ db, bus, knowledge })
    app = new Hono<{ Variables: { requestId: string } }>()
    mountResearchRoutes(app, {
      service,
      resolveOwner: (t) => TOKENS[t]?.owner,
      resolveRole: (t) => TOKENS[t]?.role ?? 'operator',
      orgOfOwner: (owner) => Object.values(TOKENS).find((x) => x.owner === owner)?.org,
      requireAuth: true,
    })

    // Seed runs directly in SQLite: alice's run, bob's run, and a legacy ownerless run.
    const now = Date.now()
    const stmt = db.sqlite.prepare(`
      INSERT INTO research_runs (
        id, session_id, branch_session_id, owner_id, org_id, mode, query, status,
        plan_json, steps_json, citations_json, tokens_in, tokens_out, duration_ms, created_at, updated_at
      ) VALUES (?, NULL, NULL, ?, ?, 'deep-investigation', ?, 'awaiting_approval', '[]', '[]', '[]', 0, 0, 0, ?, ?)
    `)
    stmt.run('run_alice', 'alice', 'org-a', 'alice research query', now, now)
    stmt.run('run_bob', 'bob', 'org-b', 'bob research query', now, now)
    stmt.run('run_legacy', null, null, 'legacy ownerless research', now, now)
  })

  afterEach(() => {
    try {
      db.sqlite.close()
    } catch {}
  })

  test('AC1: unauthenticated calls fail with 401; viewer cannot mutate', async () => {
    expect((await app.request('/research/status')).status).toBe(401)
    expect((await app.request('/research/runs')).status).toBe(401)
    expect((await app.request('/research/runs/run_alice')).status).toBe(401)
    expect(
      (
        await app.request('/research/runs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: 'hello' }),
        })
      ).status,
    ).toBe(401)

    // Viewer can read org-a run, cannot start/approve/cancel/promote
    const vGet = await app.request('/research/runs/run_alice', {
      headers: { authorization: 'Bearer tok-viewer' },
    })
    expect(vGet.status).toBe(200)

    const vStart = await app.request('/research/runs', {
      method: 'POST',
      headers: { authorization: 'Bearer tok-viewer', 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'hello' }),
    })
    expect(vStart.status).toBe(403)

    const vCancel = await app.request('/research/runs/run_alice/cancel', {
      method: 'POST',
      headers: { authorization: 'Bearer tok-viewer' },
    })
    expect(vCancel.status).toBe(403)
  })

  test('AC2: cross-user/cross-org isolation (404) + same-org allowed + legacy quarantined to admin', async () => {
    // Bob (org-b) cannot read or mutate Alice's (org-a) run
    expect(
      (
        await app.request('/research/runs/run_alice', {
          headers: { authorization: 'Bearer tok-bob' },
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await app.request('/research/runs/run_alice/cancel', {
          method: 'POST',
          headers: { authorization: 'Bearer tok-bob' },
        })
      ).status,
    ).toBe(404)

    // Same-org peer (aaron in org-a) can see alice's org-a run, not bob's or legacy
    const mateList = (await (
      await app.request('/research/runs', { headers: { authorization: 'Bearer tok-alice-mate' } })
    ).json()) as { runs: Array<{ id: string }> }
    expect(mateList.runs.map((r) => r.id)).toEqual(['run_alice'])

    // Non-admin cannot access legacy ownerless records
    expect(
      (
        await app.request('/research/runs/run_legacy', {
          headers: { authorization: 'Bearer tok-alice' },
        })
      ).status,
    ).toBe(404)

    // Admin with explicit ?includeLegacy=1 sees quarantined legacy records
    const adminDefault = (await (
      await app.request('/research/runs', { headers: { authorization: 'Bearer tok-admin' } })
    ).json()) as { runs: Array<{ id: string }> }
    expect(adminDefault.runs.map((r) => r.id)).not.toContain('run_legacy')

    const adminLegacy = (await (
      await app.request('/research/runs?includeLegacy=1', {
        headers: { authorization: 'Bearer tok-admin' },
      })
    ).json()) as { runs: Array<{ id: string }> }
    expect(adminLegacy.runs.map((r) => r.id)).toContain('run_legacy')
    expect(
      (
        await app.request('/research/runs/run_legacy', {
          headers: { authorization: 'Bearer tok-admin' },
        })
      ).status,
    ).toBe(200)
  })
})

describe('Phase 1 AC3–AC5: Artifact hash binding, post-approval invalidation, self-approval & TTL/signing', () => {
  const prevKey = process.env[SIGNING_KEY_ENV]
  afterEach(() => {
    if (prevKey === undefined) delete process.env[SIGNING_KEY_ENV]
    else process.env[SIGNING_KEY_ENV] = prevKey
  })

  test('AC3: approving with an altered expectedHash is refused', () => {
    const gate = new ApprovalGate()
    const art = { targetFile: 'packages/server/src/tools/read.ts', change: '+const a = 1' }
    gate.requestApproval(makeProposal(), 3, HIGH_RISK, art)
    const alice: ApproverIdentity = { owner: 'alice', authenticated: true, role: 'operator' }
    const bad = gate.approve('p_phase1', alice, { expectedHash: 'deadbeef0000' })
    expect(bad.approved).toBe(false)
    expect(bad.reason).toContain('does not match')
    expect(gate.isPending('p_phase1')).toBe(true)
  })

  test('AC4: candidate mutated after approval is refused + invalidateProposal revokes prior approval', () => {
    const gate = new ApprovalGate()
    const orig = { targetFile: 'packages/server/src/tools/read.ts', change: '+const safe = 1' }
    const mutated = { targetFile: 'packages/server/src/tools/read.ts', change: '+const evil = 1' }
    const expectedHash = artifactHash(orig)
    gate.requestApproval(makeProposal(), 3, HIGH_RISK, orig)
    const alice: ApproverIdentity = { owner: 'alice', authenticated: true, role: 'operator' }
    expect(gate.approve('p_phase1', alice, { expectedHash }).approved).toBe(true)

    expect(gate.authorizesArtifact(orig).ok).toBe(true)
    expect(gate.authorizesArtifact(mutated).ok).toBe(false)

    // Invalidation revokes even the original hash if the proposal is flagged as mutated
    expect(gate.invalidateProposal('p_phase1', 'diff changed')).toBe(true)
    expect(gate.authorizesArtifact(orig).ok).toBe(false)
  })

  test('AC5: normalized self-approval refused; requireSignature & maxApprovalAgeMs enforced', () => {
    delete process.env[SIGNING_KEY_ENV]
    const strictGate = new ApprovalGate({ requireSignature: true })
    const art = { targetFile: 'packages/server/src/tools/read.ts', change: '+const a = 1' }
    strictGate.requestApproval(makeProposal({ createdBy: 'Alice' } as never), 3, HIGH_RISK, art)

    // Case-normalized self-approval refused even without signing check
    const gateNoSig = new ApprovalGate({ requireSignature: false })
    gateNoSig.requestApproval(makeProposal({ createdBy: 'Alice' } as never), 3, HIGH_RISK, art)
    const selfRes = gateNoSig.approve('p_phase1', {
      owner: 'alice',
      authenticated: true,
      role: 'operator',
    })
    expect(selfRes.approved).toBe(false)
    expect(selfRes.reason).toContain('authored this proposal')

    // Missing signing key refuses when requireSignature=true
    const noKeyRes = strictGate.approve('p_phase1', {
      owner: 'bob',
      authenticated: true,
      role: 'operator',
    })
    expect(noKeyRes.approved).toBe(false)
    expect(noKeyRes.reason).toContain('signing is required')

    // TTL expiry blocks authorizesArtifact
    process.env[SIGNING_KEY_ENV] = 'phase1-test-signing-key-32bytes-minimum'
    const expiringGate = new ApprovalGate({ requireSignature: true, maxApprovalAgeMs: 1 })
    expiringGate.requestApproval(makeProposal(), 3, HIGH_RISK, art)
    const ok = expiringGate.approve('p_phase1', {
      owner: 'bob',
      authenticated: true,
      role: 'operator',
    })
    expect(ok.approved).toBe(true)
    // Backdate decidedAt in index to simulate elapsed TTL
    const idx = (
      expiringGate as unknown as {
        approvedArtifacts: Map<string, { id: string; approver?: string; signature?: string; decidedAt?: number }>
      }
    ).approvedArtifacts
    const rec = idx.get(artifactHash(art))!
    rec.decidedAt = Date.now() - 1000
    const auth = expiringGate.authorizesArtifact(art)
    expect(auth.ok).toBe(false)
    expect(auth.reason).toContain('expired')
  })
})

describe('Phase 1 AC6–AC7: Control-plane protection, test weakening & proposal route RBAC', () => {
  test('AC6: protected control-plane paths, bypasses, protect() removal & test weakening are blocked', async () => {
    const validator = new SecurityValidator()
    const scanner = new SecurityScanner()
    const secReview = new SecurityReview(scanner)
    const riskEngine = new RiskEngine()

    // Protected path
    const cpVal = validator.validate('export const x = 1', ['packages/server/src/auth/roles.ts'])
    expect(cpVal.passed).toBe(false)
    const cpReview = await secReview.review(
      '--- a/packages/server/src/sandbox/isolation.ts\n+++ b/packages/server/src/sandbox/isolation.ts\n@@ -1 +1 @@\n-a\n+b\n',
      'packages/server/src/sandbox/isolation.ts',
    )
    expect(cpReview.passed).toBe(false)
    expect(cpReview.outcome).toBe('FAILED')

    // RiskEngine marks protected control-plane as critical severityTier + high level
    const risk = riskEngine.assess({
      changedFiles: ['packages/server/src/evolution/approval.ts'],
      patch: 'MIRA_STRICT_AUTH=0',
    })
    expect(risk.level).toBe('high')
    expect(risk.protectedControlPlane).toBe(true)
    expect(risk.severityTier).toBe('critical')

    // Modification gate blocks unauthorized control-plane change
    const modDenied = checkSelfModificationGate({
      confidence: 0.95,
      validationPassed: true,
      rollbackAvailable: true,
      riskLevel: 'high',
      protectedControlPlane: true,
      humanAuthorized: false,
    })
    expect(modDenied.allowed).toBe(false)

    // Removing protect() call
    const protectDiff = [
      '--- a/app/VpnManager.kt',
      '+++ b/app/VpnManager.kt',
      '@@ -10,1 +10,1 @@',
      '-vpnService.protect(socket)',
      '+// socket opened directly',
    ].join('\n')
    expect(validator.validate(protectDiff, ['app/VpnManager.kt']).passed).toBe(false)
    expect((await secReview.review(protectDiff, 'app/VpnManager.kt')).passed).toBe(false)

    // Test weakening (skipped test & removed assertion)
    const skipTestDiff = [
      '--- a/packages/server/src/foo.test.ts',
      '+++ b/packages/server/src/foo.test.ts',
      '@@ -1,2 +1,2 @@',
      '-test("checks security", () => { expect(res.status).toBe(401) })',
      '+test.skip("checks security", () => {})',
    ].join('\n')
    expect(validator.validate(skipTestDiff, ['packages/server/src/foo.test.ts']).passed).toBe(false)
    expect((await secReview.review(skipTestDiff, 'packages/server/src/foo.test.ts')).passed).toBe(false)
  })

  test('AC7: proposal routes via mountLearningRoutes enforce auth and reject viewer mutations', async () => {
    const db = createDatabase(':memory:')
    await migrate(db)
    const bus = new Bus()
    const system = createLearningSystem({ db, bus })
    const app = new Hono<{ Variables: { requestId: string } }>()
    mountLearningRoutes(app, system, {
      resolveOwner: (t) => (t === 'op' ? 'alice' : t === 'view' ? 'bob' : undefined),
      resolveRole: (t) => (t === 'view' ? 'viewer' : 'operator'),
      requireAuth: true,
    })

    // Unauthenticated rejected
    expect((await app.request('/evolution/proposals')).status).toBe(401)
    expect((await app.request('/evolution/proposals/p1/promote', { method: 'POST' })).status).toBe(401)

    // Viewer can read, cannot advance/promote/rollback
    expect(
      (await app.request('/evolution/proposals', { headers: { authorization: 'Bearer view' } })).status,
    ).toBe(200)
    expect(
      (
        await app.request('/evolution/proposals/p1/advance', {
          method: 'POST',
          headers: { authorization: 'Bearer view' },
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await app.request('/evolution/proposals/p1/promote', {
          method: 'POST',
          headers: { authorization: 'Bearer view' },
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await app.request('/evolution/proposals/p1/rollback', {
          method: 'POST',
          headers: { authorization: 'Bearer view', 'content-type': 'application/json' },
          body: JSON.stringify({ reason: 'test' }),
        })
      ).status,
    ).toBe(403)

    // Operator can read and reach normal route handler (404 for unknown id)
    expect(
      (
        await app.request('/evolution/proposals/p1/advance', {
          method: 'POST',
          headers: { authorization: 'Bearer op' },
        })
      ).status,
    ).toBe(404)

    db.sqlite.close()
  })
})
