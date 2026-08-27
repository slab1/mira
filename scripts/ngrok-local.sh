#!/usr/bin/env bash
# ngrok tunnel for Mira — alternative to cloudflared/zrok
# Usage: scripts/ngrok-local.sh [port] [start|stop|status]
# Requires: ngrok installed + NGROK_AUTHTOKEN set (https://dashboard.ngrok.com/get-started/your-authtoken)
#   ngrok config add-authtoken $NGROK_AUTHTOKEN
set -euo pipefail

PORT="${1:-4096}"
# shift port if second arg is start/stop/status
if [[ "${PORT}" =~ ^(start|stop|status)$ ]]; then
  PORT="4096"
  ACTION="${1}"
else
  ACTION="${2:-start}"
fi
# Alias: "github" or "pages" points to local web that mirrors https://slab1.github.io/mira/
if [[ "${PORT}" == "github" || "${PORT}" == "pages" || "${PORT}" == "mira" ]]; then
  echo "[ngrok] alias '${PORT}' → http://127.0.0.1:3000 (mirrors https://slab1.github.io/mira/)"
  PORT="3000"
fi

PID_FILE="${HOME}/.mira/ngrok.pid"
LOG_FILE="${HOME}/.mira/ngrok.log"
mkdir -p "$(dirname "$PID_FILE")"

case "${ACTION}" in
  stop)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      kill "$(cat "$PID_FILE")" 2>/dev/null || true
      rm -f "$PID_FILE"
      echo "[ngrok] stopped"
    else
      echo "[ngrok] not running"
      rm -f "$PID_FILE"
    fi
    exit 0
    ;;
  status)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "[ngrok] running (pid $(cat "$PID_FILE"))"
      # Try to get public URL from ngrok API
      curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null | grep -o '"public_url":"https://[^"]*"' | head -1 || echo "  log: $LOG_FILE"
    else
      echo "[ngrok] stopped"
    fi
    exit 0
    ;;
esac

# start — check binary
if ! command -v ngrok >/dev/null 2>&1; then
  echo "[ngrok] ❌ ngrok not found — install: https://ngrok.com/download or 'npm i -g ngrok' / 'brew install ngrok/ngrok/ngrok'" >&2
  exit 1
fi

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "[ngrok] already running (pid $(cat "$PID_FILE"))"
  curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null | grep -o '"public_url":"https://[^"]*"' | head -1 || true
  exit 0
fi

if [ -z "${NGROK_AUTHTOKEN:-}" ] && ! ngrok config check 2>&1 | grep -q "valid"; then
  echo "[ngrok] ⚠️  NGROK_AUTHTOKEN not set — run: ngrok config add-authtoken <token> or export NGROK_AUTHTOKEN" >&2
fi

# Cleanup trap
trap 'kill "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null || true; rm -f "$PID_FILE"' EXIT TERM INT

echo "[ngrok] starting http://127.0.0.1:${PORT} → ngrok (pid will be $$)…"
# ngrok http with inspect dashboard on 4040
setsid nohup ngrok http "http://127.0.0.1:${PORT}" --log=stdout --log-format=json >"$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
# Wait for ngrok API to be ready and fetch public URL
for i in $(seq 1 15); do
  if curl -sf http://127.0.0.1:4040/api/tunnels >/dev/null 2>&1; then
    URL=$(curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null | grep -o '"public_url":"https://[^"]*"' | head -1 | cut -d'"' -f4)
    if [ -n "$URL" ]; then
      echo "[ngrok] ✓ public URL: $URL"
      echo "          → dashboard: http://127.0.0.1:4040"
      echo "          → logs: $LOG_FILE"
      trap - EXIT
      exit 0
    fi
  fi
  # Check if process died
  if ! kill -0 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null; then
    echo "[ngrok] ✗ failed to start — tail $LOG_FILE:"
    tail -5 "$LOG_FILE" 2>/dev/null || true
    exit 1
  fi
  sleep 1
done
echo "[ngrok] ✗ no public URL yet — tail $LOG_FILE:"
tail -20 "$LOG_FILE" 2>/dev/null || true
echo "          → check: curl http://127.0.0.1:4040/api/tunnels"
exit 1
