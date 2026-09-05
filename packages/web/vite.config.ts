import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

// Dev-server API target: MIRA_DEV_API (full URL) or MIRA_DEV_PORT (port only).
// vite.config runs in Node, so plain process.env is available.
const API_TARGET =
  process.env.MIRA_DEV_API ?? `http://127.0.0.1:${process.env.MIRA_DEV_PORT ?? '4096'}`

export default defineConfig({
  plugins: [solid()],
  // GitHub Pages serves project sites under /<repo>/ — assets must resolve there.
  // Env override keeps other hosts (tunnel, PaaS, same-origin) on "/".
  base: process.env.VITE_BASE ?? '/mira/',
  server: {
    port: Number(process.env.MIRA_WEB_PORT ?? 3000),
    host: true,
    strictPort: true,
    hmr: { host: process.env.MIRA_HMR_HOST ?? 'localhost' },
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
      '/providers': API_TARGET,
      '/commands': API_TARGET,
      '/agents': API_TARGET,
      // WebSocket (GlobalBus) — catch-all must be last
      '/': { target: API_TARGET, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    target: 'esnext',
  },
})
