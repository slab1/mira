import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'

function miraPortFallback(): string {
  const cands = [
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
  process.env.NODE_ENV !== 'production'
    ? process.env.VITE_MIRA_TOKEN?.trim() || miraEnvToken()
    : ''

// Dev-server API target: MIRA_DEV_API (full URL) or MIRA_DEV_PORT (port only).
// vite.config runs in Node, so plain process.env is available.
const API_TARGET =
  process.env.MIRA_DEV_API ?? `http://127.0.0.1:${process.env.MIRA_DEV_PORT ?? miraPortFallback()}`

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
    strictPort: true,
    hmr: { host: process.env.MIRA_HMR_HOST ?? 'localhost', port: 24678 },
    cors: true,
    // Allow Cloudflare tunnel hosts — Vite ServerOptions allows boolean true (Vite 6+)
    allowedHosts: true,
    proxy: {
      // Proxy API + WebSocket to Mira server (IPv4 — server binds 127.0.0.1)
      '/session': API_TARGET,
      '/tools': API_TARGET,
      '/permission': API_TARGET,
      '/health': API_TARGET,
      '/skills': API_TARGET,
      '/mcp': API_TARGET,
      '/dev': API_TARGET,
      '/learning': API_TARGET,
      '/knowledge': API_TARGET,
      '/finding': API_TARGET,
      '/job': API_TARGET,
      '/guardrails': API_TARGET,
      '/config': API_TARGET,
      '/provider': API_TARGET,
      '/providers': API_TARGET,
      '/commands': API_TARGET,
      '/agents': API_TARGET,
      '/admin': API_TARGET,
      '/workspaces': API_TARGET,
      '/workspace': API_TARGET,
      '/complete': API_TARGET,
      '/autocomplete': API_TARGET,
      '/terminal': API_TARGET,
      '/metrics': API_TARGET,
      // WebSocket (GlobalBus) — catch-all must be last; HMR WS isolated on 24678 so it never hits this proxy
      '/': {
        target: API_TARGET,
        ws: true,
        configure: (proxy) => {
          // Gracefully ignore writeAfterFIN during bun --watch restart (HMR reconnect)
          proxy.on('error', (err: Error & { code?: string }) => {
            const msg = String(err?.message ?? err)
            if (msg.includes('writeAfterFIN') || (err as { code?: string })?.code === 'ECONNRESET') return
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
