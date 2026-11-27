import type { Hono } from 'hono'
import { Glob } from 'bun'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync, readdirSync } from 'node:fs'
import { isPathAllowed, sanitizePath } from '../guardrails/index.js'
import { getConfig } from '../config/store.js'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { MiraDB } from '../storage/db.js'
import { snapshotFile } from '../storage/snapshots.js'

const MAX_PREVIEW_BYTES = 512 * 1024
const BROWSER_EDITOR_SESSION_ID = '__browser_editor__'

const BLOCKED_SEGMENTS = new Set(['.git', '.mira', '.ssh', '.aws', 'node_modules'])
const ALLOWED_ENV_NAMES = new Set(['.env.example', '.env.sample', '.env.template'])
const BLOCKED_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.db', '.sqlite', '.sqlite3']

function isSensitiveRelativePath(relPath: string): string | null {
  const parts = relPath.split('/').filter(Boolean)
  for (const seg of parts) {
    if (BLOCKED_SEGMENTS.has(seg.toLowerCase())) {
      return `access to ${seg} is blocked`
    }
  }
  const base = (parts[parts.length - 1] ?? '').toLowerCase()
  if ((base === '.env' || base.startsWith('.env.')) && !ALLOWED_ENV_NAMES.has(base)) {
    return 'access to .env secret files is blocked'
  }
  for (const ext of BLOCKED_EXTENSIONS) {
    if (base.endsWith(ext)) {
      return `access to ${ext} files is blocked`
    }
  }
  return null
}

function resolveWorkspaceCwd(
  cwdQuery?: string,
  projectId?: string,
): { ok: true; cwd: string; cwdReal: string; isExplicitCwd: boolean; allowedRoots: string[] } | { ok: false; status: number; error: string } {
  let cwd = process.cwd()
  if (cwdQuery) cwd = cwdQuery
  else if (projectId) cwd = projectId

  const sanitizedCwd = sanitizePath(cwd)
  if (!sanitizedCwd.ok) {
    const reason = sanitizedCwd.reason ?? ''
    if (reason.includes('traversal') || reason.includes('null byte') || reason.includes('encoded')) {
      return { ok: false, status: 400, error: `invalid cwd: ${reason}` }
    }
  } else {
    cwd = sanitizedCwd.sanitized ?? cwd
  }
  if (!isAbsolute(cwd)) {
    cwd = join(process.cwd(), cwd)
  }
  cwd = cwd.replace(/\/+/g, '/').replace(/\/$/, '') || '/'

  try {
    if (!existsSync(cwd)) {
      return { ok: false, status: 404, error: `cwd not found: ${cwd}` }
    }
    const st = statSync(cwd)
    if (!st.isDirectory()) {
      return { ok: false, status: 400, error: `cwd not a directory: ${cwd}` }
    }
  } catch (e) {
    return { ok: false, status: 400, error: `invalid cwd: ${String(e)}` }
  }

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

  if (isExplicitCwd && allowedRoots.length > 0 && !isPathAllowed(cwd, allowedRoots)) {
    return { ok: false, status: 403, error: `cwd not allowed: ${cwd}` }
  }

  let cwdReal = cwd
  try {
    cwdReal = realpathSync(cwd)
  } catch {}
  return { ok: true, cwd, cwdReal, isExplicitCwd, allowedRoots }
}

function resolveConfinedFile(
  cwdReal: string,
  rawPath: string,
  allowNonExistent: boolean,
): { ok: true; relPath: string; resolvedPath: string } | { ok: false; status: number; error: string } {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    return { ok: false, status: 400, error: 'path is required' }
  }
  if (rawPath.includes('\0') || rawPath.includes('\\')) {
    return { ok: false, status: 400, error: 'invalid path characters' }
  }
  const cleanRel = rawPath.trim().replace(/^\/+/, '').replace(/^\.\//, '')
  if (!cleanRel || cleanRel === '.' || cleanRel.split('/').includes('..')) {
    return { ok: false, status: 400, error: 'path traversal is not allowed' }
  }
  const sanitized = sanitizePath(cleanRel)
  if (!sanitized.ok) {
    return { ok: false, status: 400, error: sanitized.reason ?? 'invalid path' }
  }
  const sensitiveReason = isSensitiveRelativePath(cleanRel)
  if (sensitiveReason) {
    return { ok: false, status: 403, error: sensitiveReason }
  }

  const rootWithSep = cwdReal.endsWith(sep) ? cwdReal : cwdReal + sep
  const resolved = resolve(cwdReal, cleanRel)
  if (!resolved.startsWith(rootWithSep)) {
    return { ok: false, status: 403, error: 'path escapes workspace root' }
  }

  if (existsSync(resolved)) {
    try {
      const realTarget = realpathSync(resolved)
      if (!realTarget.startsWith(rootWithSep)) {
        return { ok: false, status: 403, error: 'symlink escapes workspace root' }
      }
      return { ok: true, relPath: cleanRel, resolvedPath: realTarget }
    } catch {
      return { ok: false, status: 403, error: 'unable to verify target path' }
    }
  }

  if (!allowNonExistent) {
    return { ok: false, status: 404, error: `file not found: ${cleanRel}` }
  }

  // Verify nearest existing ancestor stays within cwdReal (prevents writing through escaped parent symlinks)
  let ancestor = dirname(resolved)
  while (ancestor && ancestor !== cwdReal && !existsSync(ancestor)) {
    const next = dirname(ancestor)
    if (next === ancestor) break
    ancestor = next
  }
  try {
    const realAncestor = realpathSync(ancestor)
    if (realAncestor !== cwdReal && !realAncestor.startsWith(rootWithSep)) {
      return { ok: false, status: 403, error: 'parent directory escapes workspace root' }
    }
  } catch {
    return { ok: false, status: 403, error: 'invalid parent directory' }
  }

  return { ok: true, relPath: cleanRel, resolvedPath: resolved }
}

function recordBrowserEditSnapshot(
  db: MiraDB | undefined,
  opts: { cwd: string; absPath: string; existedBefore: boolean; sessionId?: string },
): string | null {
  const sqlite = db?.sqlite
  if (!sqlite) return null
  try {
    let targetSessionId = opts.sessionId?.trim() || BROWSER_EDITOR_SESSION_ID
    const existingSession = sqlite
      .prepare('SELECT id FROM sessions WHERE id = ?')
      .get(targetSessionId) as { id: string } | undefined
    if (!existingSession) {
      targetSessionId = BROWSER_EDITOR_SESSION_ID
      const now = Date.now()
      sqlite
        .prepare(
          `INSERT OR IGNORE INTO sessions (id, title, agent, cwd, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(targetSessionId, 'Browser File Editor', 'human-editor', opts.cwd, now, now)
    }

    if (opts.existedBefore) {
      const snap = snapshotFile(db!, { sessionID: targetSessionId, path: opts.absPath })
      return snap?.id ?? null
    }

    const snapId = `snap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    sqlite
      .prepare(
        `INSERT INTO file_snapshots (id, session_id, message_id, path, content, created_at)
         VALUES (?, ?, ?, ?, NULL, ?)`,
      )
      .run(snapId, targetSessionId, null, opts.absPath, Date.now())
    return snapId
  } catch {
    return null
  }
}

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

function parseGitignoreContent(content: string): string[] {
  const out: string[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    out.push(trimmed)
  }
  return out
}

function loadIgnorePatterns(cwd: string): string[] {
  const patterns = [...DEFAULT_IGNORES]
  const seen = new Set<string>()
  const pushPatterns = (list: string[], prefix: string) => {
    for (const pat of list) {
      const isNeg = pat.startsWith('!')
      const raw = isNeg ? pat.slice(1) : pat
      if (!raw) continue
      // For nested .gitignore, prefix slash-containing patterns with their dir
      let effective = pat
      if (prefix && raw.includes('/')) {
        const stripped = raw.replace(/^\//, '')
        effective = (isNeg ? '!' : '') + prefix + '/' + stripped
      }
      if (!seen.has(effective)) {
        seen.add(effective)
        patterns.push(effective)
      }
    }
  }
  try {
    const gitignorePath = `${cwd}/.gitignore`
    if (existsSync(gitignorePath)) {
      const content = readFileSync(gitignorePath, 'utf-8')
      pushPatterns(parseGitignoreContent(content), '')
    }
    // Recurse **/.gitignore (not just root) — manual walk for reliability
    try {
      const walk = (dir: string, relPrefix: string) => {
        let dirents: Array<{ name: string; isDirectory(): boolean }>
        try {
          dirents = readdirSync(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const d of dirents) {
          const name = d.name
          if (d.isDirectory()) {
            if (name === '.git' || name === 'node_modules' || name === '.mira' || name === 'dist')
              continue
            const nextRel = relPrefix ? `${relPrefix}/${name}` : name
            // Check for .gitignore in this subdir
            const giPath = `${dir}/${name}/.gitignore`
            try {
              if (existsSync(giPath)) {
                const content = readFileSync(giPath, 'utf-8')
                pushPatterns(parseGitignoreContent(content), nextRel)
              }
            } catch {}
            walk(`${dir}/${name}`, nextRel)
          }
        }
      }
      walk(cwd, '')
    } catch {}
  } catch {}
  return patterns
}

function matchesPattern(file: string, pat: string): boolean {
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
    return false
  }
  if (!p.includes('/')) {
    const segments = file.split('/')
    if (segments.includes(p)) return true
  }
  return false
}

function isIgnored(file: string, patterns: string[]): boolean {
  let ignored = false
  for (const pat of patterns) {
    if (pat.startsWith('!')) {
      const neg = pat.slice(1).replace(/\/$/, '')
      if (!neg) continue
      if (matchesPattern(file, neg)) ignored = false
    } else {
      if (matchesPattern(file, pat)) ignored = true
    }
  }
  return ignored
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
    out.push({
      id: workspaceIdForPath(p),
      path: p,
      name: p.split('/').pop() || p,
      addedAt: Date.now(),
    })
  }
  const roots = (process.env.MIRA_WORKSPACE_ROOTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  for (const r of roots) {
    const p = r.replace(/\/$/, '') || '/'
    if (out.some((w) => w.path === p)) continue
    out.push({
      id: workspaceIdForPath(p),
      path: p,
      name: p.split('/').pop() || p,
      addedAt: Date.now(),
    })
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

export function mountWorkspaceRoutes(
  app: Hono<{ Variables: { requestId: string } }>,
  deps?: { db?: MiraDB },
) {
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
    if (!isAbsolute(absPath)) absPath = join(process.cwd(), absPath)
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
    const idx = existing.findIndex(
      (w) => w.id === id || w.path === id || (decoded && w.path === decoded),
    )
    if (idx === -1) {
      // Also check env workspaces — cannot delete env ones
      const env = envWorkspaces()
      if (env.some((w) => w.id === id || w.path === id || (decoded && w.path === decoded))) {
        return c.json(
          { error: 'cannot delete env workspace (MIRA_WORKSPACE/MIRA_WORKSPACE_ROOTS)' },
          403,
        )
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
    if (!isAbsolute(cwd)) {
      cwd = join(process.cwd(), cwd)
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
    // — but the explicit cwd itself must pass allowedRoots, otherwise a caller sending
    // e.g. ?cwd=/ would bypass root confinement entirely (same check as POST /workspaces).
    if (isExplicitCwd && allowedRoots.length > 0 && !isPathAllowed(cwd, allowedRoots)) {
      return c.json({ error: `cwd not allowed: ${cwd}` }, 403)
    }

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

    // Collect files — dot:true to include .env.example but filter via isIgnored correctly
    const allFiles: string[] = []
    try {
      for await (const file of glob.scan({ cwd, dot: true, onlyFiles: !includeDirs })) {
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

  // GET /workspace/file?path=...&cwd=... — confined read-only text preview
  app.get('/workspace/file', async (c) => {
    const cwdRes = resolveWorkspaceCwd(c.req.query('cwd'), c.req.query('projectId'))
    if (!cwdRes.ok) {
      return c.json({ error: cwdRes.error }, cwdRes.status as 400 | 403 | 404)
    }
    const reqPath = c.req.query('path') ?? ''
    const fileRes = resolveConfinedFile(cwdRes.cwdReal, reqPath, false)
    if (!fileRes.ok) {
      return c.json({ error: fileRes.error }, fileRes.status as 400 | 403 | 404)
    }
    try {
      const st = statSync(fileRes.resolvedPath)
      if (!st.isFile()) {
        return c.json({ error: 'target is not a regular file' }, 400)
      }
      if (st.size > MAX_PREVIEW_BYTES) {
        return c.json({
          ok: true,
          path: fileRes.relPath,
          cwd: cwdRes.cwdReal,
          size: st.size,
          mtime: st.mtimeMs,
          binary: false,
          tooLarge: true,
          content: null,
          lines: 0,
        })
      }
      const buf = readFileSync(fileRes.resolvedPath)
      const sampleLen = Math.min(buf.length, 8192)
      let isBinary = false
      for (let i = 0; i < sampleLen; i++) {
        if (buf[i] === 0) {
          isBinary = true
          break
        }
      }
      if (isBinary) {
        return c.json({
          ok: true,
          path: fileRes.relPath,
          cwd: cwdRes.cwdReal,
          size: st.size,
          mtime: st.mtimeMs,
          binary: true,
          tooLarge: false,
          content: null,
          lines: 0,
        })
      }
      const content = buf.toString('utf-8')
      return c.json({
        ok: true,
        path: fileRes.relPath,
        cwd: cwdRes.cwdReal,
        size: st.size,
        mtime: st.mtimeMs,
        binary: false,
        tooLarge: false,
        content,
        lines: content.length === 0 ? 0 : content.split('\n').length,
      })
    } catch (e) {
      return c.json({ error: `failed to read file: ${String(e)}` }, 500)
    }
  })

  // Shared handler for PUT (save/create) and POST (create new file)
  const writeWorkspaceFile = async (c: any, createOnly: boolean) => {
    let body: { path?: string; content?: string; cwd?: string; projectId?: string; sessionId?: string }
    try {
      body = (await c.req.json()) as typeof body
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400)
    }
    const cwdRes = resolveWorkspaceCwd(body.cwd, body.projectId)
    if (!cwdRes.ok) {
      return c.json({ error: cwdRes.error }, cwdRes.status as 400 | 403 | 404)
    }
    if (typeof body.content !== 'string') {
      return c.json({ error: 'content string is required' }, 400)
    }
    if (body.content.includes('\0')) {
      return c.json({ error: 'binary null bytes are not allowed in text files' }, 400)
    }
    if (Buffer.byteLength(body.content, 'utf8') > MAX_PREVIEW_BYTES) {
      return c.json({ error: `file exceeds ${MAX_PREVIEW_BYTES / 1024} KB edit limit` }, 413)
    }
    const fileRes = resolveConfinedFile(cwdRes.cwdReal, body.path ?? '', true)
    if (!fileRes.ok) {
      return c.json({ error: fileRes.error }, fileRes.status as 400 | 403 | 404)
    }
    const existedBefore = existsSync(fileRes.resolvedPath)
    if (createOnly && existedBefore) {
      return c.json({ error: `file already exists: ${fileRes.relPath}` }, 409)
    }
    if (existedBefore) {
      try {
        const st = statSync(fileRes.resolvedPath)
        if (!st.isFile()) {
          return c.json({ error: 'target is a directory, not a file' }, 400)
        }
      } catch {}
    }

    const snapshotId = recordBrowserEditSnapshot(deps?.db, {
      cwd: cwdRes.cwdReal,
      absPath: fileRes.resolvedPath,
      existedBefore,
      sessionId: body.sessionId,
    })

    try {
      mkdirSync(dirname(fileRes.resolvedPath), { recursive: true })
      writeFileSync(fileRes.resolvedPath, body.content, 'utf-8')
      const st = statSync(fileRes.resolvedPath)
      return c.json({
        ok: true,
        path: fileRes.relPath,
        cwd: cwdRes.cwdReal,
        size: st.size,
        mtime: st.mtimeMs,
        created: !existedBefore,
        snapshotId,
      })
    } catch (e) {
      return c.json({ error: `failed to write file: ${String(e)}` }, 500)
    }
  }

  app.put('/workspace/file', (c) => writeWorkspaceFile(c, false))
  app.post('/workspace/file', (c) => writeWorkspaceFile(c, true))

  // GET /workspace/git-status?cwd=... — porcelain status + current branch
  app.get('/workspace/git-status', async (c) => {
    const cwdRes = resolveWorkspaceCwd(c.req.query('cwd'), c.req.query('projectId'))
    if (!cwdRes.ok) {
      return c.json({ error: cwdRes.error }, cwdRes.status as 400 | 403 | 404)
    }
    try {
      const statusProc = Bun.spawnSync(
        ['git', '-C', cwdRes.cwdReal, 'status', '--porcelain=v1', '-uall'],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      if (statusProc.exitCode !== 0) {
        return c.json({ isGitRepo: false, branch: null, files: {} })
      }
      const branchProc = Bun.spawnSync(
        ['git', '-C', cwdRes.cwdReal, 'rev-parse', '--abbrev-ref', 'HEAD'],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      const branch =
        branchProc.exitCode === 0
          ? new TextDecoder().decode(branchProc.stdout).trim() || null
          : null

      const raw = new TextDecoder().decode(statusProc.stdout)
      const files: Record<string, string> = {}
      for (const line of raw.split('\n')) {
        if (line.length < 4) continue
        const xy = line.slice(0, 2)
        let rel = line.slice(3).trim()
        if (rel.includes(' -> ')) {
          rel = rel.split(' -> ').pop()?.trim() ?? rel
        }
        if (rel.startsWith('"') && rel.endsWith('"')) {
          rel = rel.slice(1, -1)
        }
        if (!rel) continue
        let badge = 'M'
        if (xy === '??') badge = '?'
        else if (xy.includes('A')) badge = 'A'
        else if (xy.includes('D')) badge = 'D'
        else if (xy.includes('R')) badge = 'R'
        files[rel] = badge
      }
      return c.json({ isGitRepo: true, branch, files })
    } catch {
      return c.json({ isGitRepo: false, branch: null, files: {} })
    }
  })
}
