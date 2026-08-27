#!/usr/bin/env bash
# Expose a local Mira server through a Cloudflare quick tunnel (no account needed).
#
# Usage: scripts/tunnel-local.sh [port]     (default 4096)
# Prints the public https://*.trycloudflare.com URL. Quick-tunnel URLs are
# ephemeral — they change on each run. For a stable URL create a named tunnel:
#   cloudflared tunnel login && cloudflared tunnel create mira
#   cloudflared tunnel route dns mira mira.yourdomain.com
set -euo pipefail

PORT="${1:-4096}"
PID_FILE="${HOME}/.mira/tunnel.pid"
LOG_FILE="${HOME}/.mira/tunnel.log"
mkdir -p "$(dirname "$PID_FILE")"
# Ensure cloudflared is cleaned up on script exit
trap 'kill "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null || true; rm -f "$PID_FILE"' EXIT TERM INT

case "${2:-start}" in
  stop) [ -f "$PID_FILE" ] && kill "$(cat "$PID_FILE")" 2>/dev/null && rm -f "$PID_FILE" && echo "[tunnel] stopped" || echo "[tunnel] not running"; trap - EXIT; exit 0 ;;
esac

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "[tunnel] already running (pid $(cat "$PID_FILE"))"
  grep -a -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$LOG_FILE" 2>/dev/null | tail -1
  exit 0
fi

# setsid: own session — survives parent shell/process-group kills (tool runners, SSH drops)
setsid nohup cloudflared tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate >"$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"

echo "[tunnel] starting (pid $(cat "$PID_FILE"))…"
for i in $(seq 1 20); do
  URL=$(grep -a -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$LOG_FILE" 2>/dev/null | tail -1 || true)
  if [ -n "$URL" ]; then
    echo "[tunnel] ✓ public URL: $URL"
    echo "          → point the web client's VITE_API_URL at this, or call the API directly."
    exit 0
  fi
  sleep 1
done
echo "[tunnel] ✗ no URL yet — tail $LOG_FILE:"; tail -5 "$LOG_FILE"; exit 1
