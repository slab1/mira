import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { resolve, join, dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '../..')

function miraPortFallback(): string {
  const cands = [
    join(REPO_ROOT, '.mira/port'),
    join(REPO_ROOT, 'packages/server/.mira/port'),
    '.mira/port',
    '../.mira/port',
    '../../.mira/port',
    resolve('.mira/port'),
    resolve('../.mira/port'),
    resolve('../../.mira/port'),
  ]
  for (const p of cands) {
    try {
      if (existsSync(p)) {
        const raw = readFileSync(p, 'utf-8').trim()
        const n = Number(raw)
        if (Number.isFinite(n) && n > 0 && n <= 65535) return String(n)
      }
    } catch {}
  }
  return '4096'
}

// First-run token correspondence: the server auto-creates ~/.mira/mira.env
// on first boot. Inject its MIRA_TOKEN as the web dev fallback so the
// frontend authenticates without manual copy-paste. An explicit
// VITE_MIRA_TOKEN and localStorage `mira_token` still take precedence
// (see client getToken order).
function miraEnvToken(): string {
  const override = process.env.MIRA_DIR?.trim()
  const cands = [
    ...(override ? [join(override, 'mira.env')] : []),
    ...(process.env.XDG_CONFIG_HOME?.trim()
      ? [join(process.env.XDG_CONFIG_HOME.trim(), 'mira', 'mira.env')]
      : []),
    join(homedir(), '.mira', 'mira.env'),
  ]
  for (const p of cands) {
    try {
      if (!existsSync(p)) continue
      const m = readFileSync(p, 'utf-8').match(
        /^\s*MIRA_TOKEN\s*=\s*(['"]?)([0-9a-fA-F]{32,})\1\s*$/m,
      )
      const tok = m?.[2]
      if (tok) return tok
    } catch {}
  }
  return ''
}
// Explicit env wins; otherwise adopt the server-provisioned token.
// DEV ONLY — never bake token into prod bundle (NODE_ENV=production skips file read + define).
const FIRST_RUN_TOKEN =
  process.env.NODE_ENV !== 'production' ? process.env.VITE_MIRA_TOKEN?.trim() || miraEnvToken() : ''

// Dev-server API target: MIRA_DEV_API (full URL) or MIRA_DEV_PORT (port only).
// vite.config runs in Node, so plain process.env is available.
const API_TARGET =
  process.env.MIRA_DEV_API ?? `http://localhost:${process.env.MIRA_DEV_PORT ?? miraPortFallback()}`

export default defineConfig({
  plugins: [solid()],
  ...(process.env.NODE_ENV !== 'production' && FIRST_RUN_TOKEN
    ? { define: { 'import.meta.env.VITE_MIRA_TOKEN': JSON.stringify(FIRST_RUN_TOKEN) } }
    : {}),
  // GitHub Pages serves project sites under /<repo>/ — assets must resolve there.
  // Env override keeps other hosts (tunnel, PaaS, same-origin) on "/".
  base: process.env.VITE_BASE ?? '/mira/',
  server: {
    port: Number(process.env.MIRA_WEB_PORT ?? 3000),
    host: true,
    strictPort: false,
    hmr: {
      host: process.env.MIRA_HMR_HOST ?? 'localhost',
      port: Number(process.env.MIRA_WEB_HMR_PORT ?? 24678),
    },
    cors: true,
    // Allow Cloudflare tunnel hosts — Vite ServerOptions allows boolean true (Vite 6+)
    allowedHosts: true,
    proxy: {
      // Proxy API + WebSocket to Mira server (IPv4 — server binds 127.0.0.1).
      // changeOrigin: true forwards the Origin/Authorization headers so the
      // server's auth gate sees the bearer token the browser sent.
      '/session': { target: API_TARGET, changeOrigin: true },
      '/tools': { target: API_TARGET, changeOrigin: true },
      '/permission': { target: API_TARGET, changeOrigin: true },
      '/health': { target: API_TARGET, changeOrigin: true },
      '/skills': { target: API_TARGET, changeOrigin: true },
      '/mcp': { target: API_TARGET, changeOrigin: true },
      '/dev': { target: API_TARGET, changeOrigin: true },
      '/learning': { target: API_TARGET, changeOrigin: true },
      '/knowledge': { target: API_TARGET, changeOrigin: true },
      '/finding': { target: API_TARGET, changeOrigin: true },
      '/job': { target: API_TARGET, changeOrigin: true },
      '/guardrails': { target: API_TARGET, changeOrigin: true },
      '/config': { target: API_TARGET, changeOrigin: true },
      '/provider': { target: API_TARGET, changeOrigin: true },
      '/providers': { target: API_TARGET, changeOrigin: true },
      '/commands': { target: API_TARGET, changeOrigin: true },
      '/agents': { target: API_TARGET, changeOrigin: true },
      '/admin': { target: API_TARGET, changeOrigin: true },
      '/workspaces': { target: API_TARGET, changeOrigin: true },
      '/workspace': { target: API_TARGET, changeOrigin: true },
      '/complete': { target: API_TARGET, changeOrigin: true },
      '/autocomplete': { target: API_TARGET, changeOrigin: true },
      '/terminal': { target: API_TARGET, changeOrigin: true },
      '/metrics': { target: API_TARGET, changeOrigin: true },
      // WebSocket (GlobalBus) — catch-all must be last; HMR WS isolated on 24678 so it never hits this proxy.
      // bypass() keeps Vite's own dev requests local: without it the '/'
      // catch-all hijacks /src/*, /@vite/*, /node_modules/* etc. and forwards
      // them to the API server (which 404/401s them) → black screen.
      // Verified against vite 6.4.3 bundled code: bypass returning a string
      // rewrites req.url and calls next() (Vite serves it); nullish continues
      // to the proxy (API + WS upgrades, which arrive with res undefined).
      '/': {
        target: API_TARGET,
        ws: true,
        changeOrigin: true,
        bypass: (req, res) => {
          const upgrade = (req.headers?.upgrade || '').toLowerCase()
          if (!res || upgrade) return null
          const url = req.url || ''
          if (
            url === '/' ||
            url.startsWith('/?') ||
            url === '/index.html' ||
            url === '/mira' ||
            url === '/mira/' ||
            url === '/mira/index.html' ||
            url.startsWith('/src/') ||
            url.startsWith('/@vite/') ||
            url.startsWith('/@id/') ||
            url.startsWith('/@fs/') ||
            url.startsWith('/node_modules/')
          )
            return url
          return null
        },
        configure: (proxy) => {
          // Gracefully ignore writeAfterFIN during bun --watch restart (HMR reconnect)
          // and ECONNREFUSED while the server is (re)starting or has rotated ports —
          // Vite retries the proxy on the next request; logging the AggregateError
          // on every request is pure noise. Fix the target by restarting web after
          // the server is up (it reads .mira/port at startup) or via MIRA_DEV_PORT.
          proxy.on('error', (err: Error & { code?: string }) => {
            const msg = String(err?.message ?? err)
            const code = (err as { code?: string })?.code
            if (
              msg.includes('writeAfterFIN') ||
              code === 'ECONNRESET' ||
              code === 'ECONNREFUSED' ||
              msg.includes('ECONNREFUSED')
            )
              return
          })
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    target: 'esnext',
  },
})
