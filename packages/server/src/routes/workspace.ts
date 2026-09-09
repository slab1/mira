import type { Hono } from 'hono'
import { Glob } from 'bun'
import { existsSync, readFileSync } from 'node:fs'
import { isPathAllowed, sanitizePath } from '../guardrails/index.js'

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

function loadIgnorePatterns(): string[] {
  const patterns = [...DEFAULT_IGNORES]
  try {
    if (existsSync('.gitignore')) {
      const content = readFileSync('.gitignore', 'utf-8')
      for (const line of content.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        if (trimmed.startsWith('!')) continue
        // strip trailing slash for consistency, but keep for matching
        patterns.push(trimmed)
      }
    }
  } catch {}
  return patterns
}

function isIgnored(file: string, patterns: string[]): boolean {
  for (const pat of patterns) {
    const p = pat.replace(/\/$/, '')
    // exact or prefix directory match
    if (file === p || file.startsWith(p + '/')) return true
    // wildcard handling via Glob
    if (p.includes('*')) {
      try {
        const g = new Glob(p)
        if (g.match(file)) return true
        const base = file.split('/').pop() ?? file
        if (g.match(base)) return true
      } catch {}
      // fallback for *.ext
      if (p.startsWith('*.')) {
        const suffix = p.slice(1)
        if (file.endsWith(suffix)) return true
      }
      continue
    }
    // plain directory name anywhere in path (e.g. "coverage" should match "a/coverage/b")
    if (!p.includes('/')) {
      const segments = file.split('/')
      if (segments.includes(p)) return true
    }
  }
  return false
}

export function mountWorkspaceRoutes(app: Hono<{ Variables: { requestId: string } }>) {
  app.get('/workspace/tree', async (c) => {
    const patterns = loadIgnorePatterns()
    const glob = new Glob('**/*')
    const cwd = process.cwd()
    const files: string[] = []
    try {
      for await (const file of glob.scan({ cwd, dot: false, onlyFiles: true })) {
        const sanitized = sanitizePath(file)
        if (!sanitized.ok) continue
        if (!isPathAllowed(file, [])) continue
        if (isIgnored(file, patterns)) continue
        files.push(file)
        if (files.length >= 500) break
      }
    } catch {}
    files.sort()
    return c.json({ files: files.slice(0, 500) })
  })
}
