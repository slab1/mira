/**
 * §3 — the candidate arm must operate on the candidate tree, and never on
 * production.
 *
 * A variant that exists but is not actually used changes nothing: the canary
 * would route a percentage of traffic, attribute samples to the proposal, and
 * every one of those requests would still read and write the production tree.
 *
 * The security property matters most: a candidate is untrusted, patched code.
 * Its tool calls must be confined to its own disposable directory.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { VariantScope } from './variant-scope.js'
import { VariantRouter } from './traffic.js'
import { canaryAttribution } from './attribution.js'
import { LatencyTracker } from '../latency.js'

let prod: string
let cand: string

beforeEach(() => {
  prod = mkdtempSync(join(tmpdir(), 'mira-prod-'))
  cand = mkdtempSync(join(tmpdir(), 'mira-cand-'))
  writeFileSync(join(prod, 'file.ts'), 'production\n', 'utf-8')
  writeFileSync(join(cand, 'file.ts'), 'patched\n', 'utf-8')
})
afterEach(() => {
  for (const d of [prod, cand]) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

describe('variant scope: arm selection', () => {
  test('an unbound key operates on production', () => {
    const s = new VariantScope({ productionRoot: prod })
    expect(s.rootFor('k')).toBe(prod)
    expect(s.isCandidate('k')).toBe(false)
    expect(s.variantFor('k')).toBeUndefined()
  })

  test('a bound key operates on the candidate tree', () => {
    const s = new VariantScope({ productionRoot: prod })
    s.attach('k', cand)
    expect(s.rootFor('k')).toBe(cand)
    expect(s.isCandidate('k')).toBe(true)
  })

  test('detaching returns the key to production', () => {
    const s = new VariantScope({ productionRoot: prod })
    s.attach('k', cand)
    s.detach('k')
    expect(s.rootFor('k')).toBe(prod)
  })

  test('detachRoot unbinds every key pointing at a disposed variant', () => {
    const s = new VariantScope({ productionRoot: prod })
    s.attach('a', cand)
    s.attach('b', cand)
    s.detachRoot(cand)
    expect(s.rootFor('a')).toBe(prod)
    expect(s.rootFor('b')).toBe(prod)
  })
})

describe('variant scope: a candidate cannot reach production', () => {
  test('relative paths resolve inside the candidate tree', () => {
    const s = new VariantScope({ productionRoot: prod })
    s.attach('k', cand)
    expect(s.resolvePath('k', 'src/a.ts')).toBe(join(cand, 'src', 'a.ts'))
    expect(s.resolvePath('k', './b.ts')).toBe(join(cand, 'b.ts'))
  })

  test('a traversal out of the candidate tree is refused', () => {
    const s = new VariantScope({ productionRoot: prod })
    s.attach('k', cand)
    for (const escape of ['../escape.ts', '../../etc/passwd', 'a/../../outside.ts']) {
      expect(s.resolvePath('k', escape), escape).toBeNull()
    }
  })

  test('an absolute path outside the candidate tree is refused', () => {
    const s = new VariantScope({ productionRoot: prod })
    s.attach('k', cand)
    expect(s.resolvePath('k', join(prod, 'file.ts'))).toBeNull()
    expect(s.resolvePath('k', '/etc/passwd')).toBeNull()
  })

  test('an absolute path INSIDE the candidate tree is accepted', () => {
    const s = new VariantScope({ productionRoot: prod })
    s.attach('k', cand)
    expect(s.resolvePath('k', join(cand, 'file.ts'))).toBe(join(cand, 'file.ts'))
  })

  test('the baseline arm may still write to production', () => {
    const s = new VariantScope({ productionRoot: prod })
    expect(s.resolvePath('other', 'file.ts')).toBe(join(prod, 'file.ts'))
  })
})

describe('variant scope: path policy', () => {
  test('the candidate root is allowed so file operations are not denied', () => {
    const s = new VariantScope({ productionRoot: prod })
    s.attach('k', cand)
    const roots = s.allowedRoots('k', [prod])
    expect(roots).toContain(cand)
  })

  test('production is REMOVED from the candidate arm allowed roots', () => {
    const s = new VariantScope({ productionRoot: prod })
    s.attach('k', cand)
    // A candidate that could write to production is exactly the failure mode.
    expect(s.allowedRoots('k', [prod])).not.toContain(prod)
  })

  test('the baseline arm keeps its original roots untouched', () => {
    const s = new VariantScope({ productionRoot: prod })
    expect(s.allowedRoots('k', [prod])).toEqual([prod])
  })
})

describe('attribution middleware binds the candidate arm', () => {
  test('a candidate-arm request is redirected and a baseline-arm one is not', async () => {
    const router = new VariantRouter()
    router.register({ proposalId: 'p1', trafficPct: 100, resolveVariant: () => cand })
    const scope = new VariantScope({ productionRoot: prod })
    const tracker = new LatencyTracker()

    const seen: string[] = []
    const app = new Hono()
    app.use(
      '*',
      canaryAttribution({ proposalId: 'p1', router, scope, tracker, keyOf: () => 'sess-1' }),
    )
    app.all('/x', (c) => {
      seen.push(c.get('miraVariantRoot' as never) as string)
      return c.json({})
    })

    await app.request('/x')
    // trafficPct 100 → this request went to the candidate
    expect(seen[0]).toBe(cand)
    // and its samples were attributed to the proposal
    expect(tracker.stats(60_000, 'p1').count).toBe(1)
    expect(tracker.stats(60_000, 'baseline').count).toBe(0)
  })

  test('0% traffic keeps the request on the production root', async () => {
    const router = new VariantRouter()
    router.register({ proposalId: 'p1', trafficPct: 0.001, resolveVariant: () => cand })
    const scope = new VariantScope({ productionRoot: prod })

    const seen: string[] = []
    const app = new Hono()
    app.use(
      '*',
      canaryAttribution({
        proposalId: 'p1',
        router,
        scope,
        tracker: new LatencyTracker(),
        keyOf: () => 'sess-1',
      }),
    )
    app.all('/x', (c) => {
      seen.push(c.get('miraVariantRoot' as never) as string)
      return c.json({})
    })

    await app.request('/x')
    expect(seen[0]).toBe(prod)
  })

  test('no registered variant → production root, no traffic diverted', async () => {
    const router = new VariantRouter()
    router.register({ proposalId: 'p1', trafficPct: 100, resolveVariant: () => null })
    const scope = new VariantScope({ productionRoot: prod })

    const seen: string[] = []
    const app = new Hono()
    app.use(
      '*',
      canaryAttribution({
        proposalId: 'p1',
        router,
        scope,
        tracker: new LatencyTracker(),
        keyOf: () => 'sess-1',
      }),
    )
    app.all('/x', (c) => {
      seen.push(c.get('miraVariantRoot' as never) as string)
      return c.json({})
    })

    await app.request('/x')
    expect(seen[0]).toBe(prod)
  })

  test('with no targets registered the middleware is a no-op', async () => {
    const scope = new VariantScope({ productionRoot: prod })
    const app = new Hono()
    app.use(
      '*',
      canaryAttribution({
        proposalId: 'p1',
        router: new VariantRouter(),
        scope,
        tracker: new LatencyTracker(),
      }),
    )
    app.all('/x', (c) => c.json({ ok: true }))

    const res = await app.request('/x')
    expect(res.status).toBe(200)
    expect(existsSync(join(cand, 'file.ts'))).toBe(true)
  })
})

describe('end to end: candidate work stays in the candidate tree', () => {
  test('a candidate-arm write lands in the worktree and production is untouched', async () => {
    const scope = new VariantScope({ productionRoot: prod })
    scope.attach('p1:sess-1', cand)

    const target = scope.resolvePath('p1:sess-1', 'new-file.ts')
    expect(target).not.toBeNull()
    writeFileSync(target!, 'written by candidate\n', 'utf-8')

    expect(existsSync(join(cand, 'new-file.ts'))).toBe(true)
    expect(existsSync(join(prod, 'new-file.ts'))).toBe(false)
    expect(readFileSync(join(prod, 'file.ts'), 'utf-8')).toBe('production\n')
    expect(readFileSync(join(cand, 'file.ts'), 'utf-8')).toBe('patched\n')
  })
})
