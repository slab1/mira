/**
 * File Snapshots — undo/rewind for agent file mutations
 *
 * Every mutating tool call (edit/write/patch) snapshots the target file
 * BEFORE the mutation lands. Revert restores content; if the file did not
 * exist pre-mutation (content: null), revert deletes it.
 *
 * OpenCode-parity safety net: no agent edit is unrecoverable.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs"
import { dirname } from "node:path"

export interface Snapshot {
  id: string
  sessionID: string
  messageID: string | null
  path: string
  existedBefore: boolean
  createdAt: number
}

/** Snapshot a file's current content before a mutation. No-op if path missing entirely. */
export function snapshotFile(db: any, opts: { sessionID: string; messageID?: string; path: string }): Snapshot | null {
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
    try { content = readFileSync(opts.path, "utf-8") } catch { return null }
  }
  const snap: Snapshot = {
    id: `snap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    sessionID: opts.sessionID,
    messageID: opts.messageID ?? null,
    path: opts.path,
    existedBefore: existed,
    createdAt: Date.now(),
  }
  sqlite.prepare(
    `INSERT INTO file_snapshots (id, session_id, message_id, path, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(snap.id, snap.sessionID, snap.messageID, snap.path, content, snap.createdAt)
  return snap
}

/** Undo the most recent mutation in a session: restore content (or delete if newly created). */
export function revertLast(db: any, sessionID: string): Snapshot | null {
  const sqlite = db.sqlite
  if (!sqlite) return null
  const row: any = sqlite.prepare(
    `SELECT * FROM file_snapshots WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`
  ).get(sessionID)
  if (!row) return null

  restoreRow(row)
  sqlite.prepare(`DELETE FROM file_snapshots WHERE id = ?`).run(row.id)
  return rowToSnapshot(row)
}

/** Rewind to a message boundary: revert every snapshot tied to that message or later ones. */
export function revertToMessage(db: any, sessionID: string, messageID: string): Snapshot[] {
  const sqlite = db.sqlite
  if (!sqlite) return []
  const target: any = sqlite.prepare(`SELECT id FROM messages WHERE id = ? AND session_id = ?`).get(messageID, sessionID)
  if (!target) throw new Error(`message ${messageID} not found in session ${sessionID}`)

  // Message IDs at/after the boundary (conversation order), then matching snapshots
  const msgIds: string[] = sqlite.prepare(
    `SELECT id FROM messages WHERE session_id = ? AND created_at >= (SELECT created_at FROM messages WHERE id = ?) ORDER BY created_at, rowid`
  ).all(sessionID, messageID).map((r: any) => r.id)

  const restored: Snapshot[] = []
  for (const mid of msgIds) {
    const rows: any[] = sqlite.prepare(
      `SELECT * FROM file_snapshots WHERE session_id = ? AND message_id = ? ORDER BY created_at DESC, rowid DESC`
    ).all(sessionID, mid)
    for (const row of rows) {
      restoreRow(row)
      sqlite.prepare(`DELETE FROM file_snapshots WHERE id = ?`).run(row.id)
      restored.push(rowToSnapshot(row))
    }
  }
  return restored
}

function listAll(db: any, sessionID: string, limit = 50): Snapshot[] {
  const rows: any[] = db.sqlite?.prepare(
    `SELECT id, session_id, message_id, path, content IS NOT NULL AS had_content, created_at FROM file_snapshots WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`
  ).all(sessionID, limit) ?? []
  return rows.map(r => ({
    id: r.id, sessionID: r.session_id, messageID: r.message_id,
    path: r.path, existedBefore: !!r.had_content, createdAt: r.created_at,
  }))
}
export { listAll as listSnapshots }

// ── Internals ──────────────────────────────────────────────────────

function restoreRow(row: any): void {
  if (row.content === null) {
    // File was created by the agent — remove it
    try { unlinkSync(row.path) } catch {}
  } else {
    try {
      mkdirSync(dirname(row.path), { recursive: true })
      writeFileSync(row.path, row.content, "utf-8")
    } catch {}
  }
}

function rowToSnapshot(row: any): Snapshot {
  return {
    id: row.id, sessionID: row.session_id, messageID: row.message_id ?? null,
    path: row.path, existedBefore: row.content !== null, createdAt: row.created_at,
  }
}
