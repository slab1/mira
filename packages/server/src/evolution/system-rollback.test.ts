/**
 * System Rollback (§6) — system-state snapshots, diffs, and per-candidate
 * rollback metadata (Candidate/Parent Version, Changed Components, Deps,
 * Configuration, Rollback Metadata).
 */
import { describe, test, expect } from 'bun:test'
import {
  SystemRollbackManager,
  diffSnapshots,
  type SystemStateSnapshot,
} from './system-rollback.js'

const snap = (overrides: Partial<SystemStateSnapshot> = {}): SystemStateSnapshot => ({
  components: { model: { version: '1.0.0' }, tool: { version: '0.9.0' } },
  dependencies: { hono: '4.0.0' },
  configHashes: { 'mira.json': 'abc123' },
  timestamp: Date.now(),
  ...overrides,
})

describe('diffSnapshots', () => {
  test('detects changed components, dependencies, config', () => {
    const before = snap()
    const after = snap({
      components: { model: { version: '2.0.0' }, tool: { version: '0.9.0' } },
      dependencies: { hono: '5.0.0', zod: '3.0.0' },
      configHashes: { 'mira.json': 'def456' },
    })
    const d = diffSnapshots(before, after)
    expect(d.changedComponents).toEqual(['model'])
    expect(d.changedDependencies.sort()).toEqual(['hono', 'zod'])
    expect(d.changedConfig).toEqual(['mira.json'])
  })

  test('null after → no changes', () => {
    const d = diffSnapshots(snap(), null)
    expect(d.changedComponents).toEqual([])
  })
})

describe('SystemRollbackManager — §6 metadata', () => {
  test('capture reads collectors, hashes config (content never stored)', () => {
    const m = new SystemRollbackManager({
      componentVersions: () => ({ model: '1.0.0', agent: '3.2.1' }),
      dependencyVersions: () => ({ hono: '4.0.0' }),
      configPaths: ['/definitely/does/not/exist.json'],
    })
    const s = m.capture()
    expect(s.components.model.version).toBe('1.0.0')
    expect(s.dependencies.hono).toBe('4.0.0')
    // missing config file is skipped, not an error
    expect(Object.keys(s.configHashes)).toHaveLength(0)
  })

  test('recordCandidate produces full §6 metadata with rollback steps', () => {
    const m = new SystemRollbackManager()
    const before = snap()
    const after = snap({
      components: { model: { version: '2.0.0' }, tool: { version: '0.9.0' } },
      configHashes: { 'mira.json': 'xyz789' },
    })
    const meta = m.recordCandidate('proposal_1', before, after)
    expect(meta.proposalId).toBe('proposal_1')
    expect(meta.parentVersion.model).toBe('1.0.0')
    expect(meta.candidateVersion!.model).toBe('2.0.0')
    expect(meta.changedComponents).toEqual(['model'])
    expect(meta.changedConfig).toEqual(['mira.json'])
    expect(meta.rollback.strategy).toBe('engine-rollback')
    expect(meta.rollback.steps.some((s) => s.includes('EngineRegistry.rollback'))).toBe(true)
    // retrievable
    expect(m.metadata('proposal_1')?.changedComponents).toEqual(['model'])
    expect(m.list()).toHaveLength(1)
  })

  test('no system changes → manual strategy, file-suffices step', () => {
    const m = new SystemRollbackManager()
    const before = snap()
    const meta = m.recordCandidate('proposal_2', before, null)
    expect(meta.rollback.strategy).toBe('manual')
    expect(meta.rollback.steps[0]).toContain('file snapshots suffice')
    expect(meta.candidateVersion).toBeNull()
  })

  test('entry cap prunes oldest', () => {
    const m = new SystemRollbackManager({}, { maxEntries: 2 })
    const before = snap()
    m.recordCandidate('p1', before)
    m.recordCandidate('p2', before)
    m.recordCandidate('p3', before)
    expect(m.count()).toBe(2)
    expect(m.metadata('p1')).toBeUndefined()
    expect(m.metadata('p3')).toBeDefined()
  })
})
