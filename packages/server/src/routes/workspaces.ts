import type { Hono } from 'hono'
import type { MiraDB } from '../storage/db.js'
import { desc } from 'drizzle-orm'

export function mountWorkspacesRoutes(
  app: Hono<{ Variables: { requestId: string } }>,
  deps: {
    db: MiraDB
    /** P3.3 tenancy: session ids the caller may read (owner or same org) */
    visibleSessionIDs?: (
      c: Hono<{ Variables: { requestID: string } }>['request'] extends never
        ? never
        : { req: { header: (n: string) => string | undefined } },
    ) => Promise<string[]>
    resolveOwner?: (t: string) => string | undefined
    bearerOf?: (h?: string) => string
    ownerOfSession?: (id: string) => Promise<string | null>
    orgOfSession?: (id: string) => Promise<string | null>
    orgOfOwner?: (owner: string | null | undefined) => string | undefined
    OWNERSHIP_ENABLED?: boolean | (() => boolean)
  },
) {
  const { db } = deps

  /**
   * Session ids whose file snapshots the caller may see (P3.3 rule).
   * Returns null when tenancy is off — callers then behave as before (global).
   */
  const visibleSnapshotSessions = async (c: {
    req: { header: (n: string) => string | undefined }
  }): Promise<string[] | null> => {
    const on =
      typeof deps.OWNERSHIP_ENABLED === 'function'
        ? (deps.OWNERSHIP_ENABLED as () => boolean)()
        : !!deps.OWNERSHIP_ENABLED
    if (!on || !deps.ownerOfSession || !deps.resolveOwner) return null
    const caller = deps.resolveOwner(deps.bearerOf?.(c.req.header('Authorization')) ?? '')
    if (!caller) return []
    const ids = db.sqlite.prepare('SELECT id FROM sessions').all() as Array<{ id: string }>
    const visible: string[] = []
    for (const { id } of ids) {
      const owner = await deps.ownerOfSession(id)
      if (owner === null || owner === caller) {
        visible.push(id)
        continue
      }
      const org = await deps.orgOfSession?.(id)
      if (org != null && deps.orgOfOwner?.(caller) === org) visible.push(id)
    }
    return visible
  }

  // GET /files — list unique files with latest snapshot timestamp and size
  app.get('/files', async (c) => {
    const limit = Math.min(parseInt(c.req.query('limit') ?? '100', 10) || 100, 1000)
    const sessions = await visibleSnapshotSessions(c)
    // Tenancy on: restrict to the caller's sessions; off: all rows (as before).
    const rows = (
      sessions
        ? db.sqlite
            .prepare(
              `SELECT fs.path, fs.created_at as modified, fs.content
             FROM file_snapshots fs
             WHERE fs.session_id IN (${sessions.map(() => '?').join(',') || "''"})
             AND fs.created_at = (
               SELECT MAX(f2.created_at) FROM file_snapshots f2
               WHERE f2.path = fs.path
                 AND f2.session_id IN (${sessions.map(() => '?').join(',') || "''"})
             )
             ORDER BY modified DESC LIMIT ?`,
            )
            .all(...sessions, ...sessions, limit)
        : db.sqlite
            .prepare(
              `
      SELECT fs.path, fs.created_at as modified, fs.content
      FROM file_snapshots fs
      JOIN (
        SELECT path, MAX(created_at) as max_created
        FROM file_snapshots
        GROUP BY path
      ) latest ON fs.path = latest.path AND fs.created_at = latest.max_created
      ORDER BY modified DESC
      LIMIT ?
    `,
            )
            .all(limit)
    ) as Array<{ path: string; modified: number; content: string | null }>

    const items = rows.map((r) => ({
      path: r.path,
      status: 'modified',
      size: r.content ? Buffer.byteLength(r.content, 'utf8') : 0,
      modified: r.modified,
    }))
    return c.json(items)
  })

  // GET /artifacts — placeholder: return empty list for now
  app.get('/artifacts', async (c) => {
    // No artifacts table yet; return empty array to satisfy frontend
    return c.json([])
  })

  // GET /changes — list recent file snapshots with simple diff preview
  app.get('/changes', async (c) => {
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 500)
    const sessions = await visibleSnapshotSessions(c)
    const rows = sessions
      ? (
          db.sqlite
            .prepare(
              `SELECT id, session_id, path, content, created_at FROM file_snapshots
             WHERE session_id IN (${sessions.map(() => '?').join(',') || "''"})
             ORDER BY created_at DESC LIMIT ?`,
            )
            .all(...sessions, limit) as Array<{
            id: string
            path: string
            content: string | null
            created_at: number
          }>
        ).map((s) => ({
          id: s.id,
          path: s.path,
          content: s.content,
          createdAt: s.created_at,
        }))
      : await db.query.fileSnapshots.findMany({
          orderBy: desc(db.schema.fileSnapshots.createdAt),
          limit,
        })
    const items = rows.map((s) => {
      const hasContent = s.content !== null && s.content !== undefined
      const type = hasContent ? 'update' : 'create'
      // Simple diff preview: show first 200 chars of new content, or deletion marker
      let diff = ''
      if (hasContent) {
        const preview = s.content!.slice(0, 200).replace(/\n/g, '\\n')
        diff = `+ ${preview}${s.content!.length > 200 ? '…' : ''}`
      } else {
        diff = '- file deleted'
      }
      return {
        id: s.id,
        path: s.path,
        type,
        diff,
        createdAt: s.createdAt,
      }
    })
    return c.json(items)
  })

  // GET /cost — placeholder cost aggregation
  app.get('/cost', async (c) => {
    return c.json({
      total: 0,
      sessions: 0,
      missions: 0,
      breakdown: [],
    })
  })

  // GET /missions — placeholder
  app.get('/missions', async (c) => {
    return c.json([])
  })

  // GET /memory — placeholder
  app.get('/memory', async (c) => {
    return c.json([])
  })
}
