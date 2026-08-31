/* Mira PWA service worker — precaches the app shell; API calls go to network. */
const CACHE = "mira-shell-v1"
const SHELL = ["./", "./manifest.json"]

// Install: precache the static shell so the app opens offline once visited.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => {})
  )
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

// Network-first for everything: the API (session/prompt/metrics/health) is dynamic and
// must hit the server; only fall back to the cached shell for navigation requests when
// offline so the login card still opens.
self.addEventListener("fetch", (event) => {
  const { request } = event
  if (request.method !== "GET") return
  const url = new URL(request.url)
  // Never cache API/SSE/token traffic.
  if (url.pathname.includes("/session") || url.pathname.includes("/prompt") || url.pathname.includes("/health") || url.pathname.includes("/metrics") || url.pathname.includes("/config")) return

  event.respondWith(
    fetch(request)
      .then((res) => {
        // Only cache same-origin, non-API, success responses.
        if (res && res.ok && url.origin === self.location.origin) {
          const copy = res.clone()
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {})
        }
        return res
      })
      .catch(() =>
        // Offline: serve the shell for navigation; skip otherwise.
        caches.match(request).then((hit) => hit || (request.mode === "navigate" ? caches.match("./") : undefined))
      )
  )
})
