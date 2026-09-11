import type { Hono } from 'hono'
import { existsSync, statSync } from 'node:fs'
import { sanitizePath } from '../guardrails/index.js'
import { getSymbolIndex } from '../symbols/index.js'

export function mountSymbolRoutes(app: Hono<{ Variables: { requestId: string } }>) {
  // GET /workspace/symbol?cwd=/tmp/other&query=Foo  — workspace-aware symbol search
  // GET /workspace/symbol?cwd=/tmp/other&file=src/foo.ts — symbols in file
  // GET /workspace/symbol?cwd=/tmp/other — list all workspace symbols (limited)
  app.get('/workspace/symbol', async (c) => {
    const cwdQuery = c.req.query('cwd')
    const query = c.req.query('query') ?? c.req.query('name') ?? c.req.query('q')
    const file = c.req.query('file')
    const limitStr = c.req.query('limit')

    let cwd = process.cwd()
    if (cwdQuery) cwd = cwdQuery
    const sanitizedCwd = sanitizePath(cwd)
    if (!sanitizedCwd.ok) {
      const reason = sanitizedCwd.reason ?? ''
      if (reason.includes('traversal') || reason.includes('null byte') || reason.includes('encoded')) {
        return c.json({ error: `invalid cwd: ${reason}` }, 400)
      }
    } else {
      cwd = sanitizedCwd.sanitized ?? cwd
    }
    if (!cwd.startsWith('/')) cwd = `${process.cwd()}/${cwd}`
    cwd = cwd.replace(/\/+/g, '/').replace(/\/$/, '') || '/'

    try {
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
        return c.json({ error: `cwd not found: ${cwd}` }, 404)
      }
    } catch (e) {
      return c.json({ error: `invalid cwd: ${String(e)}` }, 400)
    }

    let limit = 100
    if (limitStr) {
      const n = parseInt(limitStr, 10)
      if (!isNaN(n) && n > 0) limit = Math.min(n, 500)
    }

    const idx = getSymbolIndex(cwd)

    // File-specific symbols
    if (file) {
      const sanitizedFile = sanitizePath(file)
      if (!sanitizedFile.ok) return c.json({ error: `invalid file: ${sanitizedFile.reason}` }, 400)
      const rel = sanitizedFile.sanitized ?? file
      try {
        const symbols = await idx.ensureIndexed(rel, cwd)
        return c.json({ cwd, file: rel, symbols: symbols.slice(0, limit), count: symbols.length })
      } catch (e) {
        return c.json({ error: String(e) }, 500)
      }
    }

    // Workspace symbol search
    if (query) {
      try {
        const results = await idx.findSymbolInWorkspace(query, cwd)
        return c.json({ cwd, query, symbols: results.slice(0, limit), count: results.length })
      } catch (e) {
        return c.json({ error: String(e) }, 500)
      }
    }

    // List all symbols (glob + parse)
    try {
      const files = await (idx as unknown as { glob: (p: string, cwd?: string) => Promise<string[]> }).glob('**/*.{ts,tsx,js,jsx}', cwd)
      const all: unknown[] = []
      for (const f of files.slice(0, 50)) {
        const syms = await idx.ensureIndexed(f, cwd)
        for (const s of syms) {
          all.push(s)
          if (all.length >= limit) break
        }
        if (all.length >= limit) break
      }
      return c.json({ cwd, symbols: all, count: all.length, files: files.length })
    } catch (e) {
      return c.json({ error: String(e) }, 500)
    }
  })
}
