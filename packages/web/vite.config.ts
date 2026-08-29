import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

export default defineConfig({
  plugins: [solid()],
  // GitHub Pages serves project sites under /<repo>/ — assets must resolve there.
  // Env override keeps other hosts (tunnel, PaaS, same-origin) on "/".
  base: process.env.VITE_BASE ?? "/mira/",
  server: {
    port: 3000,
    host: true,
    strictPort: true,
    hmr: { host: 'localhost' },
    cors: true,
    // Allow Cloudflare tunnel hosts — Vite ServerOptions allows boolean true (Vite 6+)
    allowedHosts: true,
    proxy: {
      // Proxy API + WebSocket to Mira server (IPv4 — server binds 127.0.0.1)
      "/session": "http://127.0.0.1:4096",
      "/tools": "http://127.0.0.1:4096",
      "/permission": "http://127.0.0.1:4096",
      "/health": "http://127.0.0.1:4096",
      "/skills": "http://127.0.0.1:4096",
      "/mcp": "http://127.0.0.1:4096",
      "/dev": "http://127.0.0.1:4096",
      "/learning": "http://127.0.0.1:4096",
      "/config": "http://127.0.0.1:4096",
      "/providers": "http://127.0.0.1:4096",
      "/commands": "http://127.0.0.1:4096",
      "/agents": "http://127.0.0.1:4096",
      // WebSocket (GlobalBus) — catch-all must be last
      "/": { target: "http://127.0.0.1:4096", ws: true },
    },
  },
  build: {
    outDir: "dist",
    target: "esnext",
  },
})
