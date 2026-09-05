import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
// If @opentui/solid is not installed (disk full / missing), alias to local shim so build stays functional.
// When the real package is present, alias is still harmless — shim mirrors the API.
const hasOpentuiSolid = existsSync(resolve(__dirname, 'node_modules/@opentui/solid'))
const opentuiAlias: Record<string, string> = hasOpentuiSolid
  ? {}
  : { '@opentui/solid': resolve(__dirname, 'src/shim/opentui-solid.tsx') }

// Dev-server API target: MIRA_DEV_API (full URL) or MIRA_DEV_PORT (port only).
const API_TARGET =
  process.env.MIRA_DEV_API ?? `http://127.0.0.1:${process.env.MIRA_DEV_PORT ?? '4096'}`

export default defineConfig({
  plugins: [solid()],
  server: {
    port: Number(process.env.MIRA_TUI_PORT ?? 3001),
    host: true,
    strictPort: true,
    cors: true,
    hmr: { host: process.env.MIRA_HMR_HOST ?? 'localhost' },
    // Allow Cloudflare tunnel hosts — Vite ServerOptions allows boolean true
    allowedHosts: true,
    proxy: {
      // Proxy to the Mira server (Bun Hono) — same target as web
      '/session': API_TARGET,
      '/tools': API_TARGET,
      '/permission': API_TARGET,
      '/health': API_TARGET,
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
