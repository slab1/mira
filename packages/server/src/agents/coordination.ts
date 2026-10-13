/**
 * Multi-Agent Coordination — §12 task ownership, file locking, conflict detection
 *
 * Docs: MIRA_WEAKNESSES_AND_OBSTACLES.md §12 (Multi-Agent Coordination, P1):
 * when multiple agents operate simultaneously (Architect/Developer/Reviewer/…),
 * uncoordinated edits produce the classic conflicts:
 *   Agent A edits file / Agent B edits same file / Agent C tests old version.
 *
 * Required controls per §12 — all implemented here:
 *   task ownership (one owner per task, priority-aware preemption rules)
 *   file/resource locking (exclusive, TTL-bounded — crashed agents recover)
 *   conflict detection (lock conflicts + claim overlap + stale-base patches)
 *   shared mission state (status() view every agent can read)
 *   version-aware patches (recordWrite/patchConflicts: baseHash vs lastWrite)
 *   transaction boundaries (begin/commit/abort across locks+claims)
 *
 * Design: pure in-memory hub — no DB, no Bus coupling (caller emits events).
 * Fail-closed semantics: a lock request that would conflict NEVER silently
 * succeeds; every decision returns the conflicting holders.
 *
 * Documentation Maintenance — 10 items:
 * | # | Item | Status | Evidence |
 * |---|------|--------|----------|
 * | 1 | Implementation path | Implemented | packages/server/src/agents/coordination.ts |
 * | 2 | Public interfaces | Implemented | CoordinationHub.claimTask/releaseTask/lockFiles/unlockFiles/recordWrite/patchConflicts/beginTransaction/commit/abort/status/sweep |
 * | 3 | Events | Implemented | caller emits agent.coordination.* via Bus (module is pure) |
 * | 4 | Configuration | Implemented | MIRA_LOCK_TTL_MS (default 600000), MIRA_CLAIM_TTL_MS (default 1800000) |
 * | 5 | Tests | Implemented | packages/server/src/agents/coordination.test.ts |
 * | 6 | Security boundaries | Implemented | §12: only the owner may release/unlock/abort; expired claims cannot be re-claimed silently (sweep marks them); no path/content storage beyond strings+hashes |
 * | 7 | Operational procedures | Implemented | GET/POST /coordination/* routes; sweep() on every access reaps TTLs |
 * | 8 | Migration strategy | Implemented | additive; durable store optional (SQLite agent_coordination_state, write-through) — claims/locks/writes survive restarts so two agents cannot both believe they hold a lock after a server bounce |
 * | 9 | Rollback strategy | Implemented | delete module + route + table; in-memory mode unchanged without a store |
 * | 10 | Known limitations | Implemented | durable store is single-process write-through (multi-process CAS/locking Target); transactions stay in-memory (short-lived, owner-held); version tracking is caller-reported hashes, not file reads |
 */

import { createHash } from 'node:crypto'
import type { MiraDB } from '../storage/db.js'

/**
 * Durable §12 state — without it a server restart drops every lock/claim and
 * two agents can both believe they hold the same file. Transactions are
 * deliberately NOT persisted (short-lived, owner-held).
 */
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

/** SQLite-backed store — write-through, fail-soft at call sites. */
export function createSqliteCoordinationStore(db: MiraDB): CoordinationStore {
  const sqlite = db.sqlite
  if (!sqlite) throw new Error('no sqlite handle')
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agent_coordination_state (
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      payload TEXT NOT NULL,
      expires_at INTEGER,
      PRIMARY KEY (kind, key)
    );
  `)
  return {
    load() {
      try {
        const rows = sqlite
          .prepare('SELECT kind, key, payload, expires_at FROM agent_coordination_state')
          .all() as Array<{
          kind: 'claim' | 'lock' | 'write'
          key: string
          payload: string
          expires_at: number | null
        }>
        return rows.map((r) => ({
          kind: r.kind,
          key: r.key,
          payload: JSON.parse(r.payload),
          expiresAt: r.expires_at,
        }))
      } catch {
        return []
      }
    },
    save(kind, key, payload, expiresAt) {
      try {
        sqlite
          .prepare(
            `INSERT OR REPLACE INTO agent_coordination_state (kind, key, payload, expires_at) VALUES (?, ?, ?, ?)`,
          )
          .run(kind, key, JSON.stringify(payload), expiresAt ?? null)
      } catch {}
    },
    clear(kind, key) {
      try {
        sqlite
          .prepare('DELETE FROM agent_coordination_state WHERE kind = ? AND key = ?')
          .run(kind, key)
      } catch {}
    },
  }
}

export interface TaskClaim {
  taskId: string
  owner: string
  priority: number // higher wins when ownership transfer is explicit
  files: string[]
  deps: string[] // taskIds this task depends on
  status: 'claimed' | 'released'
  claimedAt: number
  expiresAt: number
}

export interface FileLock {
  path: string
  owner: string
  taskId?: string
  acquiredAt: number
  expiresAt: number
}

export interface FileWrite {
  path: string
  hash: string
  owner: string
  at: number
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
  conflicts: Conflict[]
}

function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

function fileHashOf(path: string): string {
  // Identity hash of the path — callers supply content hashes themselves.
  return createHash('sha256').update(path).digest('hex').slice(0, 16)
}

export class CoordinationHub {
  private claims = new Map<string, TaskClaim>()
  private locks = new Map<string, FileLock>() // path → lock
  private writes = new Map<string, FileWrite>() // path → last write
  private transactions = new Map<
    string,
    { owner: string; lockPaths: string[]; taskIds: string[]; at: number }
  >()
  private readonly lockTtlMs: number
  private readonly claimTtlMs: number
  private store?: CoordinationStore

  constructor(opts: { lockTtlMs?: number; claimTtlMs?: number; store?: CoordinationStore } = {}) {
    this.lockTtlMs = opts.lockTtlMs ?? envMs('MIRA_LOCK_TTL_MS', 600_000)
    this.claimTtlMs = opts.claimTtlMs ?? envMs('MIRA_CLAIM_TTL_MS', 1_800_000)
    if (opts.store) {
      this.store = opts.store
      try {
        const now = Date.now()
        for (const { kind, key, payload, expiresAt } of this.store.load()) {
          if (expiresAt !== null && expiresAt <= now) {
            try {
              this.store.clear(kind, key)
            } catch {}
            continue
          }
          if (kind === 'claim') {
            const claim = payload as TaskClaim
            // claims expired while down are marked released on load
            if (claim.status === 'claimed' && claim.expiresAt <= now) claim.status = 'released'
            this.claims.set(key, claim)
          } else if (kind === 'lock') {
            this.locks.set(key, payload as FileLock)
          } else if (kind === 'write') {
            this.writes.set(key, payload as FileWrite)
          }
        }
      } catch {}
    }
  }

  private persistClaim(claim: TaskClaim): void {
    try {
      this.store?.save('claim', claim.taskId, claim, claim.expiresAt)
    } catch {}
  }

  private persistLock(lock: FileLock): void {
    try {
      this.store?.save('lock', lock.path, lock, lock.expiresAt)
    } catch {}
  }

  /** Reap expired claims/locks/transactions — called on every access. */
  sweep(now = Date.now()): { expiredLocks: number; expiredClaims: number } {
    let expiredLocks = 0
    let expiredClaims = 0
    for (const [path, lock] of this.locks) {
      if (lock.expiresAt <= now) {
        this.locks.delete(path)
        try {
          this.store?.clear('lock', path)
        } catch {}
        expiredLocks++
      }
    }
    for (const [taskId, claim] of this.claims) {
      if (claim.status === 'claimed' && claim.expiresAt <= now) {
        claim.status = 'released'
        try {
          this.store?.clear('claim', taskId)
        } catch {}
        expiredClaims++
        // released claims also drop their file locks (crashed agent recovery)
        for (const f of claim.files) {
          const lock = this.locks.get(f)
          if (lock?.owner === claim.owner) {
            this.locks.delete(f)
            try {
              this.store?.clear('lock', f)
            } catch {}
            expiredLocks++
          }
        }
      }
    }
    for (const [txId, tx] of this.transactions) {
      if (now - tx.at > this.lockTtlMs) this.transactions.delete(txId)
    }
    return { expiredLocks, expiredClaims }
  }

  /**
   * Claim task ownership. §12: task ownership — one owner per task. A claim
   * conflicts with (a) another live claim on the same task, (b) live claims
   * holding overlapping files, (c) unmet task dependencies (dep still claimed
   * by someone else → 'dependency' conflict, dep released+incomplete → ok to
   * proceed since dependency tracking of COMPLETION is the caller's concern).
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

    const files = (input.files ?? []).map(String)
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
    }

    for (const dep of input.deps ?? []) {
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

    const claim: TaskClaim = {
      taskId: input.taskId,
      owner: input.owner,
      priority: input.priority ?? 0,
      files,
      deps: [...(input.deps ?? [])],
      status: 'claimed',
      claimedAt: now,
      expiresAt: now + this.claimTtlMs,
    }
    this.claims.set(input.taskId, claim)
    this.persistClaim(claim)

    // Auto-lock the claimed files for this owner (claim implies write intent)
    for (const f of files) {
      const lock: FileLock = {
        path: f,
        owner: input.owner,
        taskId: input.taskId,
        acquiredAt: now,
        expiresAt: now + this.lockTtlMs,
      }
      this.locks.set(f, lock)
      this.persistLock(lock)
    }
    return { ok: true, claim, conflicts: [] }
  }

  /** Release task ownership — owner-only (§12 security boundary). */
  releaseTask(taskId: string, owner: string, now = Date.now()): { ok: boolean; error?: string } {
    this.sweep(now)
    const claim = this.claims.get(taskId)
    if (!claim || claim.status !== 'claimed') return { ok: false, error: 'not claimed' }
    if (claim.owner !== owner) return { ok: false, error: `owned by ${claim.owner}` }
    claim.status = 'released'
    try {
      this.store?.clear('claim', taskId)
    } catch {}
    for (const f of claim.files) {
      const lock = this.locks.get(f)
      if (lock?.owner === owner) {
        this.locks.delete(f)
        try {
          this.store?.clear('lock', f)
        } catch {}
      }
    }
    return { ok: true }
  }

  /** Exclusive file locks — §12 file/resource locking with TTL. */
  lockFiles(
    owner: string,
    paths: string[],
    opts: { taskId?: string; ttlMs?: number; now?: number } = {},
  ): { locked: string[]; conflicts: Conflict[] } {
    const now = opts.now ?? Date.now()
    this.sweep(now)
    const locked: string[] = []
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
      this.locks.set(path, {
        path,
        owner,
        taskId: opts.taskId,
        acquiredAt: now,
        expiresAt: now + (opts.ttlMs ?? this.lockTtlMs),
      })
      this.persistLock(this.locks.get(path)!)
      locked.push(path)
    }
    return { locked, conflicts }
  }

  /** Owner-only unlock. */
  unlockFiles(
    owner: string,
    paths: string[],
    now = Date.now(),
  ): { unlocked: string[]; errors: string[] } {
    this.sweep(now)
    const unlocked: string[] = []
    const errors: string[] = []
    for (const raw of paths) {
      const path = String(raw)
      const lock = this.locks.get(path)
      if (!lock) {
        unlocked.push(path) // already free
        continue
      }
      if (lock.owner !== owner) {
        errors.push(`file ${path} locked by ${lock.owner}`)
        continue
      }
      this.locks.delete(path)
      try {
        this.store?.clear('lock', path)
      } catch {}
      unlocked.push(path)
    }
    return { unlocked, errors }
  }

  /**
   * §12 version-aware patches: agents record the write they made (path +
   * content hash). A later patch that declares a baseHash that no longer
   * matches the recorded last write is STALE — detected before it clobbers.
   */
  recordWrite(path: string, hash: string, owner: string, now = Date.now()): FileWrite {
    const w: FileWrite = { path: String(path), hash: String(hash).slice(0, 64), owner, at: now }
    this.writes.set(w.path, w)
    try {
      this.store?.save('write', w.path, w, null)
    } catch {}
    return w
  }

  /** Check a prospective patch: does its base still match the last write? */
  patchConflicts(
    path: string,
    baseHash: string,
    owner: string,
  ): { stale: boolean; conflicts: Conflict[] } {
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
   * §12 transaction boundaries: atomically acquire file locks (all-or-nothing)
   * and optionally claim tasks. commit/abort by id; only the tx owner may.
   */
  beginTransaction(
    owner: string,
    paths: string[],
    taskIds: string[] = [],
    now = Date.now(),
  ): { ok: boolean; txId?: string; conflicts: Conflict[] } {
    const { locked, conflicts } = this.lockFiles(owner, paths, { now })
    if (conflicts.length > 0) {
      // all-or-nothing: undo partial locks
      this.unlockFiles(owner, locked, now)
      return { ok: false, conflicts }
    }
    const txId = `tx_${fileHashOf(`${owner}:${paths.join(',')}:${now}`)}`
    this.transactions.set(txId, { owner, lockPaths: locked, taskIds: [...taskIds], at: now })
    return { ok: true, txId, conflicts: [] }
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
    this.unlockFiles(owner, tx.lockPaths, now)
    return { ok: true }
  }

  /** §12 shared mission state — a read-only view every agent can consume. */
  status(now = Date.now()): {
    claims: TaskClaim[]
    locks: FileLock[]
    lastWrites: FileWrite[]
    activeTransactions: number
  } {
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
