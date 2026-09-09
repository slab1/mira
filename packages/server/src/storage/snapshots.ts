/**
 * File Snapshots — undo/rewind for agent file mutations
 *
 * Every mutating tool call (edit/write/patch) snapshots the target file
 * BEFORE the mutation lands. Revert restores content; if the file did not
 * exist pre-mutation (content: null), revert deletes it.
 *
 * Mira-parity safety net: no agent edit is unrecoverable.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import type { JsonValue } from '../types/index.js'
import { dirname } from 'node:path'

export interface Snapshot extends Record<string, JsonValue> {
  id: string
  sessionID: string
  messageID: string | null
  path: string
  existedBefore: boolean
  createdAt: number
}

/** Raw file_snapshots row as returned by bun:sqlite (snake_case columns). */
interface SnapshotRow {
  id: string
  session_id: string
  message_id?: string | null
  path: string
  content?: string | null
  created_at: number
}

/** Snapshot a file's current content before a mutation. No-op if path missing entirely. */
import type { MiraDB } from './db.js'

export function snapshotFile(
  db: MiraDB,
  opts: { sessionID: string; messageID?: string; path: string },
): Snapshot | null {
  const sqlite = db.sqlite
  if (!sqlite || !opts.path) return null
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS file_snapshots (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      message_id TEXT,
      path TEXT NOT NULL,
      content TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS file_snapshots_session_idx ON file_snapshots(session_id);
  `)
  const existed = existsSync(opts.path)
  let content: string | null = null
  if (existed) {
    try {
      content = readFileSync(opts.path, 'utf-8')
    } catch {
      return null
    }
  }
  const snap: Snapshot = {
    id: `snap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    sessionID: opts.sessionID,
    messageID: opts.messageID ?? null,
    path: opts.path,
    existedBefore: existed,
    createdAt: Date.now(),
  }
  sqlite
    .prepare(
      `INSERT INTO file_snapshots (id, session_id, message_id, path, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(snap.id, snap.sessionID, snap.messageID, snap.path, content, snap.createdAt)
  return snap
}

/** Outcome of a rewind: restored files + truncated message count. */
export interface RevertOutcome {
  reverted: Snapshot[]
  messagesDeleted: number
}

/** A message's position in conversation order — (created_at, rowid) is the stable sort key. */
interface MessageBoundary {
  created_at: number
  rowid: number
}

/** Resolve a message's conversation-order position, or null if it doesn't exist. */
function messageBoundary(db: MiraDB, sessionID: string, messageID: string): MessageBoundary | null {
  const row = db.sqlite
    .prepare(`SELECT created_at, rowid FROM messages WHERE id = ? AND session_id = ?`)
    .get(messageID, sessionID) as { created_at: number; rowid: number } | undefined
  return row ? { created_at: row.created_at, rowid: row.rowid } : null
}

/**
 * Delete a session's messages at/after a conversation-order boundary
 * (parts cascade via FK). Uses row-value comparison so a message sharing the
 * boundary's millisecond but earlier in conversation order is NOT over-deleted.
 */
function deleteMessagesAtOrAfter(db: MiraDB, sessionID: string, boundary: MessageBoundary): number {
  const res = db.sqlite
    .prepare(`DELETE FROM messages WHERE session_id = ? AND (created_at, rowid) >= (?, ?)`)
    .run(sessionID, boundary.created_at, boundary.rowid)
  return Number((res as { changes?: number }).changes ?? 0)
}

/** Undo the most recent mutation in a session: restore content (or delete if newly created). */
export function revertLast(db: MiraDB, sessionID: string): RevertOutcome {
  const sqlite = db.sqlite
  if (!sqlite) return { reverted: [], messagesDeleted: 0 }
  const row = sqlite
    .prepare(
      `SELECT * FROM file_snapshots WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(sessionID) as SnapshotRow | undefined
  if (!row) return { reverted: [], messagesDeleted: 0 }

  restoreRow(row)

  // Scope deletion to the snapshot's message and everything after it in
  // conversation order — NOT a raw created_at cutoff (which would delete
  // unrelated user messages sent after the snapshot was taken).
  const boundary: MessageBoundary = (row.message_id &&
    messageBoundary(db, sessionID, row.message_id)) || {
    created_at: row.created_at,
    rowid: 0,
  }

  sqlite.exec('BEGIN')
  try {
    sqlite.prepare(`DELETE FROM file_snapshots WHERE id = ?`).run(row.id)
    const messagesDeleted = deleteMessagesAtOrAfter(db, sessionID, boundary)
    sqlite.exec('COMMIT')
    return { reverted: [rowToSnapshot(row)], messagesDeleted }
  } catch (e) {
    sqlite.exec('ROLLBACK')
    throw e
  }
}

/** Rewind to a message boundary: revert every snapshot tied to that message or later ones. */
export function revertToMessage(db: MiraDB, sessionID: string, messageID: string): RevertOutcome {
  const sqlite = db.sqlite
  if (!sqlite) return { reverted: [], messagesDeleted: 0 }
  const target = messageBoundary(db, sessionID, messageID)
  if (!target) throw new Error(`message ${messageID} not found in session ${sessionID}`)

  // Message IDs at/after the boundary (conversation order), then matching snapshots
  const msgIds: string[] = sqlite
    .prepare(
      `SELECT id FROM messages WHERE session_id = ? AND (created_at, rowid) >= (?, ?) ORDER BY created_at, rowid`,
    )
    .all(sessionID, target.created_at, target.rowid)
    .map((r) => (r as { id: string }).id)

  const restored: Snapshot[] = []
  sqlite.exec('BEGIN')
  try {
    for (const mid of msgIds) {
      const rows = sqlite
        .prepare(
          `SELECT * FROM file_snapshots WHERE session_id = ? AND message_id = ? ORDER BY created_at DESC, rowid DESC`,
        )
        .all(sessionID, mid) as SnapshotRow[]
      for (const row of rows) {
        restoreRow(row)
        sqlite.prepare(`DELETE FROM file_snapshots WHERE id = ?`).run(row.id)
        restored.push(rowToSnapshot(row))
      }
    }
    const messagesDeleted = deleteMessagesAtOrAfter(db, sessionID, target)
    sqlite.exec('COMMIT')
    return { reverted: restored, messagesDeleted }
  } catch (e) {
    sqlite.exec('ROLLBACK')
    throw e
  }
}

function listAll(db: MiraDB, sessionID: string, limit = 50): Snapshot[] {
  const rows = (db.sqlite
    ?.prepare(
      `SELECT id, session_id, message_id, path, content IS NOT NULL AS had_content, created_at FROM file_snapshots WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(sessionID, limit) ?? []) as Array<{
    id: string
    session_id: string
    message_id?: string | null
    path: string
    had_content: number
    created_at: number
  }>
  return rows.map((r) => ({
    id: r.id,
    sessionID: r.session_id,
    messageID: r.message_id ?? null,
    path: r.path,
    existedBefore: !!r.had_content,
    createdAt: r.created_at,
  }))
}

export function getSnapshotContent(
  db: MiraDB,
  snapshotID: string,
  sessionID?: string,
): { path: string; content: string | null; existedBefore: boolean } | null {
  const sqlite = db.sqlite
  if (!sqlite) return null
  const row = (
    sessionID
      ? sqlite
          .prepare(
            `SELECT path, content, content IS NOT NULL AS had_content FROM file_snapshots WHERE id = ? AND session_id = ?`,
          )
          .get(snapshotID, sessionID)
      : sqlite
          .prepare(
            `SELECT path, content, content IS NOT NULL AS had_content FROM file_snapshots WHERE id = ?`,
          )
          .get(snapshotID)
  ) as { path: string; content: string | null; had_content: number } | undefined
  if (!row) return null
  return { path: row.path, content: row.content, existedBefore: !!row.had_content }
}

export { listAll as listSnapshots }

// ── Internals ──────────────────────────────────────────────────────

function restoreRow(row: SnapshotRow): void {
  const path: string = row.path ?? ''
  const content: string | null = row.content ?? null
  if (row.content === null) {
    // File was created by the agent — remove it
    if (path) {
      try {
        unlinkSync(path)
      } catch {}
    }
  } else {
    if (path) {
      try {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, content ?? '', 'utf-8')
      } catch {}
    }
  }
}

function rowToSnapshot(row: SnapshotRow): Snapshot {
  return {
    id: row.id,
    sessionID: row.session_id,
    messageID: row.message_id ?? null,
    path: row.path,
    existedBefore: row.content !== null,
    createdAt: row.created_at,
  }
}
