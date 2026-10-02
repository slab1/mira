import type { Bus } from '../../bus/index.js'
import type { MiraDB } from '../../storage/db.js'

export interface MessageQueueDeps {
  db: MiraDB
  bus: Bus
}

export class MessageQueue {
  constructor(private deps: MessageQueueDeps) {}

  /** Queue a message while a turn is streaming; it runs right after. Persisted to SQLite. */
  queueMessage(sessionID: string, text: string): { position: number } {
    this.deps.db.sqlite
      .prepare(`INSERT INTO message_queue (id, session_id, text, created_at) VALUES (?, ?, ?, ?)`)
      .run(crypto.randomUUID(), sessionID, text, Date.now())
    const q = this.getQueue(sessionID)
    this.deps.bus.publish({
      type: 'session.updated',
      sessionID,
      payload: { queued: q.length },
      timestamp: Date.now(),
    })
    return { position: q.length }
  }

  getQueue(sessionID: string): string[] {
    try {
      return (
        this.deps.db.sqlite
          .prepare(`SELECT text FROM message_queue WHERE session_id = ? ORDER BY created_at, rowid`)
          .all(sessionID) as Array<{ text: string }>
      ).map((r) => r.text)
    } catch (e) {
      console.error('[session.prompt] error:', e)
      return []
    }
  }

  clearQueue(sessionID: string): number {
    const n = this.getQueue(sessionID).length
    try {
      this.deps.db.sqlite.prepare(`DELETE FROM message_queue WHERE session_id = ?`).run(sessionID)
    } catch (e) {
      console.error('[session.prompt] error:', e)
    }
    return n
  }

  /** Atomically pop the oldest queued message (drain head) */
  dequeueFirst(sessionID: string): string | null {
    try {
      const row = this.deps.db.sqlite
        .prepare(
          `SELECT id, text FROM message_queue WHERE session_id = ? ORDER BY created_at, rowid LIMIT 1`,
        )
        .get(sessionID) as { id: string; text: string } | undefined
      if (!row) return null
      this.deps.db.sqlite.prepare(`DELETE FROM message_queue WHERE id = ?`).run(row.id)
      return row.text
    } catch (e) {
      console.error('[session.prompt] error:', e)
      return null
    }
  }
}
