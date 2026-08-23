import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

export default defineConfig({
  plugins: [solid()],
  server: {
    port: 3000,
    host: true,
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
      // WebSocket (GlobalBus) — catch-all must be last
      "/": { target: "http://127.0.0.1:4096", ws: true },
    },
  },
  build: {
    outDir: "dist",
    target: "esnext",
  },
})
