import { readdir, stat } from "node:fs/promises"
import { join, relative } from "node:path"
import type { Dirent } from "node:fs"

/** Directory basenames that are never surfaced (sandbox hygiene + signal) */
const DENY_BASENAMES = new Set([
  "node_modules", ".git", ".bun", "dist", "build", "target", "coverage",
  ".cache", ".next", ".turbo", ".vite", ".wrangler", ".github", ".husky",
])

/** Any dir whose first char is a dot is hidden and skipped (deny-list is a superset signal) */
const isDotHidden = (name: string) => name.startsWith(".")

export interface WorkspaceEntry {
  path: string      // '.'-relative, POSIX (usable directly as a prompt path)
  dir: boolean
  size: number
  mtimeMs: number
}

export interface WorkspaceTreeOptions {
  /** Absolute root to list (default: resolved from caller) */
  root?: string
  /** Max entries returned, clamped to 1..500 (default 200) */
  limit?: number
  /** Recursion depth cap, 1..4 inclusive (default 4) */
  maxDepth?: number
}

const clamp = (n: number | undefined, lo: number, hi: number, dflt: number): number => {
  const v = Number.isFinite(Number(n)) ? Number(n) : dflt
  return Math.max(lo, Math.min(hi, Math.round(v)))
}

/**
 * Read-only workspace listing, sandbox-safe:
 *  - denied dirs (node_modules/.git/dist/... ) and dot-hidden entries are never listed
 *  - symlinks are never surfaced (prevents following out of the root — jail-break guard)
 *  - returns relative POSIX paths (no prefix; load-bearing for prompt @files)
 */
export async function listWorkspaceTree(rawRoot: string, opts: WorkspaceTreeOptions = {}): Promise<WorkspaceEntry[]> {
  const root = rawRoot
  const limit = clamp(opts.limit, 1, 500, 200)
  const maxDepth = clamp(opts.maxDepth, 1, 4, 4)
  const out: WorkspaceEntry[] = []

  async function walk(dir: string, depth: number): Promise<void> {
    if (out.length >= limit) return
    if (depth > maxDepth) return

    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return // unreadable / race — skip silently
    }

    // Collect candidate entries, newest-mtime-first at this level
    const local: Array<{ name: string; dir: boolean; mtimeMs: number; size: number }> = []
    for (const e of entries) {
      if (out.length >= limit) break
      if (e.isSymbolicLink()) continue // never surface symlinks
      if (isDotHidden(e.name)) continue
      if (e.isDirectory() && DENY_BASENAMES.has(e.name)) continue

      const full = join(dir, e.name)
      let mtimeMs = 0
      let size = 0
      try {
        const s = await stat(full)
        mtimeMs = s.mtimeMs
        size = s.size
      } catch {
        continue // bail on stat failure (dangling/jail)
      }
      local.push({ name: e.name, dir: e.isDirectory(), mtimeMs, size })
    }
    local.sort((a, b) => b.mtimeMs - a.mtimeMs)

    for (const item of local) {
      if (out.length >= limit) break
      out.push({
        path: relative(root, join(dir, item.name)).split("\\").join("/"),
        dir: item.dir,
        size: item.size,
        mtimeMs: item.mtimeMs,
      })
      if (item.dir) await walk(join(dir, item.name), depth + 1)
    }
  }

  await walk(root, 1)
  return out
}
