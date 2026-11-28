import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDatabase, migrate, type MiraDB } from '../storage/db.js'
import { Bus } from '../bus/index.js'
import type { BusEvent } from '../types/index.js'
import { MetricsCollector } from '../metrics.js'
import { EngineRegistry } from '../engines/registry.js'
import { ToolEngine } from '../engines/tool.js'
import { MemoryEngine } from '../engines/memory.js'
import { CanaryManager } from '../canary/canary.js'
import { ImprovementLedger } from './ledger.js'
import { RollbackManager as EvolutionRollbackManager } from './rollback.js'
import { GeneralizationGate, evaluateGeneralization } from './generalization.js'
import { createGovernanceGate, type GovernanceGateDeps } from '../patching/governance/index.js'
import { RollbackManager as GovernanceRollbackManager } from '../patching/governance/rollback.js'
import type { Patch } from '../patching/patcher.js'
import type { VerifyResult } from '../patching/verifier.js'
import { EVOLUTION_SNAPSHOT_SESSION } from '../patching/applier.js'
import { mountEvolutionRoutes } from '../routes/evolution.js'
import { snapshotFile, revertSnapshot } from '../storage/snapshots.js'

const CLEAN_PATCH: Patch = {
  id: 'patch_p5',
  painPointId: 'latency',
  kind: 'latency',
  targetFile: 'packages/server/src/sample.ts',
  reason: 'optimize bounded cache',
  change: 'export const cacheLimit = 64',
  verification: 'bun test',
  severity: 'medium',
  score: 0.7,
  createdAt: Date.now(),
}

const VERIFIED: VerifyResult = { verified: true, reason: 'shadow & static ok' }

const EVIDENCED_STAGES: Partial<GovernanceGateDeps> = {
  benchmark: { run: async () => ({ passed: true, reason: 'ok', before: { p95Ms: 100 } }) },
  canary: { start: async () => ({ passed: true, reason: 'ok', metrics: { p95Ms: 95, count: 5 } }) },
}

describe('Phase 5 Hardening: Generalization, Canary, Governance & Fail-Loud Rollback', () => {
  let dir: string
  let db: MiraDB
  let bus: Bus

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mira-p5-hardening-'))
    process.env.MIRA_NO_AUTOPROVISION = '1'
    db = createDatabase(join(dir, 'p5.db'))
    await migrate(db)
    bus = new Bus()
  })

  afterEach(() => {
    try {
      db.sqlite.close()
    } catch {}
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })

  test('AC 14 & AC 15: anti-leakage, execution verification requirement & epoch budget enforcement', () => {
    // 1. Overlapping train/held-out case IDs blocked as critical leakage
    const overlap = evaluateGeneralization({
      proposalId: 'prop_overlap',
      patch: '+ export const x = 1',
      trainCaseIds: ['case_a', 'shared_eval_99'],
      heldOutCaseIds: ['shared_eval_99', 'case_z'],
      verificationPassed: true,
    })
    expect(overlap.passed).toBe(false)
    expect(overlap.rewardHackingBlocked).toBe(true)
    expect(overlap.hackingFindings.some((f) => f.id === 'rh_heldout_leakage')).toBe(true)

    // 2. Patch referencing held-out case identifier blocked as leakage
    const leakInPatch = evaluateGeneralization({
      proposalId: 'prop_leak_id',
      patch: '+ if (input.id === "heldout_case_42") return 1',
      heldOutCaseIds: ['heldout_case_42'],
      verificationPassed: true,
    })
    expect(leakInPatch.passed).toBe(false)
    expect(leakInPatch.rewardHackingBlocked).toBe(true)

    // 3. verificationPassed === false fails closed even with high observed scores
    const failedVerify = evaluateGeneralization({
      proposalId: 'prop_failed_verify',
      patch: '+ export const ok = true',
      verificationPassed: false,
      observedHeldOut: {
        coding_repair: 0.95,
        algorithmic_efficiency: 0.95,
        reasoning_robustness: 0.95,
        ood_shift: 0.95,
      },
    })
    expect(failedVerify.passed).toBe(false)

    // 4. requireRealExecution blocks unexecuted candidates
    const unexecuted = evaluateGeneralization({
      proposalId: 'prop_unexec',
      patch: '+ export const ok = true',
      requireRealExecution: true,
    })
    expect(unexecuted.passed).toBe(false)

    // 5. GeneralizationGate enforces epoch exposure budget and resets on epoch rotation
    const gate = new GeneralizationGate({ maxEvaluationsPerEpoch: 2 })
    const baseInput = {
      proposalId: 'prop_epoch',
      patch: '+ export const ok = true',
      verificationPassed: true,
      lineageKey: 'line_1',
    }
    expect(gate.evaluate({ ...baseInput, epochId: 'epoch_1' }).passed).toBe(true)
    expect(gate.evaluate({ ...baseInput, epochId: 'epoch_1' }).passed).toBe(true)
    const third = gate.evaluate({ ...baseInput, epochId: 'epoch_1' })
    expect(third.passed).toBe(false)
    expect(third.epochExpired).toBe(true)
    expect(third.rewardHackingBlocked).toBe(true)
    expect(gate.evaluate({ ...baseInput, epochId: 'epoch_2' }).passed).toBe(true)
  })

  test('AC 16a: CanaryManager requires real recorded candidate samples and candidate execution', async () => {
    const registry = new EngineRegistry()
    registry.register(new ToolEngine({ count: () => 22 }))
    const ledger = new ImprovementLedger(db, bus)
    const metrics = new MetricsCollector()
    const manager = new CanaryManager({ registry, bus, ledger, metrics })

    // Zero recorded samples -> baseline seed alone must NOT pass evaluate/promote
    const c1 = manager.startCanary('tool', 5, 60_000)
    const evalZero = manager.evaluate(c1.canaryId)
    expect(evalZero.decision).toBe('rollback')
    expect(evalZero.reason).toContain('insufficient candidate traffic samples')
    await expect(manager.promote(c1.canaryId)).rejects.toThrow()

    // executesCandidate: false -> rejected even with recorded metrics
    const c2 = manager.startCanary('tool', 5, 60_000, { executesCandidate: false })
    manager.monitor.record(c2.canaryId, {
      success: 0.95,
      errors: 0,
      regression: 0.01,
      latency: 8000,
      cost: 0.1,
      timestamp: Date.now(),
    })
    const evalNoExec = manager.evaluate(c2.canaryId)
    expect(evalNoExec.decision).toBe('rollback')
    expect(evalNoExec.reason).toContain('does not execute candidate')
    manager.clear()
  })

  test('AC 16b: GovernanceGate enforces artifact hash, canary traffic floor, and verification status', async () => {
    const g = createGovernanceGate({
      db,
      bus,
      rootDir: dir,
      ...EVIDENCED_STAGES,
      approvalCheck: () => ({ ok: true }),
      promoter: { promote: async () => ({ applied: true, prUrl: 'https://example/pr/1' }) },
    })
    await g.init()

    // 1. Tampering with change after creation rejects on advance() and blocks promote()
    const tampered = await g.createProposal(CLEAN_PATCH, VERIFIED)
    db.sqlite
      .prepare('UPDATE patch_proposals SET change = ? WHERE id = ?')
      .run('export const malicious = true', tampered.id)
    const advancedTampered = await g.advance(tampered.id)
    expect(advancedTampered?.state).toBe('REJECTED')

    const tamperedAtCanary = await g.createProposal({ ...CLEAN_PATCH, id: 'p_tamper2' }, VERIFIED)
    await g.advance(tamperedAtCanary.id)
    await g.advance(tamperedAtCanary.id)
    await g.advance(tamperedAtCanary.id)
    db.sqlite
      .prepare('UPDATE patch_proposals SET change = ? WHERE id = ?')
      .run('export const swapped = true', tamperedAtCanary.id)
    expect(await g.promote(tamperedAtCanary.id)).toEqual({
      applied: false,
      reason: 'artifact_hash_mismatch',
    })

    // 2. Insufficient canary count blocks promote()
    const lowTrafficGate = createGovernanceGate({
      db,
      bus,
      rootDir: dir,
      benchmark: { run: async () => ({ passed: true, reason: 'ok', before: { p95Ms: 100 } }) },
      canary: { start: async () => ({ passed: true, reason: 'ok', metrics: { p95Ms: 95, count: 0 } }) },
      approvalCheck: () => ({ ok: true }),
      promoter: { promote: async () => ({ applied: true, prUrl: 'https://example/pr/2' }) },
    })
    const lowTraffic = await lowTrafficGate.createProposal({ ...CLEAN_PATCH, id: 'p_low' }, VERIFIED)
    await lowTrafficGate.advance(lowTraffic.id)
    await lowTrafficGate.advance(lowTraffic.id)
    await lowTrafficGate.advance(lowTraffic.id)
    expect(await lowTrafficGate.promote(lowTraffic.id)).toEqual({
      applied: false,
      reason: 'canary_insufficient_traffic',
    })

    // 3. Unverified candidate blocked at canary->CANDIDATE promotion
    const badVerify = await g.createProposal(
      { ...CLEAN_PATCH, id: 'p_badver' },
      { verified: false, reason: 'failed tests' },
    )
    await g.advance(badVerify.id)
    await g.advance(badVerify.id)
    const afterCanaryBad = await g.advance(badVerify.id)
    expect(afterCanaryBad?.state).toBe('REJECTED')
  })

  test('AC 17: post-promotion regression triggers automatic rollback in CanaryManager & GovernanceGate', async () => {
    // 1. CanaryManager reactive post-promotion rollback
    const registry = new EngineRegistry()
    registry.register(new MemoryEngine())
    const ledger = new ImprovementLedger(db, bus)
    const metrics = new MetricsCollector()
    const rollbackEvents: BusEvent[] = []
    bus.subscribe('canary.rollback' as never, (e) => rollbackEvents.push(e as BusEvent))

    const manager = new CanaryManager({ registry, bus, ledger, metrics })
    const started = manager.startCanary('memory', 10, 60_000)
    manager.monitor.record(started.canaryId, {
      success: 0.92,
      errors: 0,
      regression: 0.02,
      latency: 8000,
      cost: 0.14,
      timestamp: Date.now(),
    })
    await manager.promote(started.canaryId)
    expect(manager.get(started.canaryId)?.status).toBe('promoted')

    // Post-promotion regression triggers automatic rollback
    manager.monitor.record(started.canaryId, {
      success: 0.7,
      errors: 12,
      regression: 0.25,
      latency: 25000,
      cost: 0.45,
      timestamp: Date.now(),
    })
    await Bun.sleep(50)
    expect(manager.get(started.canaryId)?.status).toBe('rolledback')
    expect(ledger.get(started.canaryId)?.verdict).toBe('rolledback')
    expect(rollbackEvents.length).toBeGreaterThanOrEqual(1)
    manager.clear()

    // 2. GovernanceGate post-promotion monitor hook
    const g = createGovernanceGate({
      db,
      bus,
      rootDir: dir,
      ...EVIDENCED_STAGES,
      approvalCheck: () => ({ ok: true }),
      promoter: { promote: async () => ({ applied: true, prUrl: 'https://example/pr/3' }) },
    })
    const prop = await g.createProposal({ ...CLEAN_PATCH, id: 'p_post' }, VERIFIED)
    await g.advance(prop.id)
    await g.advance(prop.id)
    await g.advance(prop.id)
    const promoRes = await g.promote(prop.id)
    expect(promoRes.applied).toBe(true)

    const monitorRes = await g.monitorPostPromotion(
      prop.id,
      { p95Ms: { value: 100, unit: 'ms' } },
      { p95Ms: { value: 220, unit: 'ms' } },
    )
    expect(monitorRes.rolledBack).toBe(true)
    expect((await g.get(prop.id))?.state).toBe('ROLLED_BACK')
  })

  test('AC 18: missing/traversal rollback artifacts fail loudly, escalate, and return HTTP 500', async () => {
    const ledger = new ImprovementLedger(db, bus)
    const escalatedEvents: BusEvent[] = []
    bus.subscribe('evolution.loop_escalated' as never, (e) => escalatedEvents.push(e as BusEvent))

    const rbMgr = new EvolutionRollbackManager({ db, bus, ledger, workspaceRoot: dir })

    // Seed marker session & snapshot then delete snapshot row so rollback point references missing artifact
    db.sqlite
      .prepare(
        'INSERT OR IGNORE INTO sessions (id, title, model, provider, created_at, updated_at, cwd) VALUES (?,?,?,?,?,?,?)',
      )
      .run(EVOLUTION_SNAPSHOT_SESSION, 'evo', 'm', 'p', Date.now(), Date.now(), dir)
    const targetFile = join(dir, 'mod.ts')
    writeFileSync(targetFile, 'orig', 'utf-8')
    db.sqlite
      .prepare(
        'INSERT INTO file_snapshots (id, session_id, message_id, path, content, created_at) VALUES (?,?,?,?,?,?)',
      )
      .run('snap_missing_1', EVOLUTION_SNAPSHOT_SESSION, 'patch_miss', targetFile, 'orig', Date.now())

    ledger.remember({
      id: 'prop_miss',
      proposal: {
        id: 'prop_miss',
        title: 'missing snap test',
        type: 'fix',
        risk: 'low',
        priority: 'P1',
        affectedEngine: 'tool',
        evidence: null,
        expectedImpact: '',
        cause: '',
        confidence: 0.8,
        createdAt: Date.now(),
      } as never,
      verdict: 'verified' as never,
      evidence: null,
    })

    const point = rbMgr.createRollbackPoint('prop_miss', ['patch_miss'])
    expect(point.snapshotIds).toEqual(['snap_missing_1'])
    // Delete artifact before rollback executes
    db.sqlite.prepare('DELETE FROM file_snapshots WHERE id = ?').run('snap_missing_1')

    const app = new Hono<{ Variables: { requestId: string } }>()
    mountEvolutionRoutes(app, {
      db,
      bus,
      ledger,
      rollbackManager: rbMgr,
      resolveOwner: (t) => (t === 'op' ? 'alice' : undefined),
      resolveRole: () => 'operator',
    })

    const res = await app.request('/evolution/rollback/prop_miss', {
      method: 'POST',
      headers: { authorization: 'Bearer op' },
    })
    expect(res.status).toBe(500)
    const body = (await res.json()) as {
      ok: boolean
      rolledBack: boolean
      escalated: boolean
      failedFiles: Array<{ path: string; error: string }>
    }
    expect(body.ok).toBe(false)
    expect(body.rolledBack).toBe(false)
    expect(body.escalated).toBe(true)
    expect(body.failedFiles.length).toBe(1)
    expect(escalatedEvents.length).toBeGreaterThanOrEqual(1)

    // Traversal snapshot path fails loudly
    db.sqlite
      .prepare(
        'INSERT INTO file_snapshots (id, session_id, message_id, path, content, created_at) VALUES (?,?,?,?,?,?)',
      )
      .run(
        'snap_trav',
        EVOLUTION_SNAPSHOT_SESSION,
        'patch_trav',
        join(dir, '..', '..', 'outside.txt'),
        'bad',
        Date.now(),
      )
    rbMgr.createRollbackPoint('prop_trav', ['patch_trav'])
    const travRes = await rbMgr.rollback('prop_trav')
    expect(travRes.success).toBe(false)
    expect(travRes.escalated).toBe(true)

    // Governance rollback executor failure throws loudly & emits governance.rollback_failed
    const govEvents: BusEvent[] = []
    bus.subscribe('learning.updated', (e) => govEvents.push(e as BusEvent))
    const govRb = new GovernanceRollbackManager({
      bus,
      executor: async () => ({ ok: false, error: 'git revert conflict' }),
    })
    await expect(govRb.rollback('prop_gov_fail', 'regression')).rejects.toThrow('git revert conflict')
    expect(
      govEvents.some(
        (e) =>
          (e.payload as { kind?: string; escalated?: boolean }).kind === 'governance.rollback_failed' &&
          (e.payload as { escalated?: boolean }).escalated === true,
      ),
    ).toBe(true)

    // Snapshot revert propagates disk write failure instead of swallowing
    const ws = join(dir, 'ws')
    mkdirSync(ws, { recursive: true })
    const sessId = 'sess_snap_err'
    db.sqlite
      .prepare(
        'INSERT INTO sessions (id, title, model, provider, created_at, updated_at, cwd) VALUES (?,?,?,?,?,?,?)',
      )
      .run(sessId, 's', 'm', 'p', Date.now(), Date.now(), ws)
    const guardedFile = join(ws, 'readonly.ts')
    writeFileSync(guardedFile, 'v1', 'utf-8')
    const snap = snapshotFile(db, { sessionID: sessId, path: guardedFile })
    expect(snap).not.toBeNull()
    // Replace file with a directory so writeFileSync fails with EISDIR even under root
    rmSync(guardedFile, { force: true })
    mkdirSync(guardedFile, { recursive: true })
    expect(() => revertSnapshot(db, sessId, { snapshotID: snap!.id })).toThrow()
  })
})
