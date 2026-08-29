import { defineConfig } from "vite"
import solid from "vite-plugin-solid"
import { fileURLToPath } from "node:url"
import { existsSync } from "node:fs"
import { resolve, dirname } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
// If @opentui/solid is not installed (disk full / missing), alias to local shim so build stays functional.
// When the real package is present, alias is still harmless — shim mirrors the API.
const hasOpentuiSolid = existsSync(resolve(__dirname, "node_modules/@opentui/solid"))
const opentuiAlias: Record<string, string> = hasOpentuiSolid ? {} : { "@opentui/solid": resolve(__dirname, "src/shim/opentui-solid.tsx") }

export default defineConfig({
  plugins: [solid()],
  server: {
    port: 3001,
    host: true,
    strictPort: true,
    cors: true,
    hmr: { host: 'localhost' },
    // Allow Cloudflare tunnel hosts — Vite ServerOptions allows boolean true
    allowedHosts: true,
    proxy: {
      // Proxy to Mira server (Bun Hono on :4096) — same as web
      "/session": "http://localhost:4096",
      "/tools": "http://localhost:4096",
      "/permission": "http://localhost:4096",
      "/health": "http://localhost:4096",
    },
  },
  build: {
    outDir: "dist",
    target: "esnext",
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      ...(opentuiAlias),
    },
  },
})
