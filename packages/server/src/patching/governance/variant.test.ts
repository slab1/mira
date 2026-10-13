/**
 * §3 — the candidate variant must be REAL.
 *
 * The measurement pipeline (traffic routing, attribution, benchmark comparison)
 * is only meaningful once a candidate can actually be executed. Until now
 * `trafficPct` had nothing to route to, so the canary observed zero candidate
 * requests and the benchmark had no independent candidate snapshot.
 *
 * The property that matters most here is negative: materializing a candidate
 * must never modify the repository working tree, and a patch that will not
 * apply must produce NO variant rather than a candidate that silently differs
 * from what would ship.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VariantWorkspace } from './variant.js'
import { CanaryRunner } from './canary.js'
import { VariantRouter } from './traffic.js'
import { LatencyTracker } from '../latency.js'
import type { Patch } from '../patcher.js'

let scratch: string
let repo: string

/** A tiny source tree standing in for the repository. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mira-variant-repo-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'mod.ts'), 'export const value = 1\n', 'utf-8')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'candidate-repo' }), 'utf-8')
  return dir
}

const PATCH: Patch = {
  id: 'patch_variant',
  painPointId: 'correctness',
  kind: 'fix',
  targetFile: 'src/mod.ts',
  reason: 'wrong constant',
  change: 'export const value = 2',
  verification: 'bun test',
  severity: 'minor',
  score: 1,
  createdAt: Date.now(),
} as unknown as Patch

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'mira-variant-scratch-'))
  repo = makeRepo()
})
afterEach(() => {
  for (const d of [scratch, repo]) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

describe('§3: a candidate variant is a real, patched, disposable tree', () => {
  test('the patch lands in the candidate and NOT in the repository', async () => {
    const ws = new VariantWorkspace({ rootDir: repo, scratchRoot: scratch })
    const { candidate, reason } = await ws.materialize('prop_1', PATCH)

    expect(candidate, reason).not.toBeNull()
    // the candidate contains the patch
    expect(readFileSync(join(candidate!.dir, 'src', 'mod.ts'), 'utf-8')).toContain('value = 2')
    // the real repository is untouched
    expect(readFileSync(join(repo, 'src', 'mod.ts'), 'utf-8')).toContain('value = 1')
  })

  test('each materialization is its own directory', async () => {
    const ws = new VariantWorkspace({ rootDir: repo, scratchRoot: scratch })
    const a = await ws.materialize('prop_a', PATCH)
    const b = await ws.materialize('prop_b', PATCH)
    expect(a.candidate!.dir).not.toBe(b.candidate!.dir)
    expect(ws.list().length).toBe(2)
  })

  test('disposing removes the tree and the real repo survives', async () => {
    const ws = new VariantWorkspace({ rootDir: repo, scratchRoot: scratch })
    const { candidate } = await ws.materialize('prop_1', PATCH)
    expect(existsSync(candidate!.dir)).toBe(true)
    expect(ws.dispose('prop_1')).toBe(true)
    expect(existsSync(candidate!.dir)).toBe(false)
    expect(existsSync(join(repo, 'src', 'mod.ts'))).toBe(true)
    // disposing twice is safe
    expect(ws.dispose('prop_1')).toBe(false)
  })

  test('disposeAll clears every live candidate', async () => {
    const ws = new VariantWorkspace({ rootDir: repo, scratchRoot: scratch })
    await ws.materialize('a', PATCH)
    await ws.materialize('b', PATCH)
    ws.disposeAll()
    expect(ws.list()).toHaveLength(0)
  })
})

describe('§3: a candidate that is not real is never produced', () => {
  test('a patch targeting a missing file yields NO variant', async () => {
    const ws = new VariantWorkspace({ rootDir: repo, scratchRoot: scratch })
    const { candidate, reason } = await ws.materialize('prop_x', {
      ...PATCH,
      targetFile: 'src/does-not-exist.ts',
    })
    expect(candidate).toBeNull()
    expect(reason).toContain('did not apply')
    expect(ws.list()).toHaveLength(0)
  })

  test('a patch with no targetFile yields NO variant', async () => {
    const ws = new VariantWorkspace({ rootDir: repo, scratchRoot: scratch })
    const { candidate, reason } = await ws.materialize('prop_x', { ...PATCH, targetFile: null })
    expect(candidate).toBeNull()
    expect(reason).toContain('no targetFile')
  })

  test('an unverified patch yields NO variant', async () => {
    const ws = new VariantWorkspace({ rootDir: repo, scratchRoot: scratch })
    const { candidate } = await ws.materialize('prop_x', PATCH, {
      verified: false,
      reason: 'shadow run failed',
    })
    expect(candidate).toBeNull()
  })

  test('a missing rootDir yields NO variant rather than throwing', async () => {
    const ws = new VariantWorkspace({ rootDir: join(repo, 'nope'), scratchRoot: scratch })
    const { candidate, reason } = await ws.materialize('prop_x', PATCH)
    expect(candidate).toBeNull()
    expect(reason).toContain('does not exist')
  })
})

describe('§3: a materialized candidate becomes real, routed traffic', () => {
  test('the router only sends traffic to the candidate once one exists', async () => {
    const router = new VariantRouter()
    const ws = new VariantWorkspace({ rootDir: repo, scratchRoot: scratch })
    const canary = new CanaryRunner(new LatencyTracker(), { router, workspace: ws })

    // before prepare(): no variant, so everything stays on baseline
    router.register({ proposalId: 'prop_1', trafficPct: 100, resolveVariant: () => null })
    expect(router.resolve({ proposalId: 'prop_1', key: 'k' }).lane).toBe('baseline')

    // prepare() materializes it and registers a working resolver
    const ok = await canary.prepare('prop_1', PATCH, { trafficPct: 100 })
    expect(ok).toBe(true)
    router.register({
      proposalId: 'prop_1',
      trafficPct: 100,
      resolveVariant: () => (ws.get('prop_1') ? 'variant' : null),
    })

    expect(router.resolve({ proposalId: 'prop_1', key: 'k' }).lane).toBe('candidate')
  })

  test('teardown stops routing and removes the tree', async () => {
    const router = new VariantRouter()
    const ws = new VariantWorkspace({ rootDir: repo, scratchRoot: scratch })
    const canary = new CanaryRunner(new LatencyTracker(), { router, workspace: ws })

    expect(await canary.prepare('prop_1', PATCH, { trafficPct: 100 })).toBe(true)
    const dir = ws.get('prop_1')!.dir
    expect(existsSync(dir)).toBe(true)

    await canary.teardown('prop_1')
    expect(existsSync(dir)).toBe(false)
    expect(router.get('prop_1')).toBeUndefined()
    expect(router.resolve({ proposalId: 'prop_1', key: 'k' }).lane).toBe('baseline')
  })

  test('prepare() reports false when the patch will not apply, so no traffic is routed', async () => {
    const router = new VariantRouter()
    const ws = new VariantWorkspace({ rootDir: repo, scratchRoot: scratch })
    const canary = new CanaryRunner(new LatencyTracker(), { router, workspace: ws })

    const ok = await canary.prepare(
      'prop_bad',
      { ...PATCH, targetFile: 'src/missing.ts' },
      { trafficPct: 100 },
    )
    expect(ok).toBe(false)
    expect(ws.list()).toHaveLength(0)
    expect(router.get('prop_bad')).toBeUndefined()
  })

  test('without a workspace, prepare() is false and nothing is registered', async () => {
    const router = new VariantRouter()
    const canary = new CanaryRunner(new LatencyTracker(), { router })
    expect(await canary.prepare('prop_1', PATCH, { trafficPct: 100 })).toBe(false)
    expect(router.get('prop_1')).toBeUndefined()
  })
})
