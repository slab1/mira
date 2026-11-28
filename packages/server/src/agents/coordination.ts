/**
 * Multi-Agent Coordination — §12 task ownership, file locking, conflict detection,
 * and single-host SQLite transactional leases with monotonic fencing tokens.
 *
 * Controls enforced here:
 * - Atomic task claims & exclusive TTL file locks via SQLite `BEGIN IMMEDIATE`
 * - Strictly monotonic per-resource `fencingToken` allocated in SQLite (`coordination_sequences`)
 * - Lease renewal (`renewTask` / `renewLocks`) requiring matching holder + fencing token before expiry
 * - Expired-lease recovery allocating a higher fencing token without letting stale holders write
 * - Write-boundary fencing verification (`recordWrite` / `recordFencedWrite` / `assertValidFencingToken`)
 * - Version-aware patches (`patchConflicts`), all-or-nothing transactions, shared `status()`
 */

import { createHash } from 'node:crypto'
import type { MiraDB } from '../storage/db.js'

export interface CoordinationStore {
  load(): Array<{
    kind: 'claim' | 'lock' | 'write'
    key: string
    payload: unknown
    expiresAt: number | null
  }>
  save(
    kind: 'claim' | 'lock' | 'write',
    key: string,
    payload: unknown,
    expiresAt?: number | null,
  ): void
  clear(kind: 'claim' | 'lock' | 'write', key: string): void
}

export type FencingFailureCode =
  | 'MISSING_LEASE'
  | 'EXPIRED_LEASE'
  | 'HOLDER_MISMATCH'
  | 'STALE_FENCING_TOKEN'

export class FencingTokenError extends Error {
  readonly code: FencingFailureCode
  readonly status = 409
  readonly path?: string
  readonly holder?: string
  readonly expectedToken?: number
  readonly providedToken?: number

  constructor(
    message: string,
    info: {
      code: FencingFailureCode
      path?: string
      holder?: string
      expectedToken?: number
      providedToken?: number
    },
  ) {
    super(message)
    this.name = 'FencingTokenError'
    this.code = info.code
    this.path = info.path
    this.holder = info.holder
    this.expectedToken = info.expectedToken
    this.providedToken = info.providedToken
  }
}

export interface TaskClaim {
  taskId: string
  owner: string
  priority: number
  files: string[]
  deps: string[]
  status: 'claimed' | 'released'
  claimedAt: number
  expiresAt: number
  fencingToken?: number
}

export interface FileLock {
  path: string
  owner: string
  taskId?: string
  acquiredAt: number
  expiresAt: number
  fencingToken?: number
}

export interface FileWrite {
  path: string
  hash: string
  owner: string
  at: number
  fencingToken?: number
}

export interface Conflict {
  kind: 'lock' | 'claim' | 'stale-base' | 'dependency'
  path?: string
  taskId?: string
  holder: string
  detail: string
}

export interface ClaimDecision {
  ok: boolean
  claim?: TaskClaim
  lockTokens?: Record<string, number>
  conflicts: Conflict[]
}

export interface TransactionalCoordinationStore extends CoordinationStore {
  readonly transactional: true
  sweepTx(now: number): { expiredLocks: number; expiredClaims: number }
  claimTaskTx(input: {
    taskId: string
    owner: string
    priority: number
    files: string[]
    deps: string[]
    claimTtlMs: number
    lockTtlMs: number
    now: number
  }): ClaimDecision
  releaseTaskTx(input: {
    taskId: string
    owner: string
    fencingToken?: number
    now: number
  }): { ok: boolean; error?: string }
  renewTaskTx(input: {
    taskId: string
    owner: string
    fencingToken: number
    ttlMs: number
    now: number
  }): { ok: boolean; expiresAt?: number; fencingToken?: number; error?: string }
  lockFilesTx(input: {
    owner: string
    paths: string[]
    taskId?: string
    ttlMs: number
    now: number
    allOrNothing?: boolean
  }): {
    locked: string[]
    tokens: Record<string, number>
    locks: FileLock[]
    conflicts: Conflict[]
  }
  unlockFilesTx(input: {
    owner: string
    paths: string[]
    fencingTokens?: number | Record<string, number>
    now: number
  }): { unlocked: string[]; errors: string[] }
  renewLocksTx(input: {
    owner: string
    paths: string[]
    fencingTokens: number | Record<string, number>
    ttlMs: number
    now: number
  }): {
    renewed: string[]
    expiresAt?: number
    errors: string[]
  }
  assertFencingTx(input: {
    path: string
    owner: string
    fencingToken: number
    now: number
  }): {
    ok: boolean
    code?: FencingFailureCode
    error?: string
    holder?: string
    expectedToken?: number
    providedToken?: number
  }
  recordWriteTx(input: {
    path: string
    hash: string
    owner: string
    fencingToken?: number
    requireFencing?: boolean
    now: number
  }): FileWrite
  patchConflictsTx(
    path: string,
    baseHash: string,
    owner: string,
  ): { stale: boolean; conflicts: Conflict[] }
  statusTx(now: number): {
    claims: TaskClaim[]
    locks: FileLock[]
    lastWrites: FileWrite[]
  }
}

function isTransactionalStore(
  store: CoordinationStore | undefined,
): store is TransactionalCoordinationStore {
  return Boolean(store && (store as Partial<TransactionalCoordinationStore>).transactional === true)
}

function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

function fileHashOf(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 16)
}

interface LeaseRow {
  resource_kind: 'claim' | 'lock'
  resource_key: string
  holder_id: string
  fencing_token: number
  task_id: string | null
  expires_at: number
  acquired_at: number
  payload: string | null
}

interface WriteRow {
  path: string
  hash: string
  holder_id: string
  fencing_token: number
  updated_at: number
}

/**
 * SQLite-backed transactional coordination store using `BEGIN IMMEDIATE` and a
 * dedicated `coordination_sequences` monotonic token table.
 */
export function createSqliteCoordinationStore(db: MiraDB): TransactionalCoordinationStore {
  const sqlite = db.sqlite
  if (!sqlite) throw new Error('no sqlite handle')

  sqlite.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS coordination_sequences (
      resource_key TEXT PRIMARY KEY,
      next_token INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS coordination_leases (
      resource_kind TEXT NOT NULL,
      resource_key TEXT NOT NULL,
      holder_id TEXT NOT NULL,
      fencing_token INTEGER NOT NULL,
      task_id TEXT,
      expires_at INTEGER NOT NULL,
      acquired_at INTEGER NOT NULL,
      payload TEXT,
      PRIMARY KEY (resource_kind, resource_key)
    );
    CREATE INDEX IF NOT EXISTS coordination_leases_expires_idx
      ON coordination_leases(expires_at);
    CREATE INDEX IF NOT EXISTS coordination_leases_holder_idx
      ON coordination_leases(holder_id);
    CREATE TABLE IF NOT EXISTS coordination_writes (
      path TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      holder_id TEXT NOT NULL,
      fencing_token INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_coordination_state (
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      payload TEXT NOT NULL,
      expires_at INTEGER,
      PRIMARY KEY (kind, key)
    );
  `)

  const runImmediate = <T>(fn: () => T): T => {
    sqlite.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      sqlite.exec('COMMIT')
      return result
    } catch (err) {
      try {
        sqlite.exec('ROLLBACK')
      } catch {}
      throw err
    }
  }

  const nextToken = (seqKey: string): number => {
    const row = sqlite
      .prepare(
        `INSERT INTO coordination_sequences (resource_key, next_token) VALUES (?, 1)
         ON CONFLICT(resource_key) DO UPDATE SET next_token = coordination_sequences.next_token + 1
         RETURNING next_token`,
      )
      .get(seqKey) as { next_token: number }
    return row.next_token
  }

  const currentSeqToken = (seqKey: string): number => {
    const row = sqlite
      .prepare('SELECT next_token FROM coordination_sequences WHERE resource_key = ?')
      .get(seqKey) as { next_token: number } | undefined
    return row?.next_token ?? 0
  }

  const sweepInTx = (now: number): { expiredLocks: number; expiredClaims: number } => {
    const expiredClaimsRows = sqlite
      .prepare(
        `SELECT resource_key, holder_id, payload
         FROM coordination_leases
         WHERE resource_kind = 'claim' AND expires_at <= ?`,
      )
      .all(now) as Array<{ resource_key: string; holder_id: string; payload: string | null }>

    let expiredLocks = 0
    const lockDeleteRes = sqlite
      .prepare(
        `DELETE FROM coordination_leases
         WHERE resource_kind = 'lock' AND expires_at <= ?`,
      )
      .run(now)
    expiredLocks += Number(lockDeleteRes.changes ?? 0)

    for (const c of expiredClaimsRows) {
      if (c.payload) {
        try {
          const parsed = JSON.parse(c.payload) as { files?: string[] }
          for (const f of parsed.files ?? []) {
            const del = sqlite
              .prepare(
                `DELETE FROM coordination_leases
                 WHERE resource_kind = 'lock' AND resource_key = ? AND holder_id = ?`,
              )
              .run(f, c.holder_id)
            expiredLocks += Number(del.changes ?? 0)
          }
        } catch {}
      }
      sqlite
        .prepare(
          `DELETE FROM coordination_leases
           WHERE resource_kind = 'claim' AND resource_key = ?`,
        )
        .run(c.resource_key)
    }

    return { expiredLocks, expiredClaims: expiredClaimsRows.length }
  }

  const parseClaimRow = (row: LeaseRow): TaskClaim => {
    const parsed = row.payload ? (JSON.parse(row.payload) as Partial<TaskClaim>) : {}
    return {
      taskId: row.resource_key,
      owner: row.holder_id,
      priority: typeof parsed.priority === 'number' ? parsed.priority : 0,
      files: Array.isArray(parsed.files) ? parsed.files.map(String) : [],
      deps: Array.isArray(parsed.deps) ? parsed.deps.map(String) : [],
      status: 'claimed',
      claimedAt: row.acquired_at,
      expiresAt: row.expires_at,
      fencingToken: row.fencing_token,
    }
  }

  const parseLockRow = (row: LeaseRow): FileLock => ({
    path: row.resource_key,
    owner: row.holder_id,
    taskId: row.task_id ?? undefined,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    fencingToken: row.fencing_token,
  })

  const resolveTokenArg = (
    path: string,
    tokens: number | Record<string, number> | undefined,
  ): number | undefined => {
    if (tokens === undefined) return undefined
    if (typeof tokens === 'number') return tokens
    return tokens[path]
  }

  const checkFencingInTx = (input: {
    path: string
    owner: string
    fencingToken?: number
    requireFencing?: boolean
    now: number
  }):
    | { ok: true; effectiveToken: number }
    | {
        ok: false
        code: FencingFailureCode
        error: string
        holder?: string
        expectedToken?: number
        providedToken?: number
      } => {
    const lockRow = sqlite
      .prepare(
        `SELECT * FROM coordination_leases
         WHERE resource_kind = 'lock' AND resource_key = ?`,
      )
      .get(input.path) as LeaseRow | undefined
    const writeRow = sqlite
      .prepare('SELECT * FROM coordination_writes WHERE path = ?')
      .get(input.path) as WriteRow | undefined
    const lastWriteToken = writeRow?.fencing_token ?? 0
    const seqToken = currentSeqToken(`lock:${input.path}`)
    const strict = input.fencingToken !== undefined || input.requireFencing === true

    if (strict) {
      if (!lockRow) {
        return {
          ok: false,
          code: seqToken > 0 ? 'EXPIRED_LEASE' : 'MISSING_LEASE',
          error:
            seqToken > 0
              ? `lease for ${input.path} is no longer active (last token ${seqToken})`
              : `no active lease for ${input.path}`,
          expectedToken: seqToken > 0 ? seqToken : undefined,
          providedToken: input.fencingToken,
        }
      }
      if (lockRow.expires_at <= input.now) {
        return {
          ok: false,
          code: 'EXPIRED_LEASE',
          error: `lease for ${input.path} held by ${lockRow.holder_id} has expired`,
          holder: lockRow.holder_id,
          expectedToken: lockRow.fencing_token,
          providedToken: input.fencingToken,
        }
      }
      if (lockRow.holder_id !== input.owner) {
        return {
          ok: false,
          code: 'HOLDER_MISMATCH',
          error: `file ${input.path} lease is held by ${lockRow.holder_id}, not ${input.owner}`,
          holder: lockRow.holder_id,
          expectedToken: lockRow.fencing_token,
          providedToken: input.fencingToken,
        }
      }
      if (input.fencingToken !== undefined && lockRow.fencing_token !== input.fencingToken) {
        return {
          ok: false,
          code: 'STALE_FENCING_TOKEN',
          error: `stale fencing token ${input.fencingToken} for ${input.path}; active token is ${lockRow.fencing_token}`,
          holder: lockRow.holder_id,
          expectedToken: lockRow.fencing_token,
          providedToken: input.fencingToken,
        }
      }
      if (input.fencingToken !== undefined && input.fencingToken < lastWriteToken) {
        return {
          ok: false,
          code: 'STALE_FENCING_TOKEN',
          error: `fencing token ${input.fencingToken} is behind last committed write token ${lastWriteToken} for ${input.path}`,
          holder: writeRow?.holder_id,
          expectedToken: lastWriteToken,
          providedToken: input.fencingToken,
        }
      }
      return { ok: true, effectiveToken: input.fencingToken ?? lockRow.fencing_token }
    }

    // Legacy unfenced write path: still block writes if another holder owns a live lease.
    if (lockRow && lockRow.expires_at > input.now && lockRow.holder_id !== input.owner) {
      return {
        ok: false,
        code: 'HOLDER_MISMATCH',
        error: `file ${input.path} is actively locked by ${lockRow.holder_id}`,
        holder: lockRow.holder_id,
        expectedToken: lockRow.fencing_token,
      }
    }
    const effective =
      lockRow && lockRow.expires_at > input.now && lockRow.holder_id === input.owner
        ? Math.max(lockRow.fencing_token, lastWriteToken)
        : lastWriteToken
    return { ok: true, effectiveToken: effective }
  }

  return {
    transactional: true,

    load() {
      const items: Array<{
        kind: 'claim' | 'lock' | 'write'
        key: string
        payload: unknown
        expiresAt: number | null
      }> = []
      const leases = sqlite.prepare('SELECT * FROM coordination_leases').all() as LeaseRow[]
      for (const r of leases) {
        if (r.resource_kind === 'claim') {
          items.push({
            kind: 'claim',
            key: r.resource_key,
            payload: parseClaimRow(r),
            expiresAt: r.expires_at,
          })
        } else {
          items.push({
            kind: 'lock',
            key: r.resource_key,
            payload: parseLockRow(r),
            expiresAt: r.expires_at,
          })
        }
      }
      const writes = sqlite.prepare('SELECT * FROM coordination_writes').all() as WriteRow[]
      for (const w of writes) {
        items.push({
          kind: 'write',
          key: w.path,
          payload: {
            path: w.path,
            hash: w.hash,
            owner: w.holder_id,
            at: w.updated_at,
            fencingToken: w.fencing_token > 0 ? w.fencing_token : undefined,
          } satisfies FileWrite,
          expiresAt: null,
        })
      }
      return items
    },

    save(kind, key, payload, expiresAt) {
      if (kind === 'write') {
        const w = payload as FileWrite
        sqlite
          .prepare(
            `INSERT INTO coordination_writes (path, hash, holder_id, fencing_token, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(path) DO UPDATE SET
               hash = excluded.hash,
               holder_id = excluded.holder_id,
               fencing_token = MAX(coordination_writes.fencing_token, excluded.fencing_token),
               updated_at = excluded.updated_at`,
          )
          .run(w.path, w.hash, w.owner, w.fencingToken ?? 0, w.at)
        return
      }
      const p = payload as Partial<TaskClaim & FileLock>
      sqlite
        .prepare(
          `INSERT INTO coordination_leases
             (resource_kind, resource_key, holder_id, fencing_token, task_id, expires_at, acquired_at, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(resource_kind, resource_key) DO UPDATE SET
             holder_id = excluded.holder_id,
             fencing_token = excluded.fencing_token,
             task_id = excluded.task_id,
             expires_at = excluded.expires_at,
             acquired_at = excluded.acquired_at,
             payload = excluded.payload`,
        )
        .run(
          kind,
          key,
          p.owner ?? '',
          p.fencingToken ?? 1,
          p.taskId ?? null,
          expiresAt ?? p.expiresAt ?? Date.now(),
          p.acquiredAt ?? p.claimedAt ?? Date.now(),
          JSON.stringify(payload),
        )
    },

    clear(kind, key) {
      if (kind === 'write') {
        sqlite.prepare('DELETE FROM coordination_writes WHERE path = ?').run(key)
        return
      }
      sqlite
        .prepare('DELETE FROM coordination_leases WHERE resource_kind = ? AND resource_key = ?')
        .run(kind, key)
    },

    sweepTx(now) {
      return runImmediate(() => sweepInTx(now))
    },

    claimTaskTx(input) {
      return runImmediate(() => {
        sweepInTx(input.now)
        const conflicts: Conflict[] = []

        const existing = sqlite
          .prepare(
            `SELECT * FROM coordination_leases
             WHERE resource_kind = 'claim' AND resource_key = ?`,
          )
          .get(input.taskId) as LeaseRow | undefined
        if (existing && existing.expires_at > input.now && existing.holder_id !== input.owner) {
          const c = parseClaimRow(existing)
          conflicts.push({
            kind: 'claim',
            taskId: input.taskId,
            holder: c.owner,
            detail: `task ${input.taskId} already claimed by ${c.owner} (priority ${c.priority})`,
          })
        }

        const otherClaims = sqlite
          .prepare(
            `SELECT * FROM coordination_leases
             WHERE resource_kind = 'claim' AND expires_at > ? AND holder_id != ?`,
          )
          .all(input.now, input.owner) as LeaseRow[]

        const files = input.files.map(String)
        for (const f of files) {
          for (const oc of otherClaims) {
            const parsed = parseClaimRow(oc)
            if (parsed.files.includes(f)) {
              conflicts.push({
                kind: 'claim',
                path: f,
                holder: parsed.owner,
                detail: `file ${f} is in claimed task ${parsed.taskId} (owner ${parsed.owner})`,
              })
              break
            }
          }
          const existingLock = sqlite
            .prepare(
              `SELECT * FROM coordination_leases
               WHERE resource_kind = 'lock' AND resource_key = ? AND expires_at > ?`,
            )
            .get(f, input.now) as LeaseRow | undefined
          if (existingLock && existingLock.holder_id !== input.owner) {
            conflicts.push({
              kind: 'lock',
              path: f,
              holder: existingLock.holder_id,
              detail: `file ${f} locked by ${existingLock.holder_id} (task ${existingLock.task_id ?? 'none'})`,
            })
          }
        }

        for (const dep of input.deps) {
          const depRow = sqlite
            .prepare(
              `SELECT * FROM coordination_leases
               WHERE resource_kind = 'claim' AND resource_key = ? AND expires_at > ?`,
            )
            .get(dep, input.now) as LeaseRow | undefined
          if (depRow && depRow.holder_id !== input.owner) {
            conflicts.push({
              kind: 'dependency',
              taskId: dep,
              holder: depRow.holder_id,
              detail: `dependency ${dep} still claimed by ${depRow.holder_id}`,
            })
          }
        }

        if (conflicts.length > 0) return { ok: false, conflicts }

        const claimToken = nextToken(`claim:${input.taskId}`)
        const claim: TaskClaim = {
          taskId: input.taskId,
          owner: input.owner,
          priority: input.priority,
          files,
          deps: [...input.deps],
          status: 'claimed',
          claimedAt: input.now,
          expiresAt: input.now + input.claimTtlMs,
          fencingToken: claimToken,
        }

        sqlite
          .prepare(
            `INSERT INTO coordination_leases
               (resource_kind, resource_key, holder_id, fencing_token, task_id, expires_at, acquired_at, payload)
             VALUES ('claim', ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(resource_kind, resource_key) DO UPDATE SET
               holder_id = excluded.holder_id,
               fencing_token = excluded.fencing_token,
               task_id = excluded.task_id,
               expires_at = excluded.expires_at,
               acquired_at = excluded.acquired_at,
               payload = excluded.payload`,
          )
          .run(
            input.taskId,
            input.owner,
            claimToken,
            input.taskId,
            claim.expiresAt,
            claim.claimedAt,
            JSON.stringify(claim),
          )

        const lockTokens: Record<string, number> = {}
        for (const f of files) {
          const lockToken = nextToken(`lock:${f}`)
          lockTokens[f] = lockToken
          const lock: FileLock = {
            path: f,
            owner: input.owner,
            taskId: input.taskId,
            acquiredAt: input.now,
            expiresAt: input.now + input.lockTtlMs,
            fencingToken: lockToken,
          }
          sqlite
            .prepare(
              `INSERT INTO coordination_leases
                 (resource_kind, resource_key, holder_id, fencing_token, task_id, expires_at, acquired_at, payload)
               VALUES ('lock', ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(resource_kind, resource_key) DO UPDATE SET
                 holder_id = excluded.holder_id,
                 fencing_token = excluded.fencing_token,
                 task_id = excluded.task_id,
                 expires_at = excluded.expires_at,
                 acquired_at = excluded.acquired_at,
                 payload = excluded.payload`,
            )
            .run(
              f,
              input.owner,
              lockToken,
              input.taskId,
              lock.expiresAt,
              lock.acquiredAt,
              JSON.stringify(lock),
            )
        }

        return { ok: true, claim, lockTokens, conflicts: [] }
      })
    },

    releaseTaskTx(input) {
      return runImmediate(() => {
        sweepInTx(input.now)
        const row = sqlite
          .prepare(
            `SELECT * FROM coordination_leases
             WHERE resource_kind = 'claim' AND resource_key = ?`,
          )
          .get(input.taskId) as LeaseRow | undefined
        if (!row) return { ok: false, error: 'not claimed' }
        if (row.holder_id !== input.owner) return { ok: false, error: `owned by ${row.holder_id}` }
        if (input.fencingToken !== undefined && row.fencing_token !== input.fencingToken) {
          return {
            ok: false,
            error: `stale fencing token ${input.fencingToken} (current ${row.fencing_token})`,
          }
        }
        const parsed = parseClaimRow(row)
        sqlite
          .prepare(
            `DELETE FROM coordination_leases
             WHERE resource_kind = 'claim' AND resource_key = ?`,
          )
          .run(input.taskId)
        for (const f of parsed.files) {
          sqlite
            .prepare(
              `DELETE FROM coordination_leases
               WHERE resource_kind = 'lock' AND resource_key = ? AND holder_id = ?`,
            )
            .run(f, input.owner)
        }
        return { ok: true }
      })
    },

    renewTaskTx(input) {
      return runImmediate(() => {
        const row = sqlite
          .prepare(
            `SELECT * FROM coordination_leases
             WHERE resource_kind = 'claim' AND resource_key = ?`,
          )
          .get(input.taskId) as LeaseRow | undefined
        if (!row) return { ok: false, error: 'claim not found' }
        if (row.expires_at <= input.now) {
          sweepInTx(input.now)
          return { ok: false, error: 'claim expired — renewal rejected' }
        }
        if (row.holder_id !== input.owner) {
          return { ok: false, error: `owned by ${row.holder_id}` }
        }
        if (row.fencing_token !== input.fencingToken) {
          return {
            ok: false,
            error: `fencing token mismatch (expected ${row.fencing_token}, got ${input.fencingToken})`,
          }
        }
        const newExpiresAt = input.now + input.ttlMs
        const parsed = parseClaimRow(row)
        parsed.expiresAt = newExpiresAt
        sqlite
          .prepare(
            `UPDATE coordination_leases SET expires_at = ?, payload = ?
             WHERE resource_kind = 'claim' AND resource_key = ? AND holder_id = ? AND fencing_token = ?`,
          )
          .run(newExpiresAt, JSON.stringify(parsed), input.taskId, input.owner, input.fencingToken)
        return { ok: true, expiresAt: newExpiresAt, fencingToken: row.fencing_token }
      })
    },

    lockFilesTx(input) {
      return runImmediate(() => {
        sweepInTx(input.now)
        const locked: string[] = []
        const tokens: Record<string, number> = {}
        const locks: FileLock[] = []
        const conflicts: Conflict[] = []

        for (const raw of input.paths) {
          const path = String(raw)
          const existing = sqlite
            .prepare(
              `SELECT * FROM coordination_leases
               WHERE resource_kind = 'lock' AND resource_key = ?`,
            )
            .get(path) as LeaseRow | undefined
          if (existing && existing.expires_at > input.now && existing.holder_id !== input.owner) {
            conflicts.push({
              kind: 'lock',
              path,
              holder: existing.holder_id,
              detail: `file ${path} locked by ${existing.holder_id} (task ${existing.task_id ?? 'none'})`,
            })
          }
        }

        if (input.allOrNothing && conflicts.length > 0) {
          return { locked: [], tokens: {}, locks: [], conflicts }
        }

        for (const raw of input.paths) {
          const path = String(raw)
          if (conflicts.some((c) => c.path === path)) continue
          const token = nextToken(`lock:${path}`)
          const lock: FileLock = {
            path,
            owner: input.owner,
            taskId: input.taskId,
            acquiredAt: input.now,
            expiresAt: input.now + input.ttlMs,
            fencingToken: token,
          }
          sqlite
            .prepare(
              `INSERT INTO coordination_leases
                 (resource_kind, resource_key, holder_id, fencing_token, task_id, expires_at, acquired_at, payload)
               VALUES ('lock', ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(resource_kind, resource_key) DO UPDATE SET
                 holder_id = excluded.holder_id,
                 fencing_token = excluded.fencing_token,
                 task_id = excluded.task_id,
                 expires_at = excluded.expires_at,
                 acquired_at = excluded.acquired_at,
                 payload = excluded.payload`,
            )
            .run(
              path,
              input.owner,
              token,
              input.taskId ?? null,
              lock.expiresAt,
              lock.acquiredAt,
              JSON.stringify(lock),
            )
          locked.push(path)
          tokens[path] = token
          locks.push(lock)
        }

        return { locked, tokens, locks, conflicts }
      })
    },

    unlockFilesTx(input) {
      return runImmediate(() => {
        sweepInTx(input.now)
        const unlocked: string[] = []
        const errors: string[] = []
        for (const raw of input.paths) {
          const path = String(raw)
          const row = sqlite
            .prepare(
              `SELECT * FROM coordination_leases
               WHERE resource_kind = 'lock' AND resource_key = ?`,
            )
            .get(path) as LeaseRow | undefined
          if (!row) {
            unlocked.push(path)
            continue
          }
          if (row.holder_id !== input.owner) {
            errors.push(`file ${path} locked by ${row.holder_id}`)
            continue
          }
          const expectedTok = resolveTokenArg(path, input.fencingTokens)
          if (expectedTok !== undefined && row.fencing_token !== expectedTok) {
            errors.push(
              `file ${path} fencing token mismatch (expected ${row.fencing_token}, got ${expectedTok})`,
            )
            continue
          }
          sqlite
            .prepare(
              `DELETE FROM coordination_leases
               WHERE resource_kind = 'lock' AND resource_key = ?`,
            )
            .run(path)
          unlocked.push(path)
        }
        return { unlocked, errors }
      })
    },

    renewLocksTx(input) {
      return runImmediate(() => {
        const renewed: string[] = []
        const errors: string[] = []
        const newExpiresAt = input.now + input.ttlMs
        for (const raw of input.paths) {
          const path = String(raw)
          const tok = resolveTokenArg(path, input.fencingTokens)
          const row = sqlite
            .prepare(
              `SELECT * FROM coordination_leases
               WHERE resource_kind = 'lock' AND resource_key = ?`,
            )
            .get(path) as LeaseRow | undefined
          if (!row) {
            errors.push(`file ${path} has no active lock`)
            continue
          }
          if (row.expires_at <= input.now) {
            sqlite
              .prepare(
                `DELETE FROM coordination_leases
                 WHERE resource_kind = 'lock' AND resource_key = ?`,
              )
              .run(path)
            errors.push(`file ${path} lock expired — renewal rejected`)
            continue
          }
          if (row.holder_id !== input.owner) {
            errors.push(`file ${path} locked by ${row.holder_id}`)
            continue
          }
          if (tok === undefined || row.fencing_token !== tok) {
            errors.push(
              `file ${path} fencing token mismatch (expected ${row.fencing_token}, got ${tok})`,
            )
            continue
          }
          const updated = parseLockRow(row)
          updated.expiresAt = newExpiresAt
          sqlite
            .prepare(
              `UPDATE coordination_leases SET expires_at = ?, payload = ?
               WHERE resource_kind = 'lock' AND resource_key = ? AND holder_id = ? AND fencing_token = ?`,
            )
            .run(newExpiresAt, JSON.stringify(updated), path, input.owner, tok)
          renewed.push(path)
        }
        return {
          renewed,
          expiresAt: renewed.length > 0 ? newExpiresAt : undefined,
          errors,
        }
      })
    },

    assertFencingTx(input) {
      return runImmediate(() => {
        const res = checkFencingInTx({
          path: input.path,
          owner: input.owner,
          fencingToken: input.fencingToken,
          requireFencing: true,
          now: input.now,
        })
        if (res.ok) return { ok: true }
        return res
      })
    },

    recordWriteTx(input) {
      return runImmediate(() => {
        const check = checkFencingInTx({
          path: input.path,
          owner: input.owner,
          fencingToken: input.fencingToken,
          requireFencing: input.requireFencing,
          now: input.now,
        })
        if (!check.ok) {
          throw new FencingTokenError(check.error, {
            code: check.code,
            path: input.path,
            holder: check.holder,
            expectedToken: check.expectedToken,
            providedToken: check.providedToken,
          })
        }
        const hash = String(input.hash).slice(0, 64)
        sqlite
          .prepare(
            `INSERT INTO coordination_writes (path, hash, holder_id, fencing_token, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(path) DO UPDATE SET
               hash = excluded.hash,
               holder_id = excluded.holder_id,
               fencing_token = MAX(coordination_writes.fencing_token, excluded.fencing_token),
               updated_at = excluded.updated_at`,
          )
          .run(input.path, hash, input.owner, check.effectiveToken, input.now)

        return {
          path: input.path,
          hash,
          owner: input.owner,
          at: input.now,
          fencingToken: check.effectiveToken > 0 ? check.effectiveToken : undefined,
        }
      })
    },

    patchConflictsTx(path, baseHash, owner) {
      const last = sqlite
        .prepare('SELECT * FROM coordination_writes WHERE path = ?')
        .get(path) as WriteRow | undefined
      if (!last) return { stale: false, conflicts: [] }
      if (last.hash === String(baseHash).slice(0, 64)) return { stale: false, conflicts: [] }
      return {
        stale: true,
        conflicts: [
          {
            kind: 'stale-base',
            path,
            holder: last.holder_id,
            detail: `patch base ${String(baseHash).slice(0, 12)} is stale — ${last.holder_id} wrote ${last.hash.slice(0, 12)} since (requested by ${owner})`,
          },
        ],
      }
    },

    statusTx(now) {
      return runImmediate(() => {
        sweepInTx(now)
        const claimRows = sqlite
          .prepare(
            `SELECT * FROM coordination_leases
             WHERE resource_kind = 'claim' AND expires_at > ?`,
          )
          .all(now) as LeaseRow[]
        const lockRows = sqlite
          .prepare(
            `SELECT * FROM coordination_leases
             WHERE resource_kind = 'lock' AND expires_at > ?`,
          )
          .all(now) as LeaseRow[]
        const writeRows = sqlite
          .prepare('SELECT * FROM coordination_writes ORDER BY updated_at DESC LIMIT 50')
          .all() as WriteRow[]

        return {
          claims: claimRows.map(parseClaimRow),
          locks: lockRows.map(parseLockRow),
          lastWrites: writeRows.map((w) => ({
            path: w.path,
            hash: w.hash,
            owner: w.holder_id,
            at: w.updated_at,
            fencingToken: w.fencing_token > 0 ? w.fencing_token : undefined,
          })),
        }
      })
    },
  }
}

export interface CoordinationHubOptions {
  lockTtlMs?: number
  claimTtlMs?: number
  store?: CoordinationStore
  strictPersistence?: boolean
  requireFencingOnWrites?: boolean
}

function isStoreLike(v: unknown): v is CoordinationStore {
  return Boolean(
    v &&
      typeof v === 'object' &&
      typeof (v as CoordinationStore).load === 'function' &&
      typeof (v as CoordinationStore).save === 'function' &&
      typeof (v as CoordinationStore).clear === 'function',
  )
}

export class CoordinationHub {
  private claims = new Map<string, TaskClaim>()
  private locks = new Map<string, FileLock>() // path → lock
  private writes = new Map<string, FileWrite>() // path → last write
  private sequences = new Map<string, number>() // seqKey → last token
  private lastWriteTokens = new Map<string, number>() // path → max committed token
  private transactions = new Map<
    string,
    {
      owner: string
      lockPaths: string[]
      lockTokens: Record<string, number>
      taskIds: string[]
      at: number
    }
  >()
  private readonly lockTtlMs: number
  private readonly claimTtlMs: number
  private readonly strictPersistence: boolean
  private readonly requireFencingOnWrites: boolean
  private store?: CoordinationStore

  constructor(opts: CoordinationHubOptions | CoordinationStore = {}) {
    const normalizedOpts: CoordinationHubOptions = isStoreLike(opts) ? { store: opts } : opts
    this.lockTtlMs = normalizedOpts.lockTtlMs ?? envMs('MIRA_LOCK_TTL_MS', 600_000)
    this.claimTtlMs = normalizedOpts.claimTtlMs ?? envMs('MIRA_CLAIM_TTL_MS', 1_800_000)
    this.requireFencingOnWrites = normalizedOpts.requireFencingOnWrites ?? false
    this.store = normalizedOpts.store
    this.strictPersistence =
      normalizedOpts.strictPersistence ??
      (isTransactionalStore(this.store) || process.env.NODE_ENV === 'production')

    if (this.store && !isTransactionalStore(this.store)) {
      try {
        const now = Date.now()
        for (const { kind, key, payload, expiresAt } of this.store.load()) {
          if (expiresAt !== null && expiresAt <= now) {
            try {
              this.store.clear(kind, key)
            } catch (err) {
              if (this.strictPersistence) throw err
            }
            continue
          }
          if (kind === 'claim') {
            const claim = payload as TaskClaim
            if (claim.status === 'claimed' && claim.expiresAt <= now) claim.status = 'released'
            this.claims.set(key, claim)
            if (claim.fencingToken) {
              const prev = this.sequences.get(`claim:${key}`) ?? 0
              if (claim.fencingToken > prev) this.sequences.set(`claim:${key}`, claim.fencingToken)
            }
          } else if (kind === 'lock') {
            const lock = payload as FileLock
            this.locks.set(key, lock)
            if (lock.fencingToken) {
              const prev = this.sequences.get(`lock:${key}`) ?? 0
              if (lock.fencingToken > prev) this.sequences.set(`lock:${key}`, lock.fencingToken)
            }
          } else if (kind === 'write') {
            const w = payload as FileWrite
            this.writes.set(key, w)
            if (w.fencingToken) {
              const prev = this.lastWriteTokens.get(key) ?? 0
              if (w.fencingToken > prev) this.lastWriteTokens.set(key, w.fencingToken)
            }
          }
        }
      } catch (err) {
        if (this.strictPersistence) throw err
      }
    }
  }

  private nextMemoryToken(seqKey: string): number {
    const next = (this.sequences.get(seqKey) ?? 0) + 1
    this.sequences.set(seqKey, next)
    return next
  }

  private persistSave(
    kind: 'claim' | 'lock' | 'write',
    key: string,
    payload: unknown,
    expiresAt: number | null,
  ): void {
    if (!this.store) return
    try {
      this.store.save(kind, key, payload, expiresAt)
    } catch (err) {
      if (this.strictPersistence) throw err
    }
  }

  private persistClear(kind: 'claim' | 'lock' | 'write', key: string): void {
    if (!this.store) return
    try {
      this.store.clear(kind, key)
    } catch (err) {
      if (this.strictPersistence) throw err
    }
  }

  /** Reap expired claims/locks/transactions — called on every access. */
  sweep(now = Date.now()): { expiredLocks: number; expiredClaims: number } {
    for (const [txId, tx] of this.transactions) {
      if (now - tx.at > this.lockTtlMs) this.transactions.delete(txId)
    }
    if (isTransactionalStore(this.store)) {
      return this.store.sweepTx(now)
    }

    let expiredLocks = 0
    let expiredClaims = 0
    for (const [path, lock] of this.locks) {
      if (lock.expiresAt <= now) {
        this.locks.delete(path)
        this.persistClear('lock', path)
        expiredLocks++
      }
    }
    for (const [taskId, claim] of this.claims) {
      if (claim.status === 'claimed' && claim.expiresAt <= now) {
        claim.status = 'released'
        this.persistClear('claim', taskId)
        expiredClaims++
        for (const f of claim.files) {
          const lock = this.locks.get(f)
          if (lock?.owner === claim.owner) {
            this.locks.delete(f)
            this.persistClear('lock', f)
            expiredLocks++
          }
        }
      }
    }
    return { expiredLocks, expiredClaims }
  }

  /**
   * Claim task ownership atomically. Conflicts with active claims on the task,
   * overlapping files in active claims/locks, or unmet active dependencies.
   */
  claimTask(input: {
    taskId: string
    owner: string
    priority?: number
    files?: string[]
    deps?: string[]
    now?: number
  }): ClaimDecision {
    const now = input.now ?? Date.now()
    const files = (input.files ?? []).map(String)
    const deps = (input.deps ?? []).map(String)
    if (isTransactionalStore(this.store)) {
      return this.store.claimTaskTx({
        taskId: input.taskId,
        owner: input.owner,
        priority: input.priority ?? 0,
        files,
        deps,
        claimTtlMs: this.claimTtlMs,
        lockTtlMs: this.lockTtlMs,
        now,
      })
    }

    this.sweep(now)
    const conflicts: Conflict[] = []

    const existing = this.claims.get(input.taskId)
    if (existing && existing.status === 'claimed' && existing.owner !== input.owner) {
      conflicts.push({
        kind: 'claim',
        taskId: input.taskId,
        holder: existing.owner,
        detail: `task ${input.taskId} already claimed by ${existing.owner} (priority ${existing.priority})`,
      })
    }

    for (const f of files) {
      const claim = this.liveClaimForFile(f, input.owner, now)
      if (claim) {
        conflicts.push({
          kind: 'claim',
          path: f,
          holder: claim.owner,
          detail: `file ${f} is in claimed task ${claim.taskId} (owner ${claim.owner})`,
        })
      }
      const existingLock = this.locks.get(f)
      if (existingLock && existingLock.expiresAt > now && existingLock.owner !== input.owner) {
        conflicts.push({
          kind: 'lock',
          path: f,
          holder: existingLock.owner,
          detail: `file ${f} locked by ${existingLock.owner} (task ${existingLock.taskId ?? 'none'})`,
        })
      }
    }

    for (const dep of deps) {
      const depClaim = this.claims.get(dep)
      if (depClaim && depClaim.status === 'claimed' && depClaim.owner !== input.owner) {
        conflicts.push({
          kind: 'dependency',
          taskId: dep,
          holder: depClaim.owner,
          detail: `dependency ${dep} still claimed by ${depClaim.owner}`,
        })
      }
    }

    if (conflicts.length > 0) return { ok: false, conflicts }

    const claimToken = this.nextMemoryToken(`claim:${input.taskId}`)
    const claim: TaskClaim = {
      taskId: input.taskId,
      owner: input.owner,
      priority: input.priority ?? 0,
      files,
      deps,
      status: 'claimed',
      claimedAt: now,
      expiresAt: now + this.claimTtlMs,
      fencingToken: claimToken,
    }
    this.claims.set(input.taskId, claim)
    this.persistSave('claim', claim.taskId, claim, claim.expiresAt)

    const lockTokens: Record<string, number> = {}
    for (const f of files) {
      const lockToken = this.nextMemoryToken(`lock:${f}`)
      lockTokens[f] = lockToken
      const lock: FileLock = {
        path: f,
        owner: input.owner,
        taskId: input.taskId,
        acquiredAt: now,
        expiresAt: now + this.lockTtlMs,
        fencingToken: lockToken,
      }
      this.locks.set(f, lock)
      this.persistSave('lock', lock.path, lock, lock.expiresAt)
    }
    return { ok: true, claim, lockTokens, conflicts: [] }
  }

  /** Renew task claim lease — requires active lease, matching owner, and matching fencingToken. */
  renewTask(
    taskId: string,
    owner: string,
    fencingToken: number,
    opts: { ttlMs?: number; now?: number } = {},
  ): { ok: boolean; expiresAt?: number; fencingToken?: number; error?: string } {
    const now = opts.now ?? Date.now()
    const ttlMs = opts.ttlMs ?? this.claimTtlMs
    if (isTransactionalStore(this.store)) {
      return this.store.renewTaskTx({ taskId, owner, fencingToken, ttlMs, now })
    }
    const claim = this.claims.get(taskId)
    if (!claim || claim.status !== 'claimed') return { ok: false, error: 'claim not found' }
    if (claim.expiresAt <= now) {
      this.sweep(now)
      return { ok: false, error: 'claim expired — renewal rejected' }
    }
    if (claim.owner !== owner) return { ok: false, error: `owned by ${claim.owner}` }
    if (claim.fencingToken !== fencingToken) {
      return {
        ok: false,
        error: `fencing token mismatch (expected ${claim.fencingToken}, got ${fencingToken})`,
      }
    }
    claim.expiresAt = now + ttlMs
    this.persistSave('claim', claim.taskId, claim, claim.expiresAt)
    return { ok: true, expiresAt: claim.expiresAt, fencingToken: claim.fencingToken }
  }

  /** Release task ownership — owner-only (and fencingToken-checked if provided). */
  releaseTask(
    taskId: string,
    owner: string,
    nowOrOpts: number | { now?: number; fencingToken?: number } = Date.now(),
  ): { ok: boolean; error?: string } {
    const now = typeof nowOrOpts === 'number' ? nowOrOpts : (nowOrOpts.now ?? Date.now())
    const fencingToken = typeof nowOrOpts === 'number' ? undefined : nowOrOpts.fencingToken
    if (isTransactionalStore(this.store)) {
      return this.store.releaseTaskTx({ taskId, owner, fencingToken, now })
    }

    this.sweep(now)
    const claim = this.claims.get(taskId)
    if (!claim || claim.status !== 'claimed') return { ok: false, error: 'not claimed' }
    if (claim.owner !== owner) return { ok: false, error: `owned by ${claim.owner}` }
    if (fencingToken !== undefined && claim.fencingToken !== fencingToken) {
      return {
        ok: false,
        error: `stale fencing token ${fencingToken} (current ${claim.fencingToken})`,
      }
    }
    claim.status = 'released'
    this.persistClear('claim', taskId)
    for (const f of claim.files) {
      const lock = this.locks.get(f)
      if (lock?.owner === owner) {
        this.locks.delete(f)
        this.persistClear('lock', f)
      }
    }
    return { ok: true }
  }

  /** Exclusive file locks with TTL and monotonic per-path fencing tokens. */
  lockFiles(
    owner: string,
    paths: string[],
    opts: { taskId?: string; ttlMs?: number; now?: number } = {},
  ): {
    locked: string[]
    tokens: Record<string, number>
    locks: FileLock[]
    conflicts: Conflict[]
  } {
    const now = opts.now ?? Date.now()
    const ttlMs = opts.ttlMs ?? this.lockTtlMs
    if (isTransactionalStore(this.store)) {
      return this.store.lockFilesTx({
        owner,
        paths,
        taskId: opts.taskId,
        ttlMs,
        now,
      })
    }

    this.sweep(now)
    const locked: string[] = []
    const tokens: Record<string, number> = {}
    const locks: FileLock[] = []
    const conflicts: Conflict[] = []
    for (const raw of paths) {
      const path = String(raw)
      const existing = this.locks.get(path)
      if (existing && existing.expiresAt > now && existing.owner !== owner) {
        conflicts.push({
          kind: 'lock',
          path,
          holder: existing.owner,
          detail: `file ${path} locked by ${existing.owner} (task ${existing.taskId ?? 'none'})`,
        })
        continue
      }
      const token = this.nextMemoryToken(`lock:${path}`)
      const lock: FileLock = {
        path,
        owner,
        taskId: opts.taskId,
        acquiredAt: now,
        expiresAt: now + ttlMs,
        fencingToken: token,
      }
      this.locks.set(path, lock)
      this.persistSave('lock', lock.path, lock, lock.expiresAt)
      locked.push(path)
      tokens[path] = token
      locks.push(lock)
    }
    return { locked, tokens, locks, conflicts }
  }

  /** Renew file locks — succeeds only when leases are unexpired and holder + fencingToken match. */
  renewLocks(
    owner: string,
    paths: string[],
    fencingTokens: number | Record<string, number>,
    opts: { ttlMs?: number; now?: number } = {},
  ): { renewed: string[]; expiresAt?: number; errors: string[] } {
    const now = opts.now ?? Date.now()
    const ttlMs = opts.ttlMs ?? this.lockTtlMs
    if (isTransactionalStore(this.store)) {
      return this.store.renewLocksTx({ owner, paths, fencingTokens, ttlMs, now })
    }

    const renewed: string[] = []
    const errors: string[] = []
    const newExpiresAt = now + ttlMs
    for (const raw of paths) {
      const path = String(raw)
      const tok = typeof fencingTokens === 'number' ? fencingTokens : fencingTokens[path]
      const lock = this.locks.get(path)
      if (!lock) {
        errors.push(`file ${path} has no active lock`)
        continue
      }
      if (lock.expiresAt <= now) {
        this.locks.delete(path)
        this.persistClear('lock', path)
        errors.push(`file ${path} lock expired — renewal rejected`)
        continue
      }
      if (lock.owner !== owner) {
        errors.push(`file ${path} locked by ${lock.owner}`)
        continue
      }
      if (tok === undefined || lock.fencingToken !== tok) {
        errors.push(`file ${path} fencing token mismatch (expected ${lock.fencingToken}, got ${tok})`)
        continue
      }
      lock.expiresAt = newExpiresAt
      this.persistSave('lock', lock.path, lock, lock.expiresAt)
      renewed.push(path)
    }
    return {
      renewed,
      expiresAt: renewed.length > 0 ? newExpiresAt : undefined,
      errors,
    }
  }

  /** Owner-only unlock (and fencingToken-checked if provided). */
  unlockFiles(
    owner: string,
    paths: string[],
    nowOrOpts: number | { now?: number; fencingTokens?: number | Record<string, number> } = Date.now(),
  ): { unlocked: string[]; errors: string[] } {
    const now = typeof nowOrOpts === 'number' ? nowOrOpts : (nowOrOpts.now ?? Date.now())
    const fencingTokens = typeof nowOrOpts === 'number' ? undefined : nowOrOpts.fencingTokens
    if (isTransactionalStore(this.store)) {
      return this.store.unlockFilesTx({ owner, paths, fencingTokens, now })
    }

    this.sweep(now)
    const unlocked: string[] = []
    const errors: string[] = []
    for (const raw of paths) {
      const path = String(raw)
      const lock = this.locks.get(path)
      if (!lock) {
        unlocked.push(path)
        continue
      }
      if (lock.owner !== owner) {
        errors.push(`file ${path} locked by ${lock.owner}`)
        continue
      }
      const tok =
        fencingTokens === undefined
          ? undefined
          : typeof fencingTokens === 'number'
            ? fencingTokens
            : fencingTokens[path]
      if (tok !== undefined && lock.fencingToken !== tok) {
        errors.push(`file ${path} fencing token mismatch (expected ${lock.fencingToken}, got ${tok})`)
        continue
      }
      this.locks.delete(path)
      this.persistClear('lock', path)
      unlocked.push(path)
    }
    return { unlocked, errors }
  }

  /** Write-boundary check: verify caller owns a live lease and holds the active fencing token. */
  assertValidFencingToken(
    path: string,
    owner: string,
    fencingToken: number,
    now = Date.now(),
  ): {
    ok: boolean
    code?: FencingFailureCode
    error?: string
    holder?: string
    expectedToken?: number
    providedToken?: number
  } {
    const normalizedPath = String(path)
    if (isTransactionalStore(this.store)) {
      return this.store.assertFencingTx({ path: normalizedPath, owner, fencingToken, now })
    }
    const lock = this.locks.get(normalizedPath)
    const seqToken = this.sequences.get(`lock:${normalizedPath}`) ?? 0
    const lastWriteToken = this.lastWriteTokens.get(normalizedPath) ?? 0
    if (!lock) {
      return {
        ok: false,
        code: seqToken > 0 ? 'EXPIRED_LEASE' : 'MISSING_LEASE',
        error:
          seqToken > 0
            ? `lease for ${normalizedPath} is no longer active`
            : `no active lease for ${normalizedPath}`,
        expectedToken: seqToken > 0 ? seqToken : undefined,
        providedToken: fencingToken,
      }
    }
    if (lock.expiresAt <= now) {
      return {
        ok: false,
        code: 'EXPIRED_LEASE',
        error: `lease for ${normalizedPath} held by ${lock.owner} has expired`,
        holder: lock.owner,
        expectedToken: lock.fencingToken,
        providedToken: fencingToken,
      }
    }
    if (lock.owner !== owner) {
      return {
        ok: false,
        code: 'HOLDER_MISMATCH',
        error: `file ${normalizedPath} lease is held by ${lock.owner}, not ${owner}`,
        holder: lock.owner,
        expectedToken: lock.fencingToken,
        providedToken: fencingToken,
      }
    }
    if (lock.fencingToken !== fencingToken || fencingToken < lastWriteToken) {
      return {
        ok: false,
        code: 'STALE_FENCING_TOKEN',
        error: `stale fencing token ${fencingToken} for ${normalizedPath}`,
        holder: lock.owner,
        expectedToken: Math.max(lock.fencingToken ?? 0, lastWriteToken),
        providedToken: fencingToken,
      }
    }
    return { ok: true }
  }

  /**
   * Record a write at the write boundary.
   * When a `fencingToken` or `requireFencing` is supplied (or hub-wide
   * `requireFencingOnWrites` is enabled), enforces active lease + monotonic
   * fencing token; otherwise blocks writes conflicting with another holder's live lease.
   */
  recordWrite(
    path: string,
    hash: string,
    owner: string,
    nowOrOpts:
      | number
      | { now?: number; fencingToken?: number; requireFencing?: boolean } = Date.now(),
  ): FileWrite {
    const now = typeof nowOrOpts === 'number' ? nowOrOpts : (nowOrOpts.now ?? Date.now())
    const fencingToken = typeof nowOrOpts === 'number' ? undefined : nowOrOpts.fencingToken
    const requireFencing =
      (typeof nowOrOpts === 'number' ? false : Boolean(nowOrOpts.requireFencing)) ||
      this.requireFencingOnWrites
    const normalizedPath = String(path)

    if (isTransactionalStore(this.store)) {
      return this.store.recordWriteTx({
        path: normalizedPath,
        hash,
        owner,
        fencingToken,
        requireFencing,
        now,
      })
    }

    const strict = fencingToken !== undefined || requireFencing
    const lock = this.locks.get(normalizedPath)
    const lastWriteToken = this.lastWriteTokens.get(normalizedPath) ?? 0
    if (strict) {
      if (fencingToken === undefined) {
        throw new FencingTokenError(`fencing token required to write ${normalizedPath}`, {
          code: 'MISSING_LEASE',
          path: normalizedPath,
          holder: lock?.owner,
          expectedToken: lock?.fencingToken,
        })
      }
      const check = this.assertValidFencingToken(normalizedPath, owner, fencingToken, now)
      if (!check.ok) {
        throw new FencingTokenError(check.error ?? 'invalid fencing token', {
          code: check.code ?? 'STALE_FENCING_TOKEN',
          path: normalizedPath,
          holder: check.holder,
          expectedToken: check.expectedToken,
          providedToken: fencingToken,
        })
      }
    } else if (lock && lock.expiresAt > now && lock.owner !== owner) {
      throw new FencingTokenError(`file ${normalizedPath} is actively locked by ${lock.owner}`, {
        code: 'HOLDER_MISMATCH',
        path: normalizedPath,
        holder: lock.owner,
        expectedToken: lock.fencingToken,
      })
    }

    const effectiveToken =
      fencingToken ??
      (lock && lock.expiresAt > now && lock.owner === owner
        ? Math.max(lock.fencingToken ?? 0, lastWriteToken)
        : lastWriteToken)
    if (effectiveToken > 0) {
      this.lastWriteTokens.set(normalizedPath, Math.max(lastWriteToken, effectiveToken))
    }

    const w: FileWrite = {
      path: normalizedPath,
      hash: String(hash).slice(0, 64),
      owner,
      at: now,
      fencingToken: effectiveToken > 0 ? effectiveToken : undefined,
    }
    this.writes.set(w.path, w)
    this.persistSave('write', w.path, w, null)
    return w
  }

  /** Strict fenced write helper — always requires and verifies `fencingToken`. */
  recordFencedWrite(input: {
    path: string
    hash: string
    owner: string
    fencingToken: number
    now?: number
  }): FileWrite {
    return this.recordWrite(input.path, input.hash, input.owner, {
      now: input.now,
      fencingToken: input.fencingToken,
      requireFencing: true,
    })
  }

  /** Check a prospective patch: does its base still match the last write? */
  patchConflicts(
    path: string,
    baseHash: string,
    owner: string,
  ): { stale: boolean; conflicts: Conflict[] } {
    if (isTransactionalStore(this.store)) {
      return this.store.patchConflictsTx(String(path), baseHash, owner)
    }
    const last = this.writes.get(String(path))
    if (!last) return { stale: false, conflicts: [] }
    if (last.hash === String(baseHash).slice(0, 64)) return { stale: false, conflicts: [] }
    return {
      stale: true,
      conflicts: [
        {
          kind: 'stale-base',
          path,
          holder: last.owner,
          detail: `patch base ${String(baseHash).slice(0, 12)} is stale — ${last.owner} wrote ${last.hash.slice(0, 12)} since (requested by ${owner})`,
        },
      ],
    }
  }

  /**
   * Transaction boundaries: atomically acquire all file locks (all-or-nothing)
   * inside a single SQLite `BEGIN IMMEDIATE` when backed by SQLite.
   */
  beginTransaction(
    owner: string,
    paths: string[],
    taskIds: string[] = [],
    now = Date.now(),
  ): { ok: boolean; txId?: string; tokens?: Record<string, number>; conflicts: Conflict[] } {
    let locked: string[]
    let tokens: Record<string, number>
    let conflicts: Conflict[]
    if (isTransactionalStore(this.store)) {
      const res = this.store.lockFilesTx({
        owner,
        paths,
        ttlMs: this.lockTtlMs,
        now,
        allOrNothing: true,
      })
      locked = res.locked
      tokens = res.tokens
      conflicts = res.conflicts
    } else {
      const res = this.lockFiles(owner, paths, { now })
      locked = res.locked
      tokens = res.tokens
      conflicts = res.conflicts
      if (conflicts.length > 0) {
        this.unlockFiles(owner, locked, now)
      }
    }
    if (conflicts.length > 0) {
      return { ok: false, conflicts }
    }
    const txId = `tx_${fileHashOf(`${owner}:${paths.join(',')}:${now}:${Math.random()}`)}`
    this.transactions.set(txId, {
      owner,
      lockPaths: locked,
      lockTokens: tokens,
      taskIds: [...taskIds],
      at: now,
    })
    return { ok: true, txId, tokens, conflicts: [] }
  }

  commit(txId: string, owner: string, now = Date.now()): { ok: boolean; error?: string } {
    this.sweep(now)
    const tx = this.transactions.get(txId)
    if (!tx) return { ok: false, error: 'no such transaction' }
    if (tx.owner !== owner) return { ok: false, error: `owned by ${tx.owner}` }
    this.transactions.delete(txId)
    return { ok: true }
  }

  abort(txId: string, owner: string, now = Date.now()): { ok: boolean; error?: string } {
    this.sweep(now)
    const tx = this.transactions.get(txId)
    if (!tx) return { ok: false, error: 'no such transaction' }
    if (tx.owner !== owner) return { ok: false, error: `owned by ${tx.owner}` }
    this.transactions.delete(txId)
    this.unlockFiles(owner, tx.lockPaths, { now, fencingTokens: tx.lockTokens })
    return { ok: true }
  }

  /** Shared mission state across processes/connections. */
  status(now = Date.now()): {
    claims: TaskClaim[]
    locks: FileLock[]
    lastWrites: FileWrite[]
    activeTransactions: number
  } {
    if (isTransactionalStore(this.store)) {
      const txStatus = this.store.statusTx(now)
      return {
        ...txStatus,
        activeTransactions: this.transactions.size,
      }
    }
    this.sweep(now)
    return {
      claims: [...this.claims.values()].filter((c) => c.status === 'claimed'),
      locks: [...this.locks.values()],
      lastWrites: [...this.writes.values()].sort((a, b) => b.at - a.at).slice(0, 50),
      activeTransactions: this.transactions.size,
    }
  }

  private liveClaimForFile(path: string, excludeOwner: string, now: number): TaskClaim | null {
    for (const claim of this.claims.values()) {
      if (claim.status !== 'claimed') continue
      if (claim.owner === excludeOwner) continue
      if (claim.expiresAt <= now) continue
      if (claim.files.includes(path)) return claim
    }
    return null
  }
}
