#!/usr/bin/env bash
# Cloudflare quick tunnel wrapper for Mira
# Usage: scripts/cloudflare-local.sh [port|api|web] [start|stop|status]
#  port: 4096 (api) or 3000 (web)
#  aliases: api -> 4096, web -> 3000
set -euo pipefail

PORT="${1:-4096}"
ACTION="${2:-start}"

if [[ "$PORT" == "api" ]]; then PORT=4096; fi
if [[ "$PORT" == "web" ]]; then PORT=3000; fi

PID_FILE="${HOME}/.mira/cloudflared-${PORT}.pid"
LOG_FILE="${HOME}/.mira/cloudflared-${PORT}.log"
mkdir -p "$(dirname "$PID_FILE")"

case "$ACTION" in
  stop)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      kill "$(cat "$PID_FILE")" 2>/dev/null || true
      rm -f "$PID_FILE"
      echo "[cloudflare:${PORT}] stopped"
    else
      echo "[cloudflare:${PORT}] not running"
      rm -f "$PID_FILE"
    fi
    exit 0
    ;;
  status)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "[cloudflare:${PORT}] running (pid $(cat "$PID_FILE"))"
      grep -a -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$LOG_FILE" 2>/dev/null | tail -1 || echo "  no URL yet"
    else
      echo "[cloudflare:${PORT}] stopped"
    fi
    exit 0
    ;;
esac

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "[cloudflare] cloudflared not found" >&2
  exit 1
fi

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "[cloudflare:${PORT}] already running (pid $(cat "$PID_FILE"))"
  grep -a -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$LOG_FILE" 2>/dev/null | tail -1 || true
  exit 0
fi

nohup cloudflared tunnel --url "http://127.0.0.1:${PORT}" --no-autoupdate >"$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
echo "[cloudflare:${PORT}] starting (pid $(cat "$PID_FILE"))..."
for i in $(seq 1 20); do
  URL=$(grep -a -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$LOG_FILE" 2>/dev/null | tail -1 || true)
  if [ -n "$URL" ]; then
    echo "[cloudflare:${PORT}] ✓ public URL: $URL"
    echo "  log: $LOG_FILE"
    exit 0
  fi
  sleep 1
done
echo "[cloudflare:${PORT}] ✗ no URL yet — tail $LOG_FILE"
tail -20 "$LOG_FILE"
exit 1
