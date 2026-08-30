#!/usr/bin/env bash
# Self-healing tunnel + server watchdog for Mira.
#
# Why: this Cloudflare account's named-tunnel domain (slab1-mira.dpdns.org) is not
# publicly resolvable, so a stable named URL isn't available without a custom domain.
# The quick tunnel (trycloudflare.com) IS public but ephemeral (new URL each restart).
# This watchdog keeps the quick tunnel (and the server) alive, and whenever the
# public URL changes it syncs it to the GitHub Pages VITE_API_URL var and triggers a
# Pages redeploy — so the web UI always points at the current tunnel with ZERO manual
# intervention. Restarting cloudflared no longer breaks the UI.
#
# Usage: scripts/tunnel-watchdog.sh start | stop | status
set -uo pipefail

MIRA_ENV="${HOME}/.mira/mira.env"
LOG_DIR="${HOME}/.mira"
PORT="${MIRA_PORT:-4096}"
CF_PID="${LOG_DIR}/cloudflared.pid"
CF_LOG="${LOG_DIR}/cloudflared.log"
SRV_PID="${LOG_DIR}/mira.pid"
SRV_LOG="${LOG_DIR}/mira.log"
URL_FILE="${LOG_DIR}/cf-public-url.txt"
WATCH_PID="${LOG_DIR}/watchdog.pid"
REPO="slab1/mira"
INTERVAL=30

alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

start_server() {
  if curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then return 0; fi
  echo "[watchdog $(date -u +%H:%M:%S)] server down — restarting"
  setsid bash -c "set -a; . ${MIRA_ENV}; set +a; export HOST=127.0.0.1 PORT=${PORT} CORS_ORIGINS=https://slab1.github.io; cd /tmp/aether; exec bun packages/server/src/index.ts" >>"${SRV_LOG}" 2>&1 </dev/null &
  echo $! > "${SRV_PID}"
}

start_tunnel() {
  # 404 fix: remove login artifacts that break quick tunnels (see docs/production-setup.md)
  if [ -d "${HOME}/.cloudflared" ]; then
    rm -f "${HOME}/.cloudflared/config.yml" "${HOME}/.cloudflared/"*.json "${HOME}/.cloudflared/cert.pem" 2>/dev/null || true
  fi
  echo "[watchdog $(date -u +%H:%M:%S)] starting quick tunnel"
  cloudflared tunnel --url "http://localhost:${PORT}" --no-autoupdate >"${CF_LOG}" 2>&1 </dev/null &
  echo $! > "${CF_PID}"
  URL=""
  for _ in $(seq 1 25); do
    sleep 2
    URL=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "${CF_LOG}" 2>/dev/null | head -1)
    [ -n "$URL" ] && break
  done
  if [ -n "$URL" ]; then
    echo "$URL" > "${URL_FILE}"
    echo "[watchdog $(date -u +%H:%M:%S)] tunnel URL: ${URL}"
    sync_pages "$URL"
  else
    echo "[watchdog $(date -u +%H:%M:%S)] FAILED to capture tunnel URL"
  fi
}

sync_pages() {
  local url="$1"
  echo "[watchdog $(date -u +%H:%M:%S)] syncing VITE_API_URL + redeploy Pages"
  if gh variable set VITE_API_URL --body "$url" --repo "${REPO}" >/dev/null 2>&1 && \
     gh workflow run pages.yml --repo "${REPO}" >/dev/null 2>&1; then
    echo "[watchdog $(date -u +%H:%M:%S)] Pages redeploy triggered"
  else
    echo "[watchdog $(date -u +%H:%M:%S)] gh sync failed (check gh auth)"
  fi
}

check_public_exposure() {
  local url="$1"
  [ -z "$url" ] && return 0
  # Public exposure watchdog: ensure tunnel URL requires auth (401 without token)
  # If MIRA_TOKEN is set, unauthenticated /session should be 401; if 200, server is exposed
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" "$url/session" 2>/dev/null || echo "000")
  if [ "$code" = "200" ]; then
    echo "[watchdog $(date -u +%H:%M:%S)] ⚠️  PUBLIC EXPOSURE: $url/session returned 200 without auth — MIRA_TOKEN may be missing or gate disabled"
  elif [ "$code" = "401" ]; then
    echo "[watchdog $(date -u +%H:%M:%S)] public exposure check: $url/session correctly requires auth (401)"
  fi
}

loop() {
  local last_url="$(cat "${URL_FILE}" 2>/dev/null)"
  while true; do
    # 1. Server
    if ! curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
      start_server
    fi
    # 2. Tunnel
    if ! alive "${CF_PID}"; then
      start_tunnel
      last_url="$(cat "${URL_FILE}" 2>/dev/null)"
      [ -n "$last_url" ] && check_public_exposure "$last_url"
    else
      local cur
      cur=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "${CF_LOG}" 2>/dev/null | tail -1)
      if [ -n "$cur" ] && [ "$cur" != "$last_url" ]; then
        echo "$cur" > "${URL_FILE}"
        last_url="$cur"
        sync_pages "$cur"
        check_public_exposure "$cur"
      fi
    fi
    # 3. Periodic public exposure watchdog (every 5 min)
    if [ $(( $(date +%s) % 300 )) -lt 30 ] && [ -n "$last_url" ]; then
      check_public_exposure "$last_url"
    fi
    sleep "${INTERVAL}"
  done
}

case "${1:-start}" in
  start)
    if alive "${WATCH_PID}"; then echo "[watchdog] already running ($(cat "${WATCH_PID}"))"; exit 0; fi
    setsid bash "$0" _loop >"${LOG_DIR}/watchdog.log" 2>&1 </dev/null &
    echo $! > "${WATCH_PID}"
    echo "[watchdog] started (pid $(cat "${WATCH_PID}"))"
    ;;
  stop)
    if alive "${WATCH_PID}"; then kill "$(cat "${WATCH_PID}")" 2>/dev/null && rm -f "${WATCH_PID}" && echo "[watchdog] stopped"; else echo "[watchdog] not running"; fi
    ;;
  status)
    if alive "${WATCH_PID}"; then echo "[watchdog] running ($(cat "${WATCH_PID}"))"; else echo "[watchdog] stopped"; fi
    echo "tunnel URL: $(cat "${URL_FILE}" 2>/dev/null || echo none)"
    ;;
  _loop) loop ;;
esac
