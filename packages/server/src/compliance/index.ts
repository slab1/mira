/**
 * Compliance retention + violation reporting (P3.5).
 *
 * Two concerns over the audit evidence base (`audit_entries`):
 *
 *  1. **Retention** — the table was append-only and unbounded: no purge, no
 *     prune, no cap (scripts/gc-db.ts covers sessions and snapshots only). This
 *     module deletes rows past a retention window and enforces an optional
 *     row cap, returning what it removed so callers can report it.
 *
 *  2. **Violation reporting** — a violation is a row whose decision is
 *     'deny' or 'warn'. `reason` is free text, but every producer prefixes it
 *     (`bash `, `patch `, `task `, `mcp `, `webfetch `, `guardrail error:`), so
 *     rows are classified into a stable category taxonomy from that prefix.
 *
 *     Counting caveat, surfaced in the report rather than hidden: each tool call
 *     logs twice (guardrail pre-check + post-execution result in
 *     tools/registry.ts), so raw row counts overstate events ~2×. The report
 *     therefore exposes both `rows` and distinct `events` (session+tool+reason).
 */
import type { MiraDB } from '../storage/db.js'
import { getConfig } from '../config/store.js'

/** Default retention window. 0 disables age-based deletion. */
export const DEFAULT_RETENTION_DAYS = 90
export const DEFAULT_MAX_ROWS = 100_000

/**
 * Auto-rollback on FAILED_VERIFICATION — OFF by default.
 *
 * When on, a run whose verification state settles as FAILED has its file
 * mutations reverted automatically. Default is off deliberately: verification
 * is evidence-based (exit codes from diagnose/bash), so a false negative would
 * discard legitimate work. Snapshots make the revert recoverable, but silently
 * un-writing files behind the operator's back is not a safe default — opt in
 * with `compliance.autoRollback: true` or MIRA_AUTO_ROLLBACK=1.
 */
export function autoRollbackEnabled(): boolean {
  try {
    const cfg = getConfig().compliance
    if (typeof cfg?.autoRollback === 'boolean') return cfg.autoRollback
  } catch {}
  const env = process.env.MIRA_AUTO_ROLLBACK?.trim().toLowerCase()
  if (env === '1' || env === 'true' || env === 'yes' || env === 'on') return true
  if (env === '0' || env === 'false' || env === 'no' || env === 'off') return false
  return false
}

/**
 * Revert every file mutation recorded for a session, restoring each file to its
 * pre-run state (or deleting it when it did not exist before).
 *
 * Files only — conversation messages are preserved, so a rolled-back agent run
 * keeps the context that explains what it was attempting. Snapshot rows for the
 * session are consumed as they are applied.
 */
export async function rollbackSessionMutations(
  db: MiraDB,
  sessionID: string,
): Promise<{ files: string[]; deleted: string[] }> {
  const sqlite = db.sqlite
  const out = { files: [] as string[], deleted: [] as string[] }
  if (!sqlite || !sessionID) return out
  try {
    const rows = sqlite
      .prepare(
        `SELECT path, content FROM file_snapshots WHERE session_id = ?
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(sessionID) as Array<{ path: string; content: string | null }>
    if (rows.length === 0) return out

    const { mkdirSync, writeFileSync, unlinkSync, existsSync } = await import('node:fs')
    const { dirname } = await import('node:path')
    for (const row of rows) {
      try {
        if (row.content === null) {
          // Created by the run → remove it again
          if (row.path && existsSync(row.path)) {
            unlinkSync(row.path)
            out.deleted.push(row.path)
          }
        } else if (row.path) {
          mkdirSync(dirname(row.path), { recursive: true })
          writeFileSync(row.path, row.content, 'utf-8')
          out.files.push(row.path)
        }
      } catch (e) {
        console.warn(`[compliance] auto-rollback failed for ${row.path}:`, String(e))
      }
    }
    sqlite.prepare('DELETE FROM file_snapshots WHERE session_id = ?').run(sessionID)
  } catch (e) {
    console.warn('[compliance] auto-rollback failed:', String(e))
  }
  return out
}

export interface RetentionOptions {
  retentionDays?: number
  maxRows?: number
}

export interface RetentionResult {
  deletedByAge: number
  deletedByCap: number
  remaining: number
  cutoff: number | null
}

/** Effective retention window: explicit option > env > default. */
export function resolveRetentionDays(opts: RetentionOptions = {}): number {
  if (typeof opts.retentionDays === 'number' && Number.isFinite(opts.retentionDays))
    return Math.max(0, Math.floor(opts.retentionDays))
  const env = Number(process.env.MIRA_COMPLIANCE_RETENTION_DAYS)
  if (Number.isFinite(env) && env >= 0) return Math.floor(env)
  return DEFAULT_RETENTION_DAYS
}

/**
 * Delete audit rows older than the retention window, then trim to maxRows
 * (oldest first). maxRows=0 disables the cap. Never throws.
 */
export async function applyRetention(
  db: MiraDB,
  opts: RetentionOptions = {},
): Promise<RetentionResult> {
  const retentionDays = resolveRetentionDays(opts)
  const maxRows =
    typeof opts.maxRows === 'number' && Number.isFinite(opts.maxRows)
      ? Math.max(0, Math.floor(opts.maxRows))
      : DEFAULT_MAX_ROWS
  const result: RetentionResult = {
    deletedByAge: 0,
    deletedByCap: 0,
    remaining: 0,
    cutoff: null,
  }
  try {
    if (retentionDays > 0) {
      const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
      result.cutoff = cutoff
      const del = db.sqlite.prepare('DELETE FROM audit_entries WHERE created_at < ?').run(cutoff)
      result.deletedByAge = Number(del?.changes ?? 0)
    }
    if (maxRows > 0) {
      const row = db.sqlite.prepare('SELECT COUNT(*) AS c FROM audit_entries').get() as
        { c: number } | undefined
      const total = row?.c ?? 0
      if (total > maxRows) {
        // Keep the newest maxRows; delete the oldest overflow in one pass.
        const overflow = total - maxRows
        const del = db.sqlite
          .prepare(
            `DELETE FROM audit_entries WHERE id IN (
               SELECT id FROM audit_entries ORDER BY created_at ASC LIMIT ?
             )`,
          )
          .run(overflow)
        result.deletedByCap = Number(del?.changes ?? 0)
      }
    }
    const after = db.sqlite.prepare('SELECT COUNT(*) AS c FROM audit_entries').get() as
      { c: number } | undefined
    result.remaining = after?.c ?? 0
  } catch (e) {
    console.warn('[compliance] retention sweep failed:', String(e))
  }
  return result
}

// ── Violation reporting ────────────────────────────────────────────────

export type ViolationCategory =
  'path' | 'command' | 'patch' | 'task' | 'mcp' | 'webfetch' | 'guardrail-error' | 'other'

/** Classify a free-text reason into a stable category from its prefix. */
export function classifyViolation(reason: string | null | undefined): ViolationCategory {
  const r = (reason ?? '').toLowerCase()
  if (r.startsWith('guardrail error')) return 'guardrail-error'
  if (r.startsWith('bash ') || r.includes('command')) return 'command'
  if (r.startsWith('patch ')) return 'patch'
  if (r.startsWith('task ')) return 'task'
  if (r.startsWith('mcp')) return 'mcp'
  if (r.startsWith('webfetch ')) return 'webfetch'
  if (r.includes('path') || r.includes('root')) return 'path'
  return 'other'
}

export interface ViolationBucket {
  category: ViolationCategory
  rows: number
  /** Distinct (session, tool, reason) tuples — de-duplicates the double audit row per call. */
  events: number
  tools: string[]
}

export interface ViolationReport {
  since: number
  until: number
  totalRows: number
  totalEvents: number
  byCategory: ViolationBucket[]
  byTool: Array<{ tool: string; rows: number }>
  /** Audit rows whose session could not be scoped (no session_id, or session deleted). */
  unscopedRows: number
  /** Rows scoped via denormalized attribution because the session is gone (P3.5). */
  tombstonedRows: number
}

/** Session → org resolver (may be async — the live cache fills lazily). */
export type SessionOrgResolver = (
  sessionID: string,
) => string | null | undefined | Promise<string | null | undefined>

/**
 * Build a policy-violation report over a window.
 * `sessionOrg` maps a session id to its org id (or null/undefined when unknown);
 * when provided, the report is restricted to that org's sessions.
 */
export async function buildViolationReport(
  db: MiraDB,
  opts: {
    sinceDays?: number
    until?: number
    sessionOrg?: SessionOrgResolver
    orgID?: string
    limit?: number
  } = {},
): Promise<ViolationReport> {
  const until = opts.until ?? Date.now()
  const sinceDays = Math.max(1, Math.floor(opts.sinceDays ?? 30))
  const since = until - sinceDays * 24 * 60 * 60 * 1000
  const limit = Math.min(50_000, Math.max(1, Math.floor(opts.limit ?? 10_000)))
  const report: ViolationReport = {
    since,
    until,
    totalRows: 0,
    totalEvents: 0,
    byCategory: [],
    byTool: [],
    unscopedRows: 0,
    tombstonedRows: 0,
  }
  try {
    let rows = db.sqlite
      .prepare(
        `SELECT session_id, tool, decision, reason, created_at, org_id, owner_id FROM audit_entries
         WHERE decision IN ('deny','warn') AND created_at >= ? AND created_at <= ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(since, until, limit) as Array<{
      session_id: string | null
      tool: string
      decision: string
      reason: string | null
      created_at: number
      org_id: string | null
      owner_id: string | null
    }>

    if (opts.sessionOrg) {
      const resolver = opts.sessionOrg
      const scoped: Array<(typeof rows)[number]> = []
      for (const r of rows) {
        // Denormalized attribution (stamped when the session was deleted) wins;
        // otherwise resolve the live session → org mapping.
        let org = r.org_id ?? null
        let tombstoned = false
        if (org) {
          // Attributed already: check whether the session is still around.
          const live = r.session_id ? await resolver(r.session_id) : null
          tombstoned = !live
        } else if (r.session_id) {
          org = (await resolver(r.session_id)) ?? null
        }
        if (!org) {
          report.unscopedRows++
          continue
        }
        if (tombstoned) report.tombstonedRows++
        if (opts.orgID === undefined || org === opts.orgID) scoped.push(r)
      }
      rows = scoped
    }

    const catMap = new Map<
      ViolationCategory,
      { rows: number; events: Set<string>; tools: Set<string> }
    >()
    const toolMap = new Map<string, number>()
    const events = new Set<string>()
    for (const r of rows) {
      const cat = classifyViolation(r.reason)
      const bucket = catMap.get(cat) ?? {
        rows: 0,
        events: new Set<string>(),
        tools: new Set<string>(),
      }
      bucket.rows++
      bucket.events.add(`${r.session_id ?? '-'} ${r.tool} ${r.reason ?? ''}`)
      bucket.tools.add(r.tool)
      catMap.set(cat, bucket)
      toolMap.set(r.tool, (toolMap.get(r.tool) ?? 0) + 1)
      events.add(`${r.session_id ?? '-'} ${r.tool} ${r.reason ?? ''}`)
    }
    report.totalRows = rows.length
    report.totalEvents = events.size
    report.byCategory = [...catMap.entries()]
      .map(([category, b]) => ({
        category,
        rows: b.rows,
        events: b.events.size,
        tools: [...b.tools].sort(),
      }))
      .sort((a, b) => b.rows - a.rows)
    report.byTool = [...toolMap.entries()]
      .map(([tool, rows]) => ({ tool, rows }))
      .sort((a, b) => b.rows - a.rows || a.tool.localeCompare(b.tool))
      .slice(0, 25)
  } catch (e) {
    console.warn('[compliance] violation report failed:', String(e))
  }
  return report
}
