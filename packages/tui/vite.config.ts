import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '../..')
// If @opentui/solid is not installed (disk full / missing), alias to local shim so build stays functional.
// When the real package is present, alias is still harmless — shim mirrors the API.
// NOTE: with Bun/npm workspaces deps hoist to the repo root, so check both the
// package-local and the root node_modules before falling back to the shim.
const hasOpentuiSolid =
  existsSync(resolve(__dirname, 'node_modules/@opentui/solid')) ||
  existsSync(resolve(REPO_ROOT, 'node_modules/@opentui/solid'))
const opentuiAlias: Record<string, string> = hasOpentuiSolid
  ? {}
  : { '@opentui/solid': resolve(__dirname, 'src/shim/opentui-solid.tsx') }

function miraPortFallback(): string {
  // Resolve repo-root .mira/port first (server writes it there) — cwd-relative
  // lookups break under `turbo dev` where cwd is the package dir and the file
  // may not exist yet when Vite starts (server rotation race).
  const cands = [
    join(REPO_ROOT, '.mira/port'),
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

// Dev-server API target: MIRA_DEV_API (full URL) or MIRA_DEV_PORT (port only).
const API_TARGET =
  process.env.MIRA_DEV_API ?? `http://localhost:${process.env.MIRA_DEV_PORT ?? miraPortFallback()}`

export default defineConfig({
  plugins: [solid()],
  server: {
    port: Number(process.env.MIRA_TUI_PORT ?? 3002),
    host: true,
    strictPort: false,
    cors: true,
    hmr: {
      host: process.env.MIRA_HMR_HOST ?? 'localhost',
      port: Number(process.env.MIRA_TUI_HMR_PORT ?? 24679),
    },
    // Allow Cloudflare tunnel hosts — Vite ServerOptions allows boolean true
    allowedHosts: true,
    proxy: {
      // Proxy to the Mira server (Bun Hono) — same target as web.
      // changeOrigin: true forwards the Origin/Authorization headers
      // so the server's auth gate sees the bearer token.
      '/session': { target: API_TARGET, changeOrigin: true },
      '/tools': { target: API_TARGET, changeOrigin: true },
      '/permission': { target: API_TARGET, changeOrigin: true },
      '/health': { target: API_TARGET, changeOrigin: true },
      '/config': { target: API_TARGET, changeOrigin: true },
      '/providers': { target: API_TARGET, changeOrigin: true },
      '/commands': { target: API_TARGET, changeOrigin: true },
      '/agents': { target: API_TARGET, changeOrigin: true },
      '/skills': { target: API_TARGET, changeOrigin: true },
      '/mcp': { target: API_TARGET, changeOrigin: true },
      '/dev': { target: API_TARGET, changeOrigin: true },
      '/learning': { target: API_TARGET, changeOrigin: true },
      '/knowledge': { target: API_TARGET, changeOrigin: true },
      '/finding': { target: API_TARGET, changeOrigin: true },
      '/job': { target: API_TARGET, changeOrigin: true },
      '/guardrails': { target: API_TARGET, changeOrigin: true },
      '/admin': { target: API_TARGET, changeOrigin: true },
      '/workspaces': { target: API_TARGET, changeOrigin: true },
      '/workspace': { target: API_TARGET, changeOrigin: true },
      '/complete': { target: API_TARGET, changeOrigin: true },
      '/autocomplete': { target: API_TARGET, changeOrigin: true },
      '/terminal': { target: API_TARGET, changeOrigin: true },
      '/metrics': { target: API_TARGET, changeOrigin: true },
      // WebSocket (GlobalBus + terminal) — catch-all must be last; HMR WS isolated on 24679 so it never hits this proxy
      '/': {
        target: API_TARGET,
        ws: true,
        changeOrigin: true,
        configure: (proxy) => {
          // Ignore restart/rotation noise (see web vite.config.ts): the API
          // target is frozen at startup and the server may still be starting
          // or have rotated ports — Vite retries on the next request.
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
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      ...opentuiAlias,
    },
  },
})
