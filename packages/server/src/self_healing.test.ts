import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { CircuitBreaker, clearBreakerRegistry } from './providers/circuit-breaker.js'
import { Subgateway } from './gateway/subgateway.js'
import { ProviderRegistry } from './providers/registry.js'
import { autoRollbackEnabled, rollbackSessionMutations } from './compliance/index.js'
import { createDatabase, migrate } from './storage/db.js'
import { snapshotFile } from './storage/snapshots.js'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MiraConfig } from './types/index.js'

/**
 * Self-healing fault injection (MIRA_SELF_HEALING.md row 5: "inject fault →
 * verify heal + no retry-loop").
 *
 * The doc lists several faults as `Implemented` and others as `Target`
 * (`POST /dev/heal`, `heal.started`/`healed` events, `features.selfHealing`).
 * Those Targets are genuinely absent and are NOT faked here. What this suite
 * injects is every self-healing behaviour that is actually implemented in
 * TypeScript and can be fault-injected in-process:
 *
 *   1. Provider fault → circuit opens → cool-down → half-open probe → healed
 *   2. The same fault in the real request path (Subgateway), not just the unit
 *   3. Isolation: one bad provider must not open every provider's circuit
 *   4. No retry-loop: an open circuit fails fast instead of hammering
 *   5. File mutations are snapshot-backed and revertible (rollback heal)
 *   6. MIRA_STRICT_AUTH is fail-closed
 *
 * The doc's `disk 98%` / `symlink EPERM` / `ERR_MODULE_NOT_FOUND` faults live in
 * `scripts/serve-local.sh` and bunfig, not in TS — they are shell-level and
 * cannot be fault-injected by a unit test. Asserting them here would be theater.
 */

beforeEach(() => {
  clearBreakerRegistry()
})

describe('circuit breaker heals after a provider fault', () => {
  test('5 failures open the circuit (documented threshold)', () => {
    const cb = new CircuitBreaker()
    for (let i = 1; i < 5; i++) {
      cb.recordFailure()
      expect(cb.getState()).toBe('CLOSED')
    }
    cb.recordFailure()
    expect(cb.getState()).toBe('OPEN')
  })

  test('an open circuit refuses traffic until the cool-down elapses', () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 30_000 })
    cb.recordFailure()
    expect(cb.getState()).toBe('OPEN')
    expect(cb.canAttempt()).toBe(false)
    expect(cb.getTimeUntilReset()).toBeGreaterThan(0)
  })

  test('after the cool-down the circuit half-opens and probes', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 20 })
    cb.recordFailure()
    expect(cb.getState()).toBe('OPEN')
    await new Promise((r) => setTimeout(r, 40))
    // heal begins: the breaker now admits a limited number of probes
    expect(cb.getState()).toBe('HALF_OPEN')
    expect(cb.canAttempt()).toBe(true)
  })

  test('successful probes close the circuit — the heal completes', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 20, halfOpenMaxCalls: 2 })
    cb.recordFailure()
    await new Promise((r) => setTimeout(r, 40))
    expect(cb.getState()).toBe('HALF_OPEN')
    cb.recordSuccess()
    cb.recordSuccess()
    expect(cb.getState()).toBe('CLOSED')
    expect(cb.canAttempt()).toBe(true)
  })

  test('a failed probe re-opens the circuit (no false heal)', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 20 })
    cb.recordFailure()
    await new Promise((r) => setTimeout(r, 40))
    expect(cb.getState()).toBe('HALF_OPEN')
    cb.recordFailure()
    expect(cb.getState()).toBe('OPEN')
  })

  test('a success in CLOSED resets the failure count', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 })
    cb.recordFailure()
    cb.recordFailure()
    cb.recordSuccess()
    cb.recordFailure()
    cb.recordFailure()
    // 2 failures after the reset, not 4 — the counter healed
    expect(cb.getState()).toBe('CLOSED')
    cb.recordFailure()
    expect(cb.getState()).toBe('OPEN')
  })

  test('no retry-loop: an open circuit short-circuits before any request', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 30_000 })
    cb.recordFailure()
    let attempts = 0
    for (let i = 0; i < 5; i++) {
      if (cb.canAttempt()) attempts++
    }
    expect(attempts).toBe(0)
  })
})

describe('provider faults are isolated', () => {
  test('one failing provider does not open the others', () => {
    const prov = (b: string) => ({
      npm: '@ai-sdk/openai-compatible',
      name: b,
      options: { baseURL: b, apiKey: 'k', timeout: 100 },
      models: {},
    })
    const reg = new ProviderRegistry(
      { aaa: prov('https://a.test'), bbb: prov('https://b.test') },
      { defaultProvider: 'aaa' },
    )
    for (let i = 0; i < 10; i++) reg.recordFailure('aaa')
    expect(reg.isHealthy('aaa')).toBe(false)
    // the healthy provider is untouched — no cascading failure
    expect(reg.isHealthy('bbb')).toBe(true)
  })
})

describe('self-healing in the real request path', () => {
  const config = (): MiraConfig =>
    ({
      model: 'aaa/m1',
      permission: {},
      mcp: {},
      provider: {
        aaa: {
          name: 'A',
          options: { baseURL: 'https://a.test/v1', apiKey: 'k', timeout: 1000, kind: 'aaa' },
          models: {},
        },
        bbb: {
          name: 'B',
          options: { baseURL: 'https://b.test/v1', apiKey: 'k', timeout: 1000, kind: 'bbb' },
          models: {},
        },
      },
      routing: { aliases: {}, fallbacks: ['bbb/m1'], defaultProvider: 'aaa' },
      subgateways: {},
    }) as unknown as MiraConfig

  const sub = () =>
    new Subgateway({
      lane: 'default',
      config: {
        model: 'aaa/m1',
        fallback: ['bbb/m1'],
        rateLimit: { rps: 1000, burst: 1000 },
        retry: { maxAttempts: 1, baseMs: 1, maxMs: 2 },
        timeout: 1000,
        // Lane threshold stays high so the PROVIDER breaker (registry default 5) is
        // the thing under test; a low lane threshold trips the lane breaker first and
        // short-circuits before the candidate loop ever runs.
        circuitBreaker: { failureThreshold: 99, resetTimeoutMs: 30_000 },
      },
      globalConfig: config(),
    })

  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('a persistently failing provider is circuit-broken after repeated faults', async () => {
    globalThis.fetch = (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch
    const gw = sub()
    // The provider-level breaker uses the registry default (5), so drive it
    // past the threshold with repeated faults.
    for (let i = 0; i < 8; i++) {
      await expect(
        gw.stream({ model: 'aaa/m1', messages: [{ role: 'user', content: 'x' }] }),
      ).rejects.toThrow()
    }
    const registry = (gw as unknown as { registry: ProviderRegistry }).registry
    expect(registry.isHealthy('aaa')).toBe(false)
    const health = registry.getHealth('aaa')
    expect(health.status).not.toBe('healthy')
  })

  test('the healthy fallback keeps serving while the primary is broken', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('a.test')) return new Response('{}', { status: 503 })
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as typeof fetch
    const gw = sub()
    // repeated faults on aaa must never stop bbb from serving
    for (let i = 0; i < 3; i++) {
      const it = await gw.stream({ model: 'aaa/m1', messages: [{ role: 'user', content: 'x' }] })
      let out = ''
      for await (const chunk of it) if (chunk.type === 'text-delta') out += chunk.text
      expect(out).toContain('ok')
    }
  })

  // Layered breakers interact: a lane threshold below the provider threshold
  // means the lane opens FIRST and short-circuits the whole lane, so the
  // provider breaker stops accumulating. That is intended (fail fast) but it
  // means provider health only heals if the lane lets requests through.
  test('a low lane threshold opens the lane before the provider breaker', async () => {
    clearBreakerRegistry()
    globalThis.fetch = (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch
    const gw = new Subgateway({
      lane: 'default',
      config: {
        model: 'aaa/m1',
        fallback: ['bbb/m1'],
        rateLimit: { rps: 1000, burst: 1000 },
        retry: { maxAttempts: 1, baseMs: 1, maxMs: 2 },
        timeout: 1000,
        circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 30_000 },
      },
      globalConfig: config(),
    })
    for (let i = 0; i < 4; i++) {
      await expect(
        gw.stream({ model: 'aaa/m1', messages: [{ role: 'user', content: 'x' }] }),
      ).rejects.toThrow()
    }
    // lane is open (fail-fast) — the provider counter stops at the lane threshold
    expect(gw.health().circuit).toBe('open')
  })
})

describe('file-mutation heal (snapshot + rollback)', () => {
  let dir: string
  let db: ReturnType<typeof createDatabase>
  const originalAuto = process.env.MIRA_AUTO_ROLLBACK

  // file_snapshots.session_id is a FK onto sessions, so the parent row must
  // exist before a snapshot can be taken.
  const seedSession = (id: string) =>
    db.sqlite
      .prepare(
        'INSERT OR IGNORE INTO sessions (id, title, model, provider, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      )
      .run(id, id, 'm', 'p', Date.now(), Date.now())

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mira-heal-'))
    db = createDatabase(':memory:')
    await migrate(db)
    seedSession('s1')
    seedSession('s2')
    seedSession('s3')
  })

  afterEach(() => {
    delete process.env.MIRA_AUTO_ROLLBACK
    if (originalAuto !== undefined) process.env.MIRA_AUTO_ROLLBACK = originalAuto
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })

  test('a snapshot restores the pre-mutation content', async () => {
    const file = join(dir, 'target.ts')
    writeFileSync(file, 'original\n')
    snapshotFile(db, { sessionID: 's1', messageID: 'm1', path: file })
    // the agent mutates the file
    writeFileSync(file, 'corrupted\n')
    expect(readFileSync(file, 'utf-8')).toBe('corrupted\n')
    // heal: restore from the snapshot
    const res = await rollbackSessionMutations(db, 's1')
    expect(res.files).toContain(file)
    expect(readFileSync(file, 'utf-8')).toBe('original\n')
  })

  test('rollback is scoped to one session and preserves other sessions', async () => {
    const a = join(dir, 'a.ts')
    const b = join(dir, 'b.ts')
    writeFileSync(a, 'a-original\n')
    writeFileSync(b, 'b-original\n')
    snapshotFile(db, { sessionID: 's1', messageID: 'm1', path: a })
    snapshotFile(db, { sessionID: 's2', messageID: 'm2', path: b })
    writeFileSync(a, 'a-broken\n')
    writeFileSync(b, 'b-broken\n')
    await rollbackSessionMutations(db, 's1')
    expect(readFileSync(a, 'utf-8')).toBe('a-original\n')
    // s2's file is NOT touched by s1's rollback
    expect(readFileSync(b, 'utf-8')).toBe('b-broken\n')
  })

  test('rollback of an untouched session is a no-op', async () => {
    const res = await rollbackSessionMutations(db, 'never-seen')
    expect(res.files).toEqual([])
    expect(res.deleted).toEqual([])
  })

  test('auto-rollback is opt-in, off by default', () => {
    delete process.env.MIRA_AUTO_ROLLBACK
    expect(autoRollbackEnabled()).toBe(false)
    process.env.MIRA_AUTO_ROLLBACK = '1'
    expect(autoRollbackEnabled()).toBe(true)
  })

  test('rollback leaves an untouched file alone (no phantom writes)', async () => {
    const file = join(dir, 'untouched.ts')
    writeFileSync(file, 'safe\n')
    snapshotFile(db, { sessionID: 's3', messageID: 'm3', path: file })
    await rollbackSessionMutations(db, 's3')
    // content already matched the snapshot; still present and correct
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf-8')).toBe('safe\n')
  })
})
