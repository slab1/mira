import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

export default defineConfig({
  plugins: [solid()],
  server: {
    port: 3000,
    proxy: {
      // Proxy API + WebSocket to Mira server (Bun Hono on :4096)
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
})
