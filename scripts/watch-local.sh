#!/usr/bin/env bash
# watch-local.sh — keep the Mira origin alive under Android LMK/OOM pressure.
# Tiny bash loop (~5MB RSS) that revives serve-local.sh whenever /healthz dies.
# Launch detached:  setsid nohup scripts/watch-local.sh >/dev/null 2>&1 &
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="${HOME}/.mira/watchdog.log"
PORT="${PORT:-4096}"
echo "[watchdog] started $(date -Iseconds)" >>"$LOG"
while true; do
  if ! curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
    echo "[watchdog] origin down $(date -Iseconds) → restarting" >>"$LOG"
    bash "$DIR/serve-local.sh" start >>"$LOG" 2>&1 || true
  fi
  sleep 60
done
