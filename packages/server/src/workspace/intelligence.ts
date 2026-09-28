/**
 * Workspace Intelligence — persistent awareness of:
 *   - Roadmaps
 *   - Open Issues
 *   - Technical Debt
 *   - CI Status
 *   - Architectural Decisions
 *
 * Stores workspace context items in SQLite and provides query API for
 * agents to maintain persistent awareness without repeated discovery.
 */

import type { MiraDB } from '../storage/db.js'

export type WorkspaceItemKind = 'roadmap' | 'issue' | 'tech-debt' | 'ci-status' | 'decision'

export interface WorkspaceItem {
  id: string
  kind: WorkspaceItemKind
  title: string
  description: string
  status: 'open' | 'in-progress' | 'resolved' | 'wontfix'
  priority: 'low' | 'medium' | 'high'
  metadata: Record<string, string | number | boolean>
  createdAt: number
  updatedAt: number
}

export interface WorkspaceItemInput {
  kind: WorkspaceItemKind
  title: string
  description?: string
  status?: WorkspaceItem['status']
  priority?: WorkspaceItem['priority']
  metadata?: Record<string, string | number | boolean>
}

export class WorkspaceIntelligence {
  constructor(private deps: { db?: MiraDB }) {
    this.initSchema()
  }

  private initSchema(): void {
    this.deps.db?.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS workspace_items (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        priority TEXT NOT NULL DEFAULT 'medium',
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS workspace_items_kind_idx ON workspace_items(kind);
      CREATE INDEX IF NOT EXISTS workspace_items_status_idx ON workspace_items(status);
    `)
  }

  /** Add or update a workspace item. */
  upsert(input: WorkspaceItemInput): WorkspaceItem {
    const now = Date.now()
    const id = `ws_${input.kind}_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    const item: WorkspaceItem = {
      id,
      kind: input.kind,
      title: input.title,
      description: input.description ?? '',
      status: input.status ?? 'open',
      priority: input.priority ?? 'medium',
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    }
    this.deps.db?.sqlite
      .prepare(
        `INSERT OR REPLACE INTO workspace_items (id, kind, title, description, status, priority, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(item.id, item.kind, item.title, item.description, item.status, item.priority, JSON.stringify(item.metadata), item.createdAt, item.updatedAt)
    return item
  }

  /** Query workspace items, optionally filtered by kind and status. */
  query(filter?: { kind?: WorkspaceItemKind; status?: WorkspaceItem['status'] }): WorkspaceItem[] {
    const sqlite = this.deps.db?.sqlite
    if (!sqlite) return []
    const conditions: string[] = []
    const params: string[] = []
    if (filter?.kind) { conditions.push('kind = ?'); params.push(filter.kind) }
    if (filter?.status) { conditions.push('status = ?'); params.push(filter.status) }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = sqlite
      .prepare(`SELECT * FROM workspace_items ${where} ORDER BY updated_at DESC`)
      .all(...params) as Record<string, unknown>[]
    return rows.map((r) => this.rowToItem(r))
  }

  /** Get a single workspace item by id. */
  get(id: string): WorkspaceItem | null {
    const row = this.deps.db?.sqlite.prepare(`SELECT * FROM workspace_items WHERE id = ?`).get(id) as Record<string, unknown> | undefined
    return row ? this.rowToItem(row) : null
  }

  /** Update status of a workspace item. */
  setStatus(id: string, status: WorkspaceItem['status']): void {
    this.deps.db?.sqlite
      .prepare(`UPDATE workspace_items SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, Date.now(), id)
  }

  /** Summary counts by kind and status. */
  summary(): Record<string, number> {
    const sqlite = this.deps.db?.sqlite
    if (!sqlite) return {}
    const rows = sqlite
      .prepare(`SELECT kind, status, COUNT(*) c FROM workspace_items GROUP BY kind, status`)
      .all() as { kind: string; status: string; c: number }[]
    const out: Record<string, number> = {}
    for (const r of rows) {
      out[`${r.kind}:${r.status}`] = r.c
    }
    return out
  }

  private rowToItem(r: Record<string, unknown>): WorkspaceItem {
    return {
      id: r.id as string,
      kind: r.kind as WorkspaceItemKind,
      title: r.title as string,
      description: (r.description as string) ?? '',
      status: r.status as WorkspaceItem['status'],
      priority: r.priority as WorkspaceItem['priority'],
      metadata: JSON.parse(r.metadata as string) as Record<string, string | number | boolean>,
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
    }
  }
}

export function createWorkspaceIntelligence(deps: { db?: MiraDB }): WorkspaceIntelligence {
  return new WorkspaceIntelligence(deps)
}
