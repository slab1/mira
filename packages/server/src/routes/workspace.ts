import type { Hono } from 'hono'
import { Glob } from 'bun'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isPathAllowed, sanitizePath } from '../guardrails/index.js'
import { getConfig } from '../config/store.js'

const DEFAULT_IGNORES = [
  '.git',
  'node_modules',
  'dist',
  '.turbo',
  'data',
  '*.db',
  '.mira',
  'coverage',
]

function loadIgnorePatterns(cwd: string): string[] {
  const patterns = [...DEFAULT_IGNORES]
  try {
    const gitignorePath = `${cwd}/.gitignore`
    if (existsSync(gitignorePath)) {
      const content = readFileSync(gitignorePath, 'utf-8')
      for (const line of content.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        if (trimmed.startsWith('!')) continue
        patterns.push(trimmed)
      }
    }
  } catch {}
  return patterns
}

function isIgnored(file: string, patterns: string[]): boolean {
  for (const pat of patterns) {
    const p = pat.replace(/\/$/, '')
    if (file === p || file.startsWith(p + '/')) return true
    if (p.includes('*')) {
      try {
        const g = new Glob(p)
        if (g.match(file)) return true
        const base = file.split('/').pop() ?? file
        if (g.match(base)) return true
      } catch {}
      if (p.startsWith('*.')) {
        const suffix = p.slice(1)
        if (file.endsWith(suffix)) return true
      }
      continue
    }
    if (!p.includes('/')) {
      const segments = file.split('/')
      if (segments.includes(p)) return true
    }
  }
  return false
}

// ── Workspaces helpers ───────────────────────────────────────────────
export type WorkspaceEntry = {
  id: string
  path: string
  name: string
  addedAt: number
}

function workspacesFilePath(): string {
  const home = process.env.HOME ?? ''
  if (home) return `${home}/.mira/workspaces.json`
  return `${process.cwd()}/.mira/workspaces.json`
}

function workspaceIdForPath(p: string): string {
  // deterministic id: base64url of path
  try {
    return Buffer.from(p).toString('base64url')
  } catch {
    return p.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-')
  }
}

function loadWorkspacesFromFile(): WorkspaceEntry[] {
  const fp = workspacesFilePath()
  try {
    if (!existsSync(fp)) return []
    const raw = readFileSync(fp, 'utf-8')
    const parsed = JSON.parse(raw) as { workspaces?: WorkspaceEntry[] } | WorkspaceEntry[]
    if (Array.isArray(parsed)) return parsed
    if (parsed && Array.isArray((parsed as { workspaces?: WorkspaceEntry[] }).workspaces)) {
      return (parsed as { workspaces: WorkspaceEntry[] }).workspaces
    }
    return []
  } catch {
    return []
  }
}

async function saveWorkspacesToFile(entries: WorkspaceEntry[]): Promise<void> {
  const fp = workspacesFilePath()
  const dir = fp.slice(0, fp.lastIndexOf('/'))
  try {
    const { mkdir } = await import('node:fs/promises')
    if (dir) await mkdir(dir, { recursive: true })
  } catch {}
  const payload = { workspaces: entries }
  await Bun.write(fp, JSON.stringify(payload, null, 2) + '\n')
}

function envWorkspaces(): WorkspaceEntry[] {
  const out: WorkspaceEntry[] = []
  const single = process.env.MIRA_WORKSPACE?.trim()
  if (single) {
    const p = single.replace(/\/$/, '') || '/'
    out.push({ id: workspaceIdForPath(p), path: p, name: p.split('/').pop() || p, addedAt: Date.now() })
  }
  const roots = (process.env.MIRA_WORKSPACE_ROOTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  for (const r of roots) {
    const p = r.replace(/\/$/, '') || '/'
    if (out.some((w) => w.path === p)) continue
    out.push({ id: workspaceIdForPath(p), path: p, name: p.split('/').pop() || p, addedAt: Date.now() })
  }
  return out
}

function allWorkspaces(): WorkspaceEntry[] {
  const file = loadWorkspacesFromFile()
  const env = envWorkspaces()
  const map = new Map<string, WorkspaceEntry>()
  for (const w of file) map.set(w.path, w)
  for (const w of env) {
    if (!map.has(w.path)) map.set(w.path, w)
  }
  return [...map.values()].sort((a, b) => b.addedAt - a.addedAt)
}

export function mountWorkspaceRoutes(app: Hono<{ Variables: { requestId: string } }>) {
  // ── Workspaces CRUD ──────────────────────────────────────────────
  app.get('/workspaces', async (c) => {
    const workspaces = allWorkspaces()
    return c.json({ workspaces })
  })

  app.post('/workspaces', async (c) => {
    let body: { path?: string } = {}
    try {
      body = (await c.req.json()) as { path?: string }
    } catch {
      return c.json({ error: 'invalid JSON' }, 400)
    }
    const rawPath = body.path?.trim()
    if (!rawPath) return c.json({ error: 'path required' }, 400)

    // Validate sanitizePath
    const sanitized = sanitizePath(rawPath)
    if (!sanitized.ok) {
      return c.json({ error: `invalid path: ${sanitized.reason}` }, 400)
    }
    let absPath = sanitized.sanitized ?? rawPath
    if (!absPath.startsWith('/')) absPath = `${process.cwd()}/${absPath}`
    absPath = absPath.replace(/\/+/g, '/').replace(/\/$/, '') || '/'

    // Validate exists and is directory
    try {
      if (!existsSync(absPath)) return c.json({ error: `path not found: ${absPath}` }, 404)
      const st = statSync(absPath)
      if (!st.isDirectory()) return c.json({ error: `not a directory: ${absPath}` }, 400)
    } catch (e) {
      return c.json({ error: `invalid path: ${String(e)}` }, 400)
    }

    // Validate isPathAllowed with per-project allowedRoots
    try {
      const cfg = getConfig(absPath)
      const allowedRoots = cfg.guardrails?.allowedRoots
      if (allowedRoots !== undefined) {
        // Use isPathAllowed to check if path itself is allowed
        // For workspace add, we check if the path is within allowedRoots or if allowedRoots is empty (allow all)
        if (allowedRoots.length > 0 && !isPathAllowed(absPath, allowedRoots)) {
          return c.json({ error: `path not allowed by guardrails: ${absPath}` }, 403)
        }
      }
    } catch {
      // ignore config load errors
    }

    const existing = loadWorkspacesFromFile()
    if (existing.some((w) => w.path === absPath)) {
      const found = existing.find((w) => w.path === absPath)!
      return c.json({ workspace: found, workspaces: allWorkspaces() }, 200)
    }
    const entry: WorkspaceEntry = {
      id: workspaceIdForPath(absPath),
      path: absPath,
      name: absPath.split('/').pop() || absPath,
      addedAt: Date.now(),
    }
    const next = [...existing, entry]
    await saveWorkspacesToFile(next)
    return c.json({ workspace: entry, workspaces: allWorkspaces() }, 201)
  })

  app.delete('/workspaces/:id', async (c) => {
    const id = c.req.param('id')
    if (!id) return c.json({ error: 'id required' }, 400)
    const decoded = (() => {
      try {
        return Buffer.from(id, 'base64url').toString('utf-8')
      } catch {
        return null
      }
    })()
    const existing = loadWorkspacesFromFile()
    const idx = existing.findIndex((w) => w.id === id || w.path === id || (decoded && w.path === decoded))
    if (idx === -1) {
      // Also check env workspaces — cannot delete env ones
      const env = envWorkspaces()
      if (env.some((w) => w.id === id || w.path === id || (decoded && w.path === decoded))) {
        return c.json({ error: 'cannot delete env workspace (MIRA_WORKSPACE/MIRA_WORKSPACE_ROOTS)' }, 403)
      }
      return c.json({ error: 'workspace not found' }, 404)
    }
    const removed = existing[idx]
    const next = existing.filter((_, i) => i !== idx)
    await saveWorkspacesToFile(next)
    return c.json({ ok: true, removed, workspaces: allWorkspaces() })
  })

  app.get('/workspace/tree', async (c) => {
    const cwdQuery = c.req.query('cwd')
    const projectId = c.req.query('projectId')
    const limitStr = c.req.query('limit')
    const cursor = c.req.query('cursor')
    const includeDirsStr = c.req.query('includeDirs')

    // Resolve cwd: prefer cwd query, then projectId if it looks like a path, else process.cwd()
    let cwd = process.cwd()
    if (cwdQuery) cwd = cwdQuery
    else if (projectId) cwd = projectId

    // Validate cwd via sanitizePath (allow sensitive for cwd itself, only block traversal)
    const sanitizedCwd = sanitizePath(cwd)
    if (!sanitizedCwd.ok) {
      const reason = sanitizedCwd.reason ?? ''
      if (
        reason.includes('traversal') ||
        reason.includes('null byte') ||
        reason.includes('encoded')
      ) {
        return c.json({ error: `invalid cwd: ${reason}` }, 400)
      }
      // For sensitive paths (e.g. /root), allow cwd itself but files will still be filtered
      // Keep original cwd
    } else {
      cwd = sanitizedCwd.sanitized ?? cwd
    }
    // Normalize to absolute path
    if (!cwd.startsWith('/')) {
      cwd = `${process.cwd()}/${cwd}`
    }
    cwd = cwd.replace(/\/+/g, '/').replace(/\/$/, '') || '/'

    // Validate cwd exists
    try {
      if (!existsSync(cwd)) {
        return c.json({ error: `cwd not found: ${cwd}` }, 404)
      }
      const st = statSync(cwd)
      if (!st.isDirectory()) {
        return c.json({ error: `cwd not a directory: ${cwd}` }, 400)
      }
    } catch (e) {
      return c.json({ error: `invalid cwd: ${String(e)}` }, 400)
    }

    // Get allowedRoots from per-project config (fix prod bug: use real roots not [])
    let allowedRoots: string[] = []
    const isExplicitCwd = !!cwdQuery || !!projectId
    try {
      const cfg = getConfig(cwd)
      if (cfg.guardrails?.allowedRoots !== undefined) {
        allowedRoots = cfg.guardrails.allowedRoots
      } else {
        const isProd = process.env.NODE_ENV === 'production' || process.env.HOST === '0.0.0.0'
        allowedRoots = isProd ? ['./data', './packages', './src'] : []
      }
    } catch {
      const isProd = process.env.NODE_ENV === 'production' || process.env.HOST === '0.0.0.0'
      allowedRoots = isProd ? ['./data', './packages', './src'] : []
    }
    // isExplicitCwd bypass handled in file loop (allow all within explicitly requested cwd)

    // Parse limit
    let limit = 500
    if (limitStr) {
      const n = parseInt(limitStr, 10)
      if (!isNaN(n) && n > 0) limit = Math.min(n, 1000)
      else if (limitStr) {
        return c.json({ error: 'invalid limit' }, 400)
      }
    }
    const includeDirs = includeDirsStr === 'true' || includeDirsStr === '1'

    const patterns = loadIgnorePatterns(cwd)
    const glob = new Glob('**/*')

    // Collect files
    const allFiles: string[] = []
    try {
      for await (const file of glob.scan({ cwd, dot: false, onlyFiles: !includeDirs })) {
        const sanitized = sanitizePath(file)
        if (!sanitized.ok) continue
        // For explicitly requested cwd, bypass isPathAllowed (allow all within that cwd)
        // Otherwise use real allowedRoots (fix prod bug: not [])
        if (!isExplicitCwd && !isPathAllowed(file, allowedRoots)) continue
        if (isIgnored(file, patterns)) continue
        allFiles.push(file)
        // Early break if we have enough for pagination + one extra to detect truncated
        // But we need sorted, so collect all then sort, but cap at 5000 to avoid OOM
        if (allFiles.length >= 5000) break
      }
    } catch {}
    allFiles.sort()

    // Handle cursor pagination: cursor can be offset number or last path string
    let startIdx = 0
    if (cursor) {
      const n = parseInt(cursor, 10)
      if (!isNaN(n) && String(n) === cursor) {
        // Numeric cursor = offset
        startIdx = Math.max(0, n)
      } else {
        const idx = allFiles.indexOf(cursor)
        if (idx >= 0) startIdx = idx + 1
        else {
          // If cursor not found, treat as 0
          startIdx = 0
        }
      }
    }

    const sliced = allFiles.slice(startIdx, startIdx + limit)
    const truncated = allFiles.length > startIdx + limit
    const nextCursor = truncated ? (sliced[sliced.length - 1] ?? null) : null

    // Build file objects with stat
    const files = sliced.map((relPath) => {
      const absPath = `${cwd}/${relPath}`
      let isDir = false
      let size = 0
      let mtime = 0
      try {
        const st = statSync(absPath)
        isDir = st.isDirectory()
        size = isDir ? 0 : st.size
        mtime = st.mtimeMs
      } catch {
        // If stat fails, keep defaults
      }
      return { path: relPath, isDir, size, mtime }
    })

    // For backward compat, also support old clients expecting string[]?
    // Return new shape: {files:[{path,isDir,size,mtime}], truncated, cwd, nextCursor}
    // Also include total for debugging
    return c.json({
      files,
      truncated,
      cwd,
      nextCursor,
      // Keep compatibility: if client expects string[], they can map f.path
    })
  })
}
