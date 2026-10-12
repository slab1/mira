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
              `SELECT id, session_id, message_id, path, content, created_at FROM file_snapshots
             WHERE session_id IN (${sessions.map(() => '?').join(',') || "''"})
             ORDER BY created_at DESC LIMIT ?`,
            )
            .all(...sessions, limit) as Array<{
            id: string
            session_id: string
            message_id: string | null
            path: string
            content: string | null
            created_at: number
          }>
        ).map((s) => ({
          id: s.id,
          path: s.path,
          content: s.content,
          createdAt: s.created_at,
          sessionId: s.session_id,
          messageId: s.message_id,
        }))
      : (
          (await db.query.fileSnapshots.findMany({
            orderBy: desc(db.schema.fileSnapshots.createdAt),
            limit,
          })) as unknown as Array<{
            id: string
            sessionID: string
            messageID: string | null
            path: string
            content: string | null
            createdAt: number
          }>
        )
          // Drizzle returns the schema's own key names (sessionID/messageID);
          // normalize to the shape the raw-SQL branch above produces.
          .map((s) => ({
            id: s.id,
            path: s.path,
            content: s.content,
            createdAt: s.createdAt,
            sessionId: s.sessionID,
            messageId: s.messageID,
          }))
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
        sessionId: s.sessionId,
        messageId: s.messageId,
        // Pre-change content: the snapshot IS the "before". A null content means
        // the file did not exist, so "before" is genuinely empty (created).
        before: s.content ?? '',
        after: hasContent ? '' : null,
        snapshot: s.id,
      }
    })

    // Join real session facts so the UI's change entries carry evidence instead
    // of rendering "undefined". Agent comes from the session; verification state
    // lives on jobs (VERIFICATION_STATES_DESIGN §2.2), so it is the WORST state
    // across the session's jobs — a change with any failed verification must not
    // read as verified.
    const sessionIDs = [...new Set(items.map((i) => i.sessionId).filter(Boolean))] as string[]
    const sessionFacts = new Map<string, { agent: string | null; verification: string | null }>()
    if (sessionIDs.length > 0 && db.sqlite) {
      try {
        const qs = sessionIDs.map(() => '?').join(',')
        const agentRows = db.sqlite
          .prepare(`SELECT id, agent FROM sessions WHERE id IN (${qs})`)
          .all(...sessionIDs) as Array<{ id: string; agent: string | null }>
        for (const r of agentRows) {
          sessionFacts.set(r.id, { agent: r.agent, verification: null })
        }
        const jobRows = db.sqlite
          .prepare(
            `SELECT parent_session_id, verification_state FROM jobs WHERE parent_session_id IN (${qs})`,
          )
          .all(...sessionIDs) as Array<{
          parent_session_id: string
          verification_state: string | null
        }>
        // Worst-state-wins: FAILED beats everything, then PARTIAL, then VERIFIED.
        const rank: Record<string, number> = {
          FAILED_VERIFICATION: 3,
          PARTIALLY_VERIFIED: 2,
          VERIFIED: 1,
          UNVERIFIED: 0,
        }
        for (const j of jobRows) {
          const cur = sessionFacts.get(j.parent_session_id)
          if (!cur || !j.verification_state) continue
          const next = rank[j.verification_state] ?? 0
          const prev = rank[cur.verification ?? 'UNVERIFIED'] ?? 0
          if (next > prev) cur.verification = j.verification_state
        }
      } catch {}
    }

    return c.json(
      items.map((i) => {
        const facts = i.sessionId ? sessionFacts.get(i.sessionId) : undefined
        return {
          ...i,
          agent: facts?.agent ?? null,
          verification: facts?.verification ?? null,
          // Not recorded at the snapshot level. Explicitly null so the UI shows
          // "not recorded" — never a fabricated pass/fail or a fake tool list.
          tools: null,
          tests: null,
          rollback: i.snapshot ? 'available' : null,
          approval: null,
        }
      }),
    )
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

  // GET /memory — real knowledge_entries (was a `return []` placeholder, which
  // meant the Intelligence page's Memory section never rendered anything).
  app.get('/memory', async (c) => {
    const limit = Math.min(parseInt(c.req.query('limit') ?? '100', 10) || 100, 500)
    const tier = c.req.query('tier')
    try {
      const rows = db.sqlite
        .prepare(
          `SELECT id, tier, source, title, content, tags, metadata, created_at, updated_at
             FROM knowledge_entries
             ${tier ? 'WHERE tier = ?' : ''}
             ORDER BY created_at DESC LIMIT ?`,
        )
        .all(...(tier ? [tier, limit] : [limit])) as Array<{
        id: string
        tier: string | null
        source: string | null
        title: string | null
        content: string
        tags: string | null
        metadata: string | null
        created_at: number
        updated_at: number | null
      }>
      const parse = (raw: string | null): string[] => {
        if (!raw) return []
        try {
          const v = JSON.parse(raw)
          return Array.isArray(v) ? v.map(String) : []
        } catch {
          return []
        }
      }
      return c.json(
        rows.map((r) => {
          let provenance = 'unverified'
          let confidence = 0.5
          try {
            const meta = r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : {}
            if (typeof meta.provenance === 'string') provenance = meta.provenance
            if (typeof meta.confidence === 'number') confidence = meta.confidence
          } catch {}
          return {
            id: r.id,
            tier: r.tier ?? 'semantic',
            source: r.source ?? 'user',
            title: r.title ?? r.content.slice(0, 80),
            content: r.content,
            tags: parse(r.tags),
            provenance,
            confidence,
            createdAt: r.created_at,
            updatedAt: r.updated_at ?? r.created_at,
          }
        }),
      )
    } catch {
      // A missing table must degrade to "no memories", not a 500.
      return c.json([])
    }
  })
}
