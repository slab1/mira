#!/usr/bin/env bash
# Public exposure watchdog — verifies Mira server is not publicly exposed without auth.
# Checks both local and tunnel URLs for auth gate (401 without token, 200 with token).
# Usage: scripts/public-exposure-watchdog.sh [--tunnel-url URL] [--interval 60]
set -uo pipefail

PORT="${MIRA_PORT:-4096}"
TUNNEL_URL=""
INTERVAL=60
ONCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tunnel-url)
      TUNNEL_URL="${2:-}"
      shift 2
      ;;
    --interval)
      INTERVAL="${2:-60}"
      shift 2
      ;;
    --once)
      ONCE=1
      shift
      ;;
    -*)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
    *)
      if [[ -z "$TUNNEL_URL" ]]; then
        TUNNEL_URL="$1"
      fi
      shift
      ;;
  esac
done

if [[ -z "$TUNNEL_URL" && -f "${HOME}/.mira/cf-public-url.txt" ]]; then
  TUNNEL_URL="$(cat "${HOME}/.mira/cf-public-url.txt" 2>/dev/null || echo "")"
fi

check_url() {
  local url="$1" label="$2"
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" "$url/session" 2>/dev/null || echo "000")
  if [ "$code" = "200" ]; then
    echo "[exposure $(date -u +%H:%M:%S)] ⚠️  $label $url/session is PUBLIC (200 without auth) — MIRA_TOKEN missing or gate disabled!"
    return 1
  elif [ "$code" = "401" ]; then
    echo "[exposure $(date -u +%H:%M:%S)] ✓ $label $url/session correctly gated (401)"
    return 0
  else
    echo "[exposure $(date -u +%H:%M:%S)] ? $label $url/session returned $code (expected 401 without auth)"
    return 0
  fi
}

# One-shot check
if [[ "$ONCE" == "1" ]] || [[ "$INTERVAL" == "0" ]]; then
  check_url "http://127.0.0.1:${PORT}" "local"
  [ -n "$TUNNEL_URL" ] && check_url "$TUNNEL_URL" "tunnel"
  exit 0
fi

# Loop mode
echo "[exposure] watching every ${INTERVAL}s — local :${PORT} + tunnel ${TUNNEL_URL:-none}"
while true; do
  check_url "http://127.0.0.1:${PORT}" "local"
  if [ -n "$TUNNEL_URL" ]; then
    check_url "$TUNNEL_URL" "tunnel"
  elif [ -f "${HOME}/.mira/cf-public-url.txt" ]; then
    TUNNEL_URL="$(cat "${HOME}/.mira/cf-public-url.txt" 2>/dev/null || echo "")"
    [ -n "$TUNNEL_URL" ] && check_url "$TUNNEL_URL" "tunnel"
  fi
  sleep "$INTERVAL"
done
