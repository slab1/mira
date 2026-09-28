/**
 * Repo Knowledge Graph — structural relationships for repository-level reasoning.
 *
 * Nodes: function → file → module → service → test (+ issue/commit refs)
 * Edges: contains | imports | calls | tests | fixes | touches
 *
 * Built incrementally from the filesystem (+ optional symbol index) and
 * persisted to SQLite so graph queries survive restarts.
 */

import { Glob } from 'bun'
import type { MiraDB } from '../storage/db.js'

export type NodeKind = 'function' | 'file' | 'module' | 'service' | 'test' | 'issue' | 'commit'
export type EdgeKind = 'contains' | 'imports' | 'calls' | 'tests' | 'fixes' | 'touches'

export interface RepoNode {
  id: string // e.g. file:packages/server/src/index.ts
  kind: NodeKind
  name: string
  path?: string
  metadata?: Record<string, unknown>
  updatedAt: number
}

export interface RepoEdge {
  fromId: string
  toId: string
  kind: EdgeKind
}

const SOURCE_GLOBS = ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx']
const IGNORE_RE = /node_modules|dist|build|\.git|\.next|out\//
const IMPORT_RE = /(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]|require\(['"]([^'"]+)['"]\)/g
const DECL_RE = /(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:export\s+)?class\s+(\w+)/g

export class RepoKnowledgeGraph {
  constructor(private deps: { db?: MiraDB; rootDir: string }) {
    this.initSchema()
  }

  private initSchema(): void {
    const sqlite = this.deps.db?.sqlite
    if (!sqlite) return
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS repo_nodes (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        path TEXT,
        metadata TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS repo_nodes_kind_idx ON repo_nodes(kind);
      CREATE TABLE IF NOT EXISTS repo_edges (
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        UNIQUE(from_id, to_id, kind)
      );
      CREATE INDEX IF NOT EXISTS repo_edges_from_idx ON repo_edges(from_id);
      CREATE INDEX IF NOT EXISTS repo_edges_to_idx ON repo_edges(to_id);
    `)
  }

  private upsertNode(node: RepoNode): void {
    this.deps.db?.sqlite
      .prepare(
        `INSERT OR REPLACE INTO repo_nodes (id, kind, name, path, metadata, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(node.id, node.kind, node.name, node.path ?? null, JSON.stringify(node.metadata ?? {}), node.updatedAt)
  }

  private upsertEdge(edge: RepoEdge): void {
    this.deps.db?.sqlite
      .prepare(`INSERT OR IGNORE INTO repo_edges (from_id, to_id, kind) VALUES (?, ?, ?)`)
      .run(edge.fromId, edge.toId, edge.kind)
  }

  static moduleIdOf(path: string): string {
    const parts = path.split('/')
    return `module:${parts.slice(0, Math.max(1, parts.length - 1)).join('/')}`
  }

  /** Full incremental rebuild: file/module/function/test/import structure. */
  async build(): Promise<{ nodes: number; edges: number }> {
    let nodes = 0
    let edges = 0
    const now = Date.now()
    for (const pattern of SOURCE_GLOBS) {
      const glob = new Glob(pattern)
      for await (const file of glob.scan({ cwd: this.deps.rootDir, onlyFiles: true })) {
        if (IGNORE_RE.test(file)) continue
        const path = file.replace(/\\/g, '/')
        const isTest = /\.(test|spec)\.[tj]sx?$/.test(path)
        const fileId = `file:${path}`
        const kind: NodeKind = isTest ? 'test' : 'file'
        this.upsertNode({ id: fileId, kind, name: path.split('/').pop() ?? path, path, updatedAt: now })
        nodes++

        // module node + contains edge
        const modId = RepoKnowledgeGraph.moduleIdOf(path)
        this.upsertNode({ id: modId, kind: 'module', name: modId.slice(7), path: path.split('/').slice(0, -1).join('/'), updatedAt: now })
        nodes++
        this.upsertEdge({ fromId: modId, toId: fileId, kind: 'contains' })
        edges++

        let text: string
        try {
          text = await Bun.file(`${this.deps.rootDir}/${file}`).text()
        } catch {
          continue
        }

        // function/class nodes
        for (const m of text.matchAll(DECL_RE)) {
          const name = m[1] ?? m[2]
          if (!name) continue
          const fnId = `function:${path}#${name}`
          this.upsertNode({ id: fnId, kind: 'function', name, path, updatedAt: now })
          nodes++
          this.upsertEdge({ fromId: fileId, toId: fnId, kind: 'contains' })
          edges++
        }

        // import edges (resolved to files when local)
        for (const m of text.matchAll(IMPORT_RE)) {
          const target = m[1] ?? m[2]
          if (!target || !target.startsWith('.')) continue
          const baseDir = path.split('/').slice(0, -1)
          const resolved = normalizePath([...baseDir, target].join('/'))
          const withExt = /\.(ts|tsx|js|jsx)$/.test(resolved) ? resolved : `${resolved}.ts`
          const toId = `file:${withExt}`
          this.upsertNode({ id: toId, kind: 'file', name: withExt.split('/').pop() ?? withExt, path: withExt, updatedAt: now })
          nodes++
          this.upsertEdge({ fromId: fileId, toId, kind: 'imports' })
          edges++

          // test → target: foo.test.ts tests foo.ts
          if (isTest) {
            const targetBase = path.replace(/\.(test|spec)\.[tj]sx?$/, '.ts')
            const targetId = `file:${targetBase}`
            this.upsertNode({ id: targetId, kind: 'file', name: targetBase.split('/').pop() ?? targetBase, path: targetBase, updatedAt: now })
            nodes++
            this.upsertEdge({ fromId: fileId, toId: targetId, kind: 'tests' })
            edges++
          }
        }
      }
    }
    return { nodes, edges }
  }

  /** Register an external reference: issue → commit → file touch chain. */
  linkExternal(opts: { issueId?: string; commitId?: string; filePaths?: string[]; kind: EdgeKind }): void {
    const now = Date.now()
    const chain: string[] = []
    if (opts.issueId) chain.push(`issue:${opts.issueId}`)
    if (opts.commitId) chain.push(`commit:${opts.commitId}`)
    for (const id of chain) {
      this.upsertNode({ id, kind: id.startsWith('issue:') ? 'issue' : 'commit', name: id, updatedAt: now })
    }
    // consecutive edges: issue → commit → files
    const ids = [...chain, ...(opts.filePaths ?? []).map((p) => `file:${p}`)]
    for (let i = 0; i < ids.length - 1; i++) {
      this.upsertEdge({ fromId: ids[i], toId: ids[i + 1], kind: i < chain.length - 1 ? 'fixes' : 'touches' })
    }
  }

  /** Graph query: direct neighbors of a node. */
  neighbors(id: string, kind?: EdgeKind): RepoNode[] {
    const sqlite = this.deps.db?.sqlite
    if (!sqlite) return []
    const rows = sqlite
      .prepare(
        `SELECT n.* FROM repo_edges e JOIN repo_nodes n ON n.id = e.to_id
         WHERE e.from_id = ?${kind ? ' AND e.kind = ?' : ''}`,
      )
      .all(...(kind ? [id, kind] : [id])) as Record<string, unknown>[]
    return rows.map((r) => this.rowToNode(r))
  }

  /** Reverse neighbors: what points at this node. */
  dependents(id: string, kind?: EdgeKind): RepoNode[] {
    const sqlite = this.deps.db?.sqlite
    if (!sqlite) return []
    const rows = sqlite
      .prepare(
        `SELECT n.* FROM repo_edges e JOIN repo_nodes n ON n.id = e.from_id
         WHERE e.to_id = ?${kind ? ' AND e.kind = ?' : ''}`,
      )
      .all(...(kind ? [id, kind] : [id])) as Record<string, unknown>[]
    return rows.map((r) => this.rowToNode(r))
  }

  getNode(id: string): RepoNode | null {
    const row = this.deps.db?.sqlite.prepare(`SELECT * FROM repo_nodes WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined
    return row ? this.rowToNode(row) : null
  }

  stats(): { nodes: number; edges: number; byKind: Record<string, number> } {
    const sqlite = this.deps.db?.sqlite
    if (!sqlite) return { nodes: 0, edges: 0, byKind: {} }
    const nodes = (sqlite.prepare(`SELECT COUNT(*) c FROM repo_nodes`).get() as { c: number }).c
    const edges = (sqlite.prepare(`SELECT COUNT(*) c FROM repo_edges`).get() as { c: number }).c
    const byKind: Record<string, number> = {}
    for (const r of sqlite.prepare(`SELECT kind, COUNT(*) c FROM repo_nodes GROUP BY kind`).all() as { kind: string; c: number }[]) {
      byKind[r.kind] = r.c
    }
    return { nodes, edges, byKind }
  }

  private rowToNode(r: Record<string, unknown>): RepoNode {
    return {
      id: r.id as string,
      kind: r.kind as NodeKind,
      name: r.name as string,
      path: (r.path as string) ?? undefined,
      metadata: r.metadata ? JSON.parse(r.metadata as string) : {},
      updatedAt: r.updated_at as number,
    }
  }
}

function normalizePath(p: string): string {
  const parts: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '.' || seg === '') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}

export function createRepoGraph(deps: { db?: MiraDB; rootDir: string }): RepoKnowledgeGraph {
  return new RepoKnowledgeGraph(deps)
}
