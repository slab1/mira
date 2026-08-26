#!/usr/bin/env bash
# watch-local.sh — keep the Mira origin + zrok tunnel alive under Android LMK/OOM pressure.
# Tiny bash loop (~5MB RSS) that revives serve-local.sh whenever /healthz dies,
# and re-attaches the reserved zrok share (slab1-mira.shares.zrok.io) if it drops.
# Launch detached:  setsid nohup scripts/watch-local.sh >/dev/null 2>&1 &
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="${HOME}/.mira/watchdog.log"
PORT="${PORT:-4096}"
ZROK_NAME="${ZROK_NAME:-slab1-mira}"
echo "[watchdog] started $(date -Iseconds)" >>"$LOG"
while true; do
  if ! curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
    echo "[watchdog] origin down $(date -Iseconds) → restarting" >>"$LOG"
    bash "$DIR/serve-local.sh" start >>"$LOG" 2>&1 || true
  fi
  # zrok share: process gone OR endpoint not answering → restart bound to reserved name
  if ! pgrep -x zrok >/dev/null 2>&1 || ! curl -sf --max-time 20 "https://${ZROK_NAME}.shares.zrok.io/healthz" >/dev/null 2>&1; then
    if ! pgrep -x zrok >/dev/null 2>&1; then
      echo "[watchdog] zrok share down $(date -Iseconds) → restarting" >>"$LOG"
      setsid nohup zrok share public -n "public:${ZROK_NAME}" "http://127.0.0.1:${PORT}" --headless >>"${HOME}/.mira/zrok.log" 2>&1 &
    fi
  fi
  sleep 60
done
