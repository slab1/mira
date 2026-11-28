/**
 * Phase 3 Acceptance Criteria 10–13 — SQLite transactional leases, monotonic
 * fencing tokens, lease renewal rejection after expiry, write-boundary fencing
 * enforcement, HTTP auth/ownership binding, and multi-process WAL contention.
 */
import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Hono } from 'hono'
import { createDatabase, migrate } from '../storage/db.js'
import {
  CoordinationHub,
  FencingTokenError,
  createSqliteCoordinationStore,
} from './coordination.js'
import { mountCoordinationRoutes } from '../routes/coordination.js'

const tempDirs: string[] = []

function makeTempDbPath(name = 'coord.db'): string {
  const dir = mkdtempSync(join(tmpdir(), 'mira-coord-'))
  tempDirs.push(dir)
  return join(dir, name)
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
})

describe('Phase 3 SQLite Transactional Leases & Fencing Tokens (AC 10-12)', () => {
  test('AC-10/11: monotonic fencing tokens across connections & stale-holder write rejection', async () => {
    const dbPath = makeTempDbPath()
    const db1 = createDatabase(dbPath)
    await migrate(db1)
    const db2 = createDatabase(dbPath)

    const hub1 = new CoordinationHub({ store: createSqliteCoordinationStore(db1) })
    const hub2 = new CoordinationHub({ store: createSqliteCoordinationStore(db2) })
    const t0 = 10_000_000

    // Agent A locks file via connection 1 -> token 1
    const lockA = hub1.lockFiles('agent-a', ['src/core.ts'], { ttlMs: 1_000, now: t0 })
    expect(lockA.locked).toEqual(['src/core.ts'])
    const token1 = lockA.tokens['src/core.ts']
    expect(token1).toBe(1)

    // Connection 2 immediately sees lock & conflicts for Agent B
    const lockBConflict = hub2.lockFiles('agent-b', ['src/core.ts'], { ttlMs: 1_000, now: t0 + 500 })
    expect(lockBConflict.locked).toHaveLength(0)
    expect(lockBConflict.conflicts[0]?.holder).toBe('agent-a')

    // Valid write by A with token 1 succeeds
    const w1 = hub1.recordFencedWrite({
      path: 'src/core.ts',
      hash: 'h1',
      owner: 'agent-a',
      fencingToken: token1,
      now: t0 + 600,
    })
    expect(w1.fencingToken).toBe(1)

    // Lease expires at t0 + 1000; BEFORE B acquires, A's stale write with token 1 is rejected!
    expect(() =>
      hub1.recordFencedWrite({
        path: 'src/core.ts',
        hash: 'h-stale-pre',
        owner: 'agent-a',
        fencingToken: token1,
        now: t0 + 1_100,
      }),
    ).toThrow(FencingTokenError)

    // Agent B recovers expired lease via connection 2 -> gets strictly higher token 2
    const lockB = hub2.lockFiles('agent-b', ['src/core.ts'], { ttlMs: 5_000, now: t0 + 1_200 })
    expect(lockB.locked).toEqual(['src/core.ts'])
    const token2 = lockB.tokens['src/core.ts']
    expect(token2).toBeGreaterThan(token1)
    expect(token2).toBe(2)

    // Stale Agent A presenting token 1 is rejected at write boundary
    expect(() =>
      hub1.recordWrite('src/core.ts', 'h-stale', 'agent-a', {
        fencingToken: token1,
        now: t0 + 1_300,
      }),
    ).toThrow(FencingTokenError)

    // Agent B succeeds with token 2
    const w2 = hub2.recordFencedWrite({
      path: 'src/core.ts',
      hash: 'h2',
      owner: 'agent-b',
      fencingToken: token2,
      now: t0 + 1_400,
    })
    expect(w2.owner).toBe('agent-b')
    expect(w2.fencingToken).toBe(2)

    // Even after B unlocks, A re-acquiring gets token 3 and old token 1 stays rejected
    expect(hub2.unlockFiles('agent-b', ['src/core.ts'], { now: t0 + 1_500 }).unlocked).toEqual([
      'src/core.ts',
    ])
    expect(() =>
      hub1.recordFencedWrite({
        path: 'src/core.ts',
        hash: 'h-after-unlock',
        owner: 'agent-a',
        fencingToken: token1,
        now: t0 + 1_600,
      }),
    ).toThrow(FencingTokenError)

    const lockA2 = hub1.lockFiles('agent-a', ['src/core.ts'], { ttlMs: 1_000, now: t0 + 1_700 })
    expect(lockA2.tokens['src/core.ts']).toBe(3)

    db1.sqlite.close()
    db2.sqlite.close()
  })

  test('AC-12: renewal requires matching holder + fencing token and fails after expiry', async () => {
    const dbPath = makeTempDbPath('renew.db')
    const db = createDatabase(dbPath)
    await migrate(db)
    const hub = new CoordinationHub({ store: createSqliteCoordinationStore(db) })
    const t0 = 20_000_000

    const claimRes = hub.claimTask({
      taskId: 'task-1',
      owner: 'agent-a',
      files: ['a.ts'],
      now: t0,
    })
    expect(claimRes.ok).toBe(true)
    const claimToken = claimRes.claim!.fencingToken!
    const lockToken = claimRes.lockTokens!['a.ts']!

    // Valid lock & task renewals extend expiry without incrementing fencingToken
    const goodLockRenew = hub.renewLocks('agent-a', ['a.ts'], lockToken, {
      ttlMs: 5_000,
      now: t0 + 1_000,
    })
    expect(goodLockRenew.renewed).toEqual(['a.ts'])
    expect(goodLockRenew.expiresAt).toBe(t0 + 6_000)

    const goodTaskRenew = hub.renewTask('task-1', 'agent-a', claimToken, {
      ttlMs: 5_000,
      now: t0 + 1_000,
    })
    expect(goodTaskRenew.ok).toBe(true)
    expect(goodTaskRenew.fencingToken).toBe(claimToken)

    // Wrong owner / wrong token rejected
    expect(
      hub.renewLocks('agent-b', ['a.ts'], lockToken, { ttlMs: 5_000, now: t0 + 2_000 }).errors
        .length,
    ).toBeGreaterThan(0)
    expect(
      hub.renewLocks('agent-a', ['a.ts'], lockToken + 99, { ttlMs: 5_000, now: t0 + 2_000 }).errors
        .length,
    ).toBeGreaterThan(0)
    expect(
      hub.renewTask('task-1', 'agent-a', claimToken + 99, { ttlMs: 5_000, now: t0 + 2_000 }).ok,
    ).toBe(false)

    // Past expiry -> renewal must fail & clear expired lease
    const expiredLockRenew = hub.renewLocks('agent-a', ['a.ts'], lockToken, {
      ttlMs: 5_000,
      now: t0 + 6_001,
    })
    expect(expiredLockRenew.renewed).toHaveLength(0)
    expect(expiredLockRenew.errors[0]).toContain('expired')

    const expiredTaskRenew = hub.renewTask('task-1', 'agent-a', claimToken, {
      ttlMs: 5_000,
      now: t0 + 6_001,
    })
    expect(expiredTaskRenew.ok).toBe(false)
    expect(expiredTaskRenew.error).toContain('expired')

    db.sqlite.close()
  })

  test('HTTP coordination routes enforce auth, server-derived owner, renewal & 409 fencing', async () => {
    const dbPath = makeTempDbPath('http.db')
    const db = createDatabase(dbPath)
    await migrate(db)
    const hub = new CoordinationHub({ store: createSqliteCoordinationStore(db) })

    const app = new Hono()
    const owners: Record<string, string> = {
      'tok-alice': 'alice',
      'tok-bob': 'bob',
      'tok-viewer': 'viewer-user',
    }
    const roles: Record<string, 'viewer' | 'operator' | 'admin'> = {
      'tok-alice': 'operator',
      'tok-bob': 'operator',
      'tok-viewer': 'viewer',
    }
    mountCoordinationRoutes(app as never, {
      hub,
      resolveOwner: (t) => owners[t],
      resolveRole: (t) => roles[t] ?? 'operator',
      requireAuth: true,
    })

    // Unauthenticated rejected 401; viewer rejected 403
    expect((await app.request('/coordination/status')).status).toBe(401)
    expect(
      (
        await app.request('/coordination/locks', {
          method: 'POST',
          headers: { 'content-type': 'application/json', Authorization: 'Bearer tok-viewer' },
          body: JSON.stringify({ paths: ['x.ts'] }),
        })
      ).status,
    ).toBe(403)

    // Alice tries to spoof body.owner='bob', server forces 'alice'
    const lockRes = await app.request('/coordination/locks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer tok-alice' },
      body: JSON.stringify({ owner: 'bob', paths: ['f.ts'], ttlMs: 60_000 }),
    })
    expect(lockRes.status).toBe(200)
    const lockBody = (await lockRes.json()) as {
      tokens: Record<string, number>
      locks: Array<{ owner: string; fencingToken: number }>
    }
    expect(lockBody.locks[0]?.owner).toBe('alice')
    const aliceToken = lockBody.tokens['f.ts']!

    // Renew with valid token -> 200; stale token -> 409
    const renewOk = await app.request('/coordination/leases/renew', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer tok-alice' },
      body: JSON.stringify({ kind: 'lock', paths: ['f.ts'], fencingToken: aliceToken }),
    })
    expect(renewOk.status).toBe(200)

    const writeStale = await app.request('/coordination/writes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer tok-alice' },
      body: JSON.stringify({ path: 'f.ts', hash: 'abc', fencingToken: aliceToken + 5 }),
    })
    expect(writeStale.status).toBe(409)

    const writeOk = await app.request('/coordination/writes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer tok-alice' },
      body: JSON.stringify({ path: 'f.ts', hash: 'abc', fencingToken: aliceToken }),
    })
    expect(writeOk.status).toBe(200)

    db.sqlite.close()
  })

  test('AC-13: multi-process WAL contention via Bun.spawn yields single winner & monotonic fencing', async () => {
    const dbPath = makeTempDbPath('multiproc.db')
    const db = createDatabase(dbPath)
    await migrate(db)
    db.sqlite.close()

    const workerScript = join(tempDirs[tempDirs.length - 1]!, 'worker.ts')
    const coordModPath = join(import.meta.dir, 'coordination.ts')
    const dbModPath = join(import.meta.dir, '..', 'storage', 'db.ts')
    writeFileSync(
      workerScript,
      `
      import { createDatabase } from ${JSON.stringify(dbModPath)}
      import { CoordinationHub, createSqliteCoordinationStore } from ${JSON.stringify(coordModPath)}

      const [dbPath, agentId, mode] = Bun.argv.slice(2)
      const db = createDatabase(dbPath)
      const hub = new CoordinationHub({ store: createSqliteCoordinationStore(db), claimTtlMs: 30000, lockTtlMs: 30000 })
      const now = 50_000_000

      if (mode === 'race') {
        const res = hub.lockFiles(agentId, ['shared/target.ts'], { ttlMs: 30000, now })
        if (res.locked.length === 1) {
          const tok = res.tokens['shared/target.ts']
          const w = hub.recordFencedWrite({
            path: 'shared/target.ts',
            hash: 'hash-' + agentId,
            owner: agentId,
            fencingToken: tok,
            now: now + 10,
          })
          console.log(JSON.stringify({ won: true, agentId, token: tok, writeToken: w.fencingToken }))
        } else {
          console.log(JSON.stringify({ won: false, agentId, conflicts: res.conflicts.length }))
        }
      } else if (mode === 'stale-write') {
        const staleToken = Number(Bun.argv[5])
        try {
          hub.recordFencedWrite({
            path: 'shared/target.ts',
            hash: 'stale-hash',
            owner: agentId,
            fencingToken: staleToken,
            now: now + 60_000,
          })
          console.log(JSON.stringify({ rejected: false }))
        } catch (err) {
          console.log(JSON.stringify({ rejected: true, name: (err as Error).name }))
        }
      }
      db.sqlite.close()
      `,
    )

    const procs = ['proc-1', 'proc-2', 'proc-3', 'proc-4'].map((agent) =>
      Bun.spawn(['bun', 'run', workerScript, dbPath, agent, 'race'], {
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    )

    const outputs = await Promise.all(
      procs.map(async (p) => {
        const code = await p.exited
        const stdout = await new Response(p.stdout).text()
        const stderr = await new Response(p.stderr).text()
        expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
        return JSON.parse(stdout.trim()) as { won: boolean; agentId: string; token?: number }
      }),
    )

    const winners = outputs.filter((o) => o.won)
    const losers = outputs.filter((o) => !o.won)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(3)
    const firstToken = winners[0]!.token!
    expect(firstToken).toBe(1)

    // Now have another process try a stale write at expiry time with token 1 -> rejected
    const staleProc = Bun.spawn(
      ['bun', 'run', workerScript, dbPath, winners[0]!.agentId, 'stale-write', String(firstToken)],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const staleExit = await staleProc.exited
    expect(staleExit).toBe(0)
    const staleOut = JSON.parse((await new Response(staleProc.stdout).text()).trim()) as {
      rejected: boolean
      name: string
    }
    expect(staleOut.rejected).toBe(true)
    expect(staleOut.name).toBe('FencingTokenError')
  })
})
