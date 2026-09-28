/**
 * Semantic Repository Understanding — persistent structural models on top of
 * RepoKnowledgeGraph:
 *   Dependency Graph  — module→module import aggregation
 *   Call Graph        — function→function call approximation (import + call-site regex)
 *   Ownership Graph   — package.json workspace ownership (service owns module)
 *   Service Graph     — packages/* boundaries (service nodes + ownership edges)
 *
 * All data persists into the existing repo_nodes/repo_edges tables, so semantic
 * queries survive restarts and compose with the structural graph.
 */

import { Glob } from 'bun'
import type { MiraDB } from '../storage/db.js'
import { RepoKnowledgeGraph, type RepoNode } from './graph.js'

export interface SemanticBuildResult {
  services: number
  ownershipEdges: number
  dependencyEdges: number
  callEdges: number
}

const IGNORE_RE = /node_modules|dist|build|\.git|\.next|out\//

export class SemanticGraph {
  constructor(private deps: { db?: MiraDB; rootDir: string; graph: RepoKnowledgeGraph }) {}

  async build(): Promise<SemanticBuildResult> {
    let services = 0
    let ownershipEdges = 0
    let dependencyEdges = 0
    let callEdges = 0
    const now = Date.now()
    const sqlite = this.deps.db?.sqlite

    // ── Service Graph + Ownership Graph ─────────────────────────────
    // Each packages/<name>/package.json defines a service. Modules under it
    // are owned by that service.
    const pkgGlob = new Glob('packages/*/package.json')
    for await (const pkg of pkgGlob.scan({ cwd: this.deps.rootDir, onlyFiles: true })) {
      const dir = pkg.split('/').slice(0, -1).join('/')
      const name = dir.split('/').pop() ?? dir
      const serviceId = `service:${name}`
      this.upsertNode({ id: serviceId, kind: 'service', name, path: dir, updatedAt: now })
      services++

      // Ownership: service → all module nodes whose path starts with dir
      if (!sqlite) continue
      const modules = sqlite
        .prepare(`SELECT id FROM repo_nodes WHERE kind = 'module' AND path LIKE ?`)
        .all(`${dir}/%`) as { id: string }[]
      for (const m of modules) {
        this.upsertEdge(serviceId, m.id, 'contains') // ownership expressed as containment
        ownershipEdges++
      }
    }

    // ── Dependency Graph ────────────────────────────────────────────
    // Aggregate file-level import edges up to module-to-module edges.
    if (sqlite) {
      const importEdges = sqlite
        .prepare(
          `SELECT e.from_id AS src, e.to_id AS dst
           FROM repo_edges e
           JOIN repo_nodes f1 ON f1.id = e.from_id
           JOIN repo_nodes f2 ON f2.id = e.to_id
           WHERE e.kind = 'imports' AND f1.kind IN ('file','test') AND f2.kind IN ('file','test')`,
        )
        .all() as { src: string; dst: string }[]
      const seen = new Set<string>()
      for (const { src, dst } of importEdges) {
        const srcPath = (src.replace(/^file:/, '').split('/').slice(0, -1).join('/'))
        const dstPath = (dst.replace(/^file:/, '').split('/').slice(0, -1).join('/'))
        if (!srcPath || !dstPath || srcPath === dstPath) continue
        const srcMod = `module:${srcPath}`
        const dstMod = `module:${dstPath}`
        const key = `${srcMod}|${dstMod}`
        if (seen.has(key)) continue
        seen.add(key)
        this.upsertEdge(srcMod, dstMod, 'imports')
        dependencyEdges++
      }
    }

    // ── Call Graph ──────────────────────────────────────────────────
    // Approximation: for each function node, scan files that import its file
    // for `name(` call sites.
    if (sqlite) {
      const fns = sqlite
        .prepare(`SELECT id, name, path FROM repo_nodes WHERE kind = 'function'`)
        .all() as { id: string; name: string; path: string | null }[]
      for (const fn of fns) {
        if (!fn.path) continue
        const callers = sqlite
          .prepare(
            `SELECT from_id FROM repo_edges WHERE to_id = ? AND kind = 'imports'`,
          )
          .all(`file:${fn.path}`) as { from_id: string }[]
        for (const c of callers) {
          const callerFile = c.from_id.replace(/^file:/, '')
          if (IGNORE_RE.test(callerFile)) continue
          let text: string
          try {
            text = await Bun.file(`${this.deps.rootDir}/${callerFile}`).text()
          } catch {
            continue
          }
          const callRe = new RegExp(`\\b${escapeRegex(fn.name)}\\s*\\(`)
          if (callRe.test(text)) {
            // Link the caller file to the function (file-level call evidence)
            this.upsertEdge(c.from_id, fn.id, 'calls')
            callEdges++
          }
        }
      }
    }

    return { services, ownershipEdges, dependencyEdges, callEdges }
  }

  private upsertNode(node: RepoNode): void {
    this.deps.db?.sqlite
      .prepare(
        `INSERT OR REPLACE INTO repo_nodes (id, kind, name, path, metadata, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(node.id, node.kind, node.name, node.path ?? null, JSON.stringify(node.metadata ?? {}), node.updatedAt)
  }

  private upsertEdge(fromId: string, toId: string, kind: string): void {
    this.deps.db?.sqlite
      .prepare(`INSERT OR IGNORE INTO repo_edges (from_id, to_id, kind) VALUES (?, ?, ?)`)
      .run(fromId, toId, kind)
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function createSemanticGraph(deps: { db?: MiraDB; rootDir: string }): SemanticGraph {
  const graph = new RepoKnowledgeGraph(deps)
  return new SemanticGraph({ ...deps, graph })
}
