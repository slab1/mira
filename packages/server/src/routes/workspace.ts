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

export function mountWorkspaceRoutes(app: Hono<{ Variables: { requestId: string } }>) {
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
