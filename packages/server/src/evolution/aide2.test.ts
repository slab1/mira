/**
 * AIDE² Recursive Self-Improvement Test Suite
 *
 * Covers:
 *   1. Held-out generalization & anti-reward-hacking gates (`generalization.ts`, `verifier.ts`)
 *   2. Bounded loop context compaction (`context-budget.ts`)
 *   3. Recursive generational baseline promotion loop (`lineage.ts`) — human-gated
 *   4. UCB1 bandit-guided multi-candidate search (`bandit.ts`)
 *   5. HTTP endpoints (`GET /evolution/lineage`, `POST /evolution/search/step`,
 *      `POST /evolution/generations/:id/promote`, `POST /evolution/generations/:id/reject`)
 *      including fail-closed auth & artifact hash integrity checks.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase, migrate } from '../storage/db.js'
import { Bus } from '../bus/index.js'
import { mountEvolutionRoutes } from '../routes/evolution.js'
import { detectRewardHacking, evaluateGeneralization } from './generalization.js'
import { BoundedLoopContextManager } from './context-budget.js'
import { EvolutionLineageStore } from './lineage.js'
import { BanditSearchEngine, computeUcb1Score } from './bandit.js'
import { createExperiment } from './experiment.js'
import { verify } from './verifier.js'
import { diagnose } from './diagnosis.js'
import { propose } from './proposal.js'

describe('AIDE² Recursive Self-Improvement Suite', () => {
  let dir: string
  let db: ReturnType<typeof createDatabase>
  let bus: Bus

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mira-aide2-test-'))
    process.env.MIRA_NO_AUTOPROVISION = '1'
    db = createDatabase(join(dir, 'aide2.db'))
    await migrate(db as unknown as Parameters<typeof migrate>[0])
    bus = new Bus()
  })

  afterEach(() => {
    try {
      db.sqlite?.close?.()
    } catch {}
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })

  test('anti-reward-hacking gate detects assertion weakening, gate bypasses, and train/held-out divergence', () => {
    const assertionRemoval = [
      '--- a/foo.test.ts',
      '+++ b/foo.test.ts',
      '- expect(res.ok).toBe(true)',
      '+ test.skip("disabled", () => {})',
    ].join('\n')
    const res1 = detectRewardHacking(assertionRemoval)
    expect(res1.blocked).toBe(true)
    expect(res1.rewardHackingScore).toBeGreaterThanOrEqual(0.4)
    expect(res1.findings.some((f) => f.category === 'assertion_weakening')).toBe(true)

    const gateBypass = '+ function requiresApproval() { return false }'
    const res2 = detectRewardHacking(gateBypass)
    expect(res2.blocked).toBe(true)
    expect(res2.findings.some((f) => f.category === 'gate_bypass')).toBe(true)

    // Divergent train vs held-out generalization (overfitting/gaming)
    const genReport = evaluateGeneralization({
      proposalId: 'prop_div',
      patch: '+ export function helper() { return 42 }',
      trainScore: 0.98,
      observedHeldOut: {
        coding_repair: 0.55,
        algorithmic_efficiency: 0.52,
        reasoning_robustness: 0.58,
        ood_shift: 0.5,
      },
    })
    expect(genReport.passed).toBe(false)
    expect(genReport.rewardHackingBlocked).toBe(true)
    expect(genReport.hackingFindings.some((f) => f.category === 'divergence_gaming')).toBe(true)
  })

  test('verifier fails closed on reward-hacking candidate patches', async () => {
    const p = propose(diagnose({ failure: 'socket failure', evidence: {}, sessionID: 's1', timestamp: Date.now() }))
    const hackingPatch = '--- a/x.ts\n+++ b/x.ts\n- protect(socket)\n+ // bypass\n'
    const exp = createExperiment(p, hackingPatch, { targetFile: 'packages/server/src/x.ts', appliable: true })
    const res = await verify(exp)
    expect(res.verified).toBe(false)
    expect(res.security.passed).toBe(false)
    expect(res.security.issues.some((i) => i.includes('reward-hacking blocked'))).toBe(true)
    expect(res.generalization).toBeDefined()
  })

  test('bounded loop context compacts long ancestor histories strictly within token budget', () => {
    const mgr = new BoundedLoopContextManager({ budgetTokens: 180, maxRecentFull: 2 })
    const ancestors = Array.from({ length: 12 }, (_, idx) => ({
      id: `gen_${idx}`,
      depth: idx,
      strategyArm: idx % 2 === 0 ? 'routing_heuristic' : 'memory_compaction',
      status: idx === 4 ? 'rejected' : 'promoted',
      summary: `Iteration ${idx} detailed hypothesis optimizing memory and latency across subsystems with extended trace notes `.repeat(2),
      heldOutScore: 0.7 + idx * 0.015,
      rewardHackingScore: idx === 4 ? 0.65 : 0.05,
    }))
    const compacted = mgr.compact(ancestors, { deadEndSignatures: ['dead_end_sig_1', 'dead_end_sig_2'] })
    expect(compacted.usedTokens).toBeLessThanOrEqual(180)
    expect(compacted.utilizationPct).toBeLessThanOrEqual(100)
    expect(compacted.retainedCount).toBe(2)
    expect(compacted.prunedDeadEnds).toBe(2)
    expect(compacted.compactedDigest).toContain('Avoid dead-ends')
  })

  test('lineage store seeds gen_0 base and requires explicit human promotion to advance base', () => {
    const store = new EvolutionLineageStore(db, bus)
    const base0 = store.getActiveBase()
    expect(base0.id).toBe('gen_0')
    expect(base0.depth).toBe(0)
    expect(base0.isActiveBase).toBe(true)

    const cand = store.createCandidate({
      strategyArm: 'memory_compaction',
      title: 'Gen 1 compaction gain',
      targetFile: 'packages/server/src/memory/memory_controller.ts',
      patch: '+ export const maxEntries = 128',
      summary: 'Bounding working memory entries improved held-out pass rate',
      trainScore: 0.85,
      heldOutScore: 0.83,
      generalizationGap: 0.02,
      rewardHackingScore: 0,
    })
    expect(cand.depth).toBe(1)
    expect(cand.parentId).toBe('gen_0')
    expect(cand.isActiveBase).toBe(false)

    // Cannot promote directly before submitForApproval
    const earlyPromote = store.promoteGeneration(cand.id, { approver: 'alice' })
    expect(earlyPromote.ok).toBe(false)

    const submitted = store.submitForApproval(cand.id)
    expect(submitted.ok).toBe(true)
    expect(submitted.node?.status).toBe('promoted_pending_approval')

    // Wrong hash fails closed
    const badHash = store.promoteGeneration(cand.id, { approver: 'alice', expectedHash: 'deadbeef' })
    expect(badHash.ok).toBe(false)

    // Human promotion advances active baseline to gen 1
    const promoted = store.promoteGeneration(cand.id, {
      approver: 'alice',
      expectedHash: cand.patchHash,
    })
    expect(promoted.ok).toBe(true)
    expect(promoted.previousBaseId).toBe('gen_0')
    expect(store.getActiveBase().id).toBe(cand.id)
    expect(store.get('gen_0')?.isActiveBase).toBe(false)

    // Subsequent candidate branches from gen 1 -> depth 2
    const cand2 = store.createCandidate({
      strategyArm: 'routing_heuristic',
      title: 'Gen 2 routing step',
      patch: '+ export const fallbackMs = 1500',
      summary: 'Builds recursively on promoted gen 1',
      trainScore: 0.89,
      heldOutScore: 0.87,
      generalizationGap: 0.02,
      rewardHackingScore: 0,
    })
    expect(cand2.parentId).toBe(cand.id)
    expect(cand2.depth).toBe(2)
  })

  test('UCB1 bandit search selects unexplored arms first and penalizes hacking arms', () => {
    const store = new EvolutionLineageStore(db, bus)
    const bandit = new BanditSearchEngine({ db, lineage: store, bus })

    expect(computeUcb1Score({ pulls: 0, meanReward: 0 }, 10)).toBe(9.99)

    const step1 = bandit.runSearchStep({
      candidates: [
        {
          strategyArm: 'routing_heuristic',
          title: 'Clean routing improvement',
          patch: '+ export function routeLane() { return true }',
          trainScore: 0.86,
          observedHeldOut: {
            coding_repair: 0.84,
            algorithmic_efficiency: 0.85,
            reasoning_robustness: 0.82,
            ood_shift: 0.84,
          },
          staticPassed: true,
          securityPassed: true,
        },
        {
          strategyArm: 'tool_selection',
          title: 'Hacked candidate weakening tests',
          patch: '- expect(a).toBe(1)\n+ expect(true).toBe(true)',
          trainScore: 0.99,
        },
      ],
    })

    expect(step1.candidates.length).toBe(2)
    expect(step1.bestCandidateId).toBeDefined()
    const cleanOutcome = step1.candidates.find((c) => c.node.strategyArm === 'routing_heuristic')!
    const hackedOutcome = step1.candidates.find((c) => c.node.strategyArm === 'tool_selection')!

    expect(cleanOutcome.node.status).toBe('promoted_pending_approval')
    expect(hackedOutcome.node.status).toBe('rejected')
    expect(hackedOutcome.report.rewardHackingBlocked).toBe(true)

    const toolArm = bandit.getArm('tool_selection')!
    expect(toolArm.hackingBlockedCount).toBe(1)
    expect(toolArm.meanReward).toBeLessThan(bandit.getArm('routing_heuristic')!.meanReward)
  })

  test('HTTP endpoints enforce auth + human approval gate across multi-generation promotion', async () => {
    const app = new Hono<{ Variables: { requestId: string } }>()
    mountEvolutionRoutes(app, {
      db,
      bus,
      resolveOwner: (tok) => (tok === 'admin-tok' ? 'alice' : tok === 'view-tok' ? 'bob' : undefined),
      resolveRole: (tok) => (tok === 'admin-tok' ? 'admin' : 'viewer'),
    })

    // 1. Initial lineage returns gen_0 + 5 arms
    const res1 = await app.request('/evolution/lineage')
    expect(res1.status).toBe(200)
    const j1 = (await res1.json()) as {
      ok: boolean
      activeBase: { id: string; depth: number }
      banditArms: unknown[]
    }
    expect(j1.ok).toBe(true)
    expect(j1.activeBase.id).toBe('gen_0')
    expect(j1.banditArms.length).toBe(5)

    // 2. Run search step
    const resStep = await app.request('/evolution/search/step', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ k: 3 }),
    })
    expect(resStep.status).toBe(200)
    const jStep = (await resStep.json()) as {
      ok: boolean
      stepResult: { bestCandidateId: string | null }
      activeBase: { id: string }
    }
    expect(jStep.ok).toBe(true)
    expect(jStep.stepResult.bestCandidateId).toBeTruthy()
    // Active base MUST NOT auto-advance without human promotion
    expect(jStep.activeBase.id).toBe('gen_0')

    const bestId = jStep.stepResult.bestCandidateId!

    // 3. Unauthenticated caller is rejected 401; viewer caller is rejected 403
    const unauth = await app.request(`/evolution/generations/${bestId}/promote`, { method: 'POST' })
    expect(unauth.status).toBe(401)

    const viewer = await app.request(`/evolution/generations/${bestId}/promote`, {
      method: 'POST',
      headers: { Authorization: 'Bearer view-tok' },
    })
    expect(viewer.status).toBe(403)

    // 4. Operator/admin approves & promotes gen_1 to activeBase
    const promo = await app.request(`/evolution/generations/${bestId}/promote`, {
      method: 'POST',
      headers: { Authorization: 'Bearer admin-tok' },
    })
    expect(promo.status).toBe(200)
    const jPromo = (await promo.json()) as {
      ok: boolean
      activeBase: { id: string; depth: number; approvedBy: string }
    }
    expect(jPromo.ok).toBe(true)
    expect(jPromo.activeBase.id).toBe(bestId)
    expect(jPromo.activeBase.depth).toBe(1)
    expect(jPromo.activeBase.approvedBy).toBe('alice')
  })
})
