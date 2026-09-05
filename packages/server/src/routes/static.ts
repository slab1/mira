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

  // Landing page — friendly index when opened in a browser
  app.get('/', async (c: Context) => {
    try {
      const indexFile = Bun.file(`${import.meta.dir}/../../web/dist/index.html`)
      if (await indexFile.exists()) return c.html(await indexFile.text())
    } catch {}
    try {
      const altIndex = Bun.file(`${import.meta.dir}/../dist/index.html`)
      if (await altIndex.exists()) return c.html(await altIndex.text())
    } catch {}
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
  app.get('/*', async (c: Context, next: () => Promise<void>) => {
    const path = c.req.path
    if (isApiRoute(path)) return await next()
    try {
      const candidates = [
        `${import.meta.dir}/../../web/dist${path}`,
        `${import.meta.dir}/../dist${path}`,
      ]
      for (const fp of candidates) {
        const f = Bun.file(fp)
        if (await f.exists()) {
          const ext = fp.split('.').pop() ?? ''
          const ct = CONTENT_TYPES[ext] ?? 'text/plain'
          return new Response(f.stream() as BodyInit, {
            headers: { 'Content-Type': ct, 'Cache-Control': 'max-age=3600' },
          })
        }
      }
      // SPA fallback: serve index.html for unknown routes when web build exists
      const index = Bun.file(`${import.meta.dir}/../../web/dist/index.html`)
      if (await index.exists()) {
        if (!path.includes('.')) return c.html(await index.text())
      }
    } catch {}
    return await next()
  })
}
