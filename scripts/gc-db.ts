#!/usr/bin/env bun
/**
 * GC — prune old sessions + snapshot cap (2.7GB device guard)
 * - Sessions older than 30d (updated_at) → DELETE (CASCADE wipes messages/parts/todos/jobs/snapshots)
 * - Snapshots older than 14d → DELETE
 * - Per-session cap: keep last 50 snapshots → DELETE excess (oldest first)
 * - VACUUM if anything deleted (reclaim file)
 *
 * Run: bun scripts/gc-db.ts  or  bash scripts/gc-db.sh (wrapper)
 * Watchdog calls it weekly (10080 cycles). No-op when DB missing.
 */
import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

const MIRA_DIR = process.env.MIRA_DIR ?? `${process.env.HOME ?? "/root"}/.mira`
const DB_PATH = process.env.MIRA_DB ?? `${MIRA_DIR}/data/mira.db`

try { mkdirSync(dirname(DB_PATH), { recursive: true }) } catch {}

let sqlite: Database
try {
  sqlite = new Database(DB_PATH)
} catch {
  console.log(`[gc] no DB at ${DB_PATH} — skip`)
  process.exit(0)
}

sqlite.exec("PRAGMA foreign_keys = ON;")

const now = Date.now()
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000
const SNAPSHOT_TTL_MS = 14 * 24 * 3600 * 1000
const SNAPSHOT_CAP = 50

let totalDeleted = 0

// 1) Old sessions
try {
  const cutoff = now - SESSION_TTL_MS
  const res = sqlite.prepare(`DELETE FROM sessions WHERE updated_at < ?`).run(cutoff)
  const n = (res as unknown as { changes: number }).changes ?? 0
  if (n) {
    console.log(`[gc] deleted ${n} sessions older than 30d`)
    totalDeleted += n
  }
} catch (e) {
  console.warn("[gc] sessions prune:", String(e))
}

// 2) Old snapshots (by age)
try {
  const cutoff = now - SNAPSHOT_TTL_MS
  const res = sqlite.prepare(`DELETE FROM file_snapshots WHERE created_at < ?`).run(cutoff)
  const n = (res as unknown as { changes: number }).changes ?? 0
  if (n) {
    console.log(`[gc] deleted ${n} snapshots older than 14d`)
    totalDeleted += n
  }
} catch {}

// 3) Per-session cap (keep last 50)
try {
  const ids: { session_id: string }[] = sqlite.prepare(`SELECT DISTINCT session_id FROM file_snapshots`).all() as never as { session_id: string }[]
  for (const { session_id } of ids) {
    const rows: { id: string }[] = sqlite
      .prepare(`SELECT id FROM file_snapshots WHERE session_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?`)
      .all(session_id, SNAPSHOT_CAP) as never as { id: string }[]
    if (rows.length === 0) continue
    const toDelete = rows.map(r => r.id)
    // chunk to avoid SQLITE_MAX_VARIABLE_NUMBER
    for (let i = 0; i < toDelete.length; i += 900) {
      const chunk = toDelete.slice(i, i + 900)
      const placeholders = chunk.map(() => "?").join(",")
      const res = sqlite.prepare(`DELETE FROM file_snapshots WHERE id IN (${placeholders})`).run(...chunk)
      const n = (res as unknown as { changes: number }).changes ?? 0
      totalDeleted += n
    }
    if (toDelete.length) console.log(`[gc] capped ${session_id.slice(0, 8)}: deleted ${toDelete.length} excess snapshots (keep ${SNAPSHOT_CAP})`)
  }
} catch (e) {
  console.warn("[gc] snapshot cap:", String(e))
}

if (totalDeleted > 0) {
  try {
    sqlite.exec("VACUUM;")
    console.log(`[gc] VACUUM done — total deleted ${totalDeleted}`)
  } catch (e) {
    console.warn("[gc] VACUUM:", String(e))
  }
} else {
  console.log("[gc] nothing to prune")
}

sqlite.close()
