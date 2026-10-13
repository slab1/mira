/**
 * Multi-Agent Coordination (§12) — task ownership, TTL file locks, conflict
 * detection (lock/claim/dependency/stale-base), transactions, shared state.
 */
import { describe, test, expect } from 'bun:test'
import { CoordinationHub } from './coordination.js'

describe('CoordinationHub — task ownership (§12)', () => {
  test('one owner per task; second claimer conflicts', () => {
    const h = new CoordinationHub()
    const a = h.claimTask({ taskId: 't1', owner: 'architect' })
    expect(a.ok).toBe(true)
    const b = h.claimTask({ taskId: 't1', owner: 'developer' })
    expect(b.ok).toBe(false)
    expect(b.conflicts[0].kind).toBe('claim')
    expect(b.conflicts[0].holder).toBe('architect')
    // same owner re-claim is idempotent-ish (refresh) — allowed
    const a2 = h.claimTask({ taskId: 't1', owner: 'architect' })
    expect(a2.ok).toBe(true)
  })

  test('overlapping file claims conflict across tasks', () => {
    const h = new CoordinationHub()
    expect(h.claimTask({ taskId: 't1', owner: 'a', files: ['src/x.ts'] }).ok).toBe(true)
    const r = h.claimTask({ taskId: 't2', owner: 'b', files: ['src/x.ts', 'src/y.ts'] })
    expect(r.ok).toBe(false)
    expect(r.conflicts[0].kind).toBe('claim')
    expect(r.conflicts[0].path).toBe('src/x.ts')
  })

  test('unmet dependency conflicts; owner-only release', () => {
    const h = new CoordinationHub()
    h.claimTask({ taskId: 'plan', owner: 'architect' })
    const dev = h.claimTask({ taskId: 'build', owner: 'developer', deps: ['plan'] })
    expect(dev.ok).toBe(false)
    expect(dev.conflicts[0].kind).toBe('dependency')

    // wrong owner cannot release
    const wrong = h.releaseTask('plan', 'developer')
    expect(wrong.ok).toBe(false)
    expect(h.releaseTask('plan', 'architect').ok).toBe(true)
    // dependency now free
    expect(h.claimTask({ taskId: 'build', owner: 'developer', deps: ['plan'] }).ok).toBe(true)
  })

  test('claim implies file locks; TTL expiry releases (crashed agent recovery)', () => {
    const h = new CoordinationHub()
    const t0 = 1_000_000
    h.claimTask({ taskId: 't1', owner: 'a', files: ['f.ts'], now: t0 })
    // b cannot lock a's file
    const l = h.lockFiles('b', ['f.ts'], { now: t0 + 1000 })
    expect(l.locked).toHaveLength(0)
    expect(l.conflicts[0].kind).toBe('lock')
    // after claim TTL, sweep reaps and b succeeds
    const l2 = h.lockFiles('b', ['f.ts'], { now: t0 + 1_800_001 })
    expect(l2.locked).toEqual(['f.ts'])
    expect(l2.conflicts).toHaveLength(0)
  })
})

describe('CoordinationHub — file locking (§12)', () => {
  test('exclusive with TTL; owner-only unlock', () => {
    const h = new CoordinationHub()
    const t0 = 2_000_000
    expect(h.lockFiles('a', ['p.ts'], { now: t0 }).locked).toEqual(['p.ts'])
    expect(h.lockFiles('b', ['p.ts'], { now: t0 + 1 }).conflicts).toHaveLength(1)
    // after TTL expiry, b can acquire
    expect(h.lockFiles('b', ['p.ts'], { now: t0 + 600_001 }).locked).toEqual(['p.ts'])
  })

  test('owner unlock frees; other-owner unlock errors', () => {
    const h = new CoordinationHub()
    h.lockFiles('a', ['p.ts'])
    const wrong = h.unlockFiles('b', ['p.ts'])
    expect(wrong.errors[0]).toContain('locked by a')
    const ok = h.unlockFiles('a', ['p.ts'])
    expect(ok.unlocked).toEqual(['p.ts'])
    // now b can lock
    expect(h.lockFiles('b', ['p.ts']).locked).toEqual(['p.ts'])
  })
})

describe('CoordinationHub — version-aware patches (§12)', () => {
  test('stale base detected after another agent writes', () => {
    const h = new CoordinationHub()
    h.recordWrite('src/a.ts', 'hash-v1', 'developer')
    // reviewer patch based on hash-v1 — fine
    expect(h.patchConflicts('src/a.ts', 'hash-v1', 'reviewer').stale).toBe(false)
    // developer writes v2
    h.recordWrite('src/a.ts', 'hash-v2', 'developer')
    const r = h.patchConflicts('src/a.ts', 'hash-v1', 'reviewer')
    expect(r.stale).toBe(true)
    expect(r.conflicts[0].kind).toBe('stale-base')
    expect(r.conflicts[0].holder).toBe('developer')
    // never-written path → no conflict
    expect(h.patchConflicts('src/new.ts', 'whatever', 'x').stale).toBe(false)
  })
})

describe('CoordinationHub — transactions (§12)', () => {
  test('all-or-nothing lock acquisition, owner-only commit/abort', () => {
    const h = new CoordinationHub()
    h.lockFiles('other', ['taken.ts'])
    const tx = h.beginTransaction('a', ['free1.ts', 'taken.ts'])
    expect(tx.ok).toBe(false)
    expect(tx.conflicts[0].path).toBe('taken.ts')
    // partial lock undone: free1 is free again
    expect(h.lockFiles('b', ['free1.ts']).locked).toEqual(['free1.ts'])

    const tx2 = h.beginTransaction('a', ['x.ts', 'y.ts'])
    expect(tx2.ok).toBe(true)
    expect(h.commit(tx2.txId!, 'b').ok).toBe(false)
    expect(h.commit(tx2.txId!, 'a').ok).toBe(true)

    const tx3 = h.beginTransaction('a', ['z.ts'])
    expect(h.abort(tx3.txId!, 'a').ok).toBe(true)
    // abort released the lock
    expect(h.lockFiles('b', ['z.ts']).locked).toEqual(['z.ts'])
  })
})

describe('CoordinationHub — shared mission state (§12)', () => {
  test('status() exposes claims, locks, writes for every agent', () => {
    const h = new CoordinationHub()
    h.claimTask({ taskId: 't1', owner: 'a', files: ['f.ts'], priority: 2 })
    h.recordWrite('f.ts', 'h1', 'a')
    const s = h.status()
    expect(s.claims).toHaveLength(1)
    expect(s.claims[0].taskId).toBe('t1')
    expect(s.locks.some((l) => l.path === 'f.ts')).toBe(true)
    expect(s.lastWrites[0].hash).toBe('h1')
    expect(s.activeTransactions).toBe(0)
  })
})

describe('CoordinationHub — durable store (§12 restart survival)', () => {
  const fakeStore = () => {
    const rows = new Map<
      string,
      { kind: 'claim' | 'lock' | 'write'; payload: unknown; expiresAt: number | null }
    >()
    return {
      rows,
      load: () =>
        [...rows.entries()].map(([k, v]) => {
          const [kind, key] = k.split(':') as ['claim' | 'lock' | 'write', string]
          return { kind, key, payload: v.payload, expiresAt: v.expiresAt }
        }),
      save: (
        kind: 'claim' | 'lock' | 'write',
        key: string,
        payload: unknown,
        expiresAt?: number | null,
      ) => {
        rows.set(`${kind}:${key}`, {
          kind,
          payload: JSON.parse(JSON.stringify(payload)),
          expiresAt: expiresAt ?? null,
        })
      },
      clear: (kind: 'claim' | 'lock' | 'write', key: string) => rows.delete(`${kind}:${key}`),
    }
  }

  test('locks and claims survive a restart — two agents cannot both hold a lock', () => {
    const store = fakeStore()
    const t0 = Date.now()
    const h1 = new CoordinationHub({ store, lockTtlMs: 600_000, claimTtlMs: 1_800_000 })
    h1.claimTask({ taskId: 't1', owner: 'a', files: ['f.ts'], now: t0 })

    // "restart": brand-new hub over the same store
    const h2 = new CoordinationHub({ store, lockTtlMs: 600_000, claimTtlMs: 1_800_000 })
    // agent a still owns the task…
    const re = h2.claimTask({ taskId: 't1', owner: 'b', now: t0 + 1000 })
    expect(re.ok).toBe(false)
    expect(re.conflicts[0].holder).toBe('a')
    // …and the lock survives: b cannot lock it
    const l = h2.lockFiles('b', ['f.ts'], { now: t0 + 1000 })
    expect(l.locked).toHaveLength(0)
    expect(l.conflicts[0].kind).toBe('lock')
  })

  test('last writes survive a restart — stale-base detection continues to work', () => {
    const store = fakeStore()
    const h1 = new CoordinationHub({ store })
    h1.recordWrite('src/a.ts', 'hash-v1', 'developer')

    const h2 = new CoordinationHub({ store })
    const r = h2.patchConflicts('src/a.ts', 'hash-v0', 'reviewer')
    expect(r.stale).toBe(true)
    expect(r.conflicts[0].holder).toBe('developer')
  })

  test('expired claims/locks are dropped on load (sweep semantics)', () => {
    const store = fakeStore()
    const t0 = 6_000_000
    const h1 = new CoordinationHub({ store, lockTtlMs: 100, claimTtlMs: 100 })
    h1.claimTask({ taskId: 't1', owner: 'a', files: ['f.ts'], now: t0 })
    // restart well past the TTLs
    const h2 = new CoordinationHub({ store, lockTtlMs: 100, claimTtlMs: 100 })
    const s = h2.status(Date.now() + 1)
    expect(s.claims).toHaveLength(0)
    // the file is lockable again
    expect(h2.lockFiles('b', ['f.ts'], { now: Date.now() + 1 }).locked).toEqual(['f.ts'])
  })

  test('release/unlock clear durable rows — no resurrection', () => {
    const store = fakeStore()
    const h1 = new CoordinationHub({ store })
    h1.claimTask({ taskId: 't1', owner: 'a', files: ['f.ts'] })
    h1.releaseTask('t1', 'a')
    expect(store.rows.size).toBe(0)
    const h2 = new CoordinationHub({ store })
    expect(h2.claimTask({ taskId: 't1', owner: 'b', files: ['f.ts'] }).ok).toBe(true)
  })

  test('store failures never block hub operations (fail-soft)', () => {
    const throwing = {
      load: () => {
        throw new Error('db gone')
      },
      save: () => {
        throw new Error('db gone')
      },
      clear: () => {
        throw new Error('db gone')
      },
    }
    const h = new CoordinationHub({ store: throwing })
    expect(h.claimTask({ taskId: 't1', owner: 'a' }).ok).toBe(true)
    expect(h.lockFiles('a', ['x.ts']).locked).toEqual(['x.ts'])
    expect(h.recordWrite('x.ts', 'h', 'a').owner).toBe('a')
    expect(h.releaseTask('t1', 'a').ok).toBe(true)
  })
})
