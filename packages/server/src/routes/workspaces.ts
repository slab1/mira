import type { Hono } from 'hono'
import type { MiraDB } from '../storage/db.js'
import { desc, sql } from 'drizzle-orm'

export function mountWorkspacesRoutes(app: Hono<{ Variables: { requestId: string } }>, deps: { db: MiraDB }) {
  const { db } = deps

  // GET /files — list unique files with latest snapshot timestamp and size
  app.get('/files', async (c) => {
    const limit = Math.min(parseInt(c.req.query('limit') ?? '100', 10) || 100, 1000)
    // Get latest snapshot per path with content for size
    const rows = await db.sqlite.prepare(`
      SELECT fs.path, fs.created_at as modified, fs.content
      FROM file_snapshots fs
      JOIN (
        SELECT path, MAX(created_at) as max_created
        FROM file_snapshots
        GROUP BY path
      ) latest ON fs.path = latest.path AND fs.created_at = latest.max_created
      ORDER BY modified DESC
      LIMIT ?
    `).all(limit) as Array<{ path: string; modified: number; content: string | null }>

    const items = rows.map(r => ({
      path: r.path,
      status: 'modified',
      size: r.content ? Buffer.byteLength(r.content, 'utf8') : 0,
      modified: r.modified,
    }))
    return c.json(items)
  })

  // GET /artifacts — placeholder: return empty list for now
  app.get('/artifacts', async (c) => {
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 500)
    // No artifacts table yet; return empty array to satisfy frontend
    return c.json([])
  })

  // GET /changes — list recent file snapshots with simple diff preview
  app.get('/changes', async (c) => {
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 500)
    const rows = await db.query.fileSnapshots.findMany({
      orderBy: desc(db.schema.fileSnapshots.createdAt),
      limit,
    })
    const items = rows.map(s => {
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
