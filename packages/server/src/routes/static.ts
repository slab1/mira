import type { Hono, Context } from 'hono'
import type { ToolRegistry } from '../tools/registry.js'

const API_ROUTE_PREFIXES = [
  '/health',
  '/dev/',
  '/metrics',
  '/session',
  '/mcp',
  '/config',
  '/providers',
  '/provider',
  '/tools',
  '/agents',
  '/skills',
  '/commands',
  '/finding',
  '/job',
  '/task',
  '/jobs',
  '/terminal',
  '/learning',
  '/knowledge',
  '/permission',
  '/guardrails',
  '/admin',
  '/manager',
  '/complete',
  '/autocomplete',
  '/workspaces',
  '/workspace',
  // Phase 1-6 evolution stack + pre-existing routes that were being
  // swallowed by the SPA fallback when static was mounted before them:
  '/evolution',
  '/engines',
  '/shadow',
  '/canary',
  '/memory',
  '/gateway',
  '/me',
  '/webhooks',
  '/v1',
  '/symbol',
]

function isApiRoute(path: string): boolean {
  return API_ROUTE_PREFIXES.some((prefix) => path.startsWith(prefix))
}

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html',
  js: 'application/javascript',
  css: 'text/css',
  json: 'application/json',
  svg: 'image/svg+xml',
}

export function mountStaticRoutes(
  app: Hono<{ Variables: { requestId: string } }>,
  deps: { tools: ToolRegistry },
) {
  const { tools } = deps

  // Candidate web-dist roots: source layout (src/routes/* → packages/web/dist)
  // plus build layout (dist/routes/* → packages/web/dist). static.ts moved
  // from src/ to src/routes/ without updating these (2026-09-21: dist was
  // never found, so / always fell through to the landing page).
  const distRoots = [
    `${import.meta.dir}/../../../web/dist`,
    `${import.meta.dir}/../../../../web/dist`,
    `${import.meta.dir}/../dist`,
  ]
  async function findDistFile(rel: string): Promise<ReturnType<typeof Bun.file> | null> {
    const clean = rel.replace(/^\/+/, '')
    for (const root of distRoots) {
      try {
        const f = Bun.file(`${root}/${clean}`)
        if (await f.exists()) return f
      } catch {}
    }
    return null
  }

  // Landing page — friendly index when opened in a browser
  app.get('/', async (c: Context) => {
    const indexFile = await findDistFile('index.html')
    if (indexFile) return c.html(await indexFile.text())
    return c.html(`<!doctype html>
<html><head><meta charset="utf-8"><title>Mira</title>
<style>
  body{background:#09090b;color:#e4e4e7;font-family:ui-sans-serif,system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
  .card{max-width:640px;padding:32px;border:1px solid #27272a;border-radius:16px;background:#18181b}
  h1{margin:0 0 8px;font-size:22px}
  p{color:#a1a1aa;font-size:13px;line-height:1.6}
  code{background:#27272a;padding:2px 6px;border-radius:6px;font-size:12px;color:#c4b5fd}
  .live{color:#86efac}
  .clients{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:12px}
  .client-card{padding:10px;border:1px solid #27272a;border-radius:10px;background:#27272a}
  .client-card strong{color:#e4e4e7;font-size:12px}
  .client-card span{color:#a1a1aa;font-size:11px}
</style></head>
<body><div class="card">
  <h1>Mira <span class="live">● live</span></h1>
  <p>Agent engine v0.1.0 · ${tools.count()} tools · gateway cost-tracked · WS / (Bus) · WS /terminal (PTY)</p>
  <p>API: <code>/health</code> · <code>/session</code> · <code>/terminal</code> · <code>/jobs</code> · <code>/finding</code> · <code>/mcp</code> · <code>/providers</code></p>
  <div class="clients">
    <div class="client-card"><strong>Web</strong><br><span>bun run dev in packages/web → :3000 (proxy :4096) or <code>vite build</code> → served here</span></div>
    <div class="client-card"><strong>TUI</strong><br><span>bun run dev in packages/tui → :3001 (proxy)</span></div>
    <div class="client-card"><strong>VS Code</strong><br><span>Extension: set <code>mira.apiUrl</code> + <code>mira.token</code> (SecretStorage)</span></div>
  </div>
  <p style="margin-top:12px">CORS: <code>CORS_ORIGINS</code> allowlists prod; <code>vscode-webview://</code> + <code>http://localhost:*</code> always allowed. Host: <code>HOST=127.0.0.1</code> (dev) or <code>0.0.0.0</code> (Docker/remote).</p>
</div></body></html>`)
  })

  // Static for web build (when `vite build` has run) — serves /assets/*, etc.
  // The built app uses Vite `base: '/mira/'`, so asset URLs arrive as
  // /mira/assets/* — strip the base prefix before looking up dist files.
  app.get('/*', async (c: Context, next: () => Promise<void>) => {
    const path = c.req.path
    if (isApiRoute(path)) return await next()
    try {
      const lookup =
        path === '/mira' || path.startsWith('/mira/') ? path.slice('/mira'.length) || '/' : path
      const f = await findDistFile(lookup)
      if (f) {
        const ext = lookup.split('.').pop() ?? ''
        const ct = CONTENT_TYPES[ext] ?? 'text/plain'
        return new Response(f.stream() as BodyInit, {
          headers: { 'Content-Type': ct, 'Cache-Control': 'max-age=3600' },
        })
      }
      // SPA fallback: serve index.html for unknown routes when web build exists
      const index = await findDistFile('index.html')
      if (index) {
        if (!path.includes('.')) return c.html(await index.text())
      }
    } catch {}
    return await next()
  })
}
