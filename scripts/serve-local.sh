#!/usr/bin/env bash
# Mira local-first production launcher (Termux/Linux, no docker required).
#
# Usage: scripts/serve-local.sh [start|stop|status]
# Config: ~/.mira/mira.env (optional) — sourced before defaults.
#   e.g.  MIRA_TOKEN=..., MIRA_API_KEYS=..., CORS_ORIGINS=https://slab1.github.io
set -euo pipefail

MIRA_DIR="${MIRA_DIR:-$HOME/.mira}"
MIRA_ENV="$MIRA_DIR/mira.env"
PID_FILE="$MIRA_DIR/mira.pid"
LOG_FILE="$MIRA_DIR/mira.log"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-4096}"

mkdir -p "$MIRA_DIR/data"
[ -f "$MIRA_ENV" ] && . "$MIRA_ENV"
# Sourcing alone does NOT export — without this, MIRA_TOKEN etc. stay shell-local
# and bun boots an OPEN server. Re-export everything the env file may define.
export MIRA_TOKEN="${MIRA_TOKEN:-}"
export MIRA_API_KEYS="${MIRA_API_KEYS:-}"

export MIRA_DB="${MIRA_DB:-$MIRA_DIR/data/mira.db}"
export HOST="${HOST:-127.0.0.1}"          # loopback only — expose via cloudflared tunnel
export PORT
# Browser clients on GitHub Pages need CORS; tunnels are same-origin for curl/API users.
export CORS_ORIGINS="${CORS_ORIGINS:-https://slab1.github.io}"

case "${1:-start}" in
  start)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "[mira] already running (pid $(cat "$PID_FILE"))"; exit 0
    fi
    if [ -z "${MIRA_TOKEN:-}" ] && [ -z "${MIRA_API_KEYS:-}" ]; then
      if [ "${NODE_ENV:-}" = "production" ] && [ "${MIRA_STRICT_AUTH:-1}" != "0" ]; then
        echo "[mira] ❌ MIRA_TOKEN/MIRA_API_KEYS required in production — refusing to start open server" >&2
        exit 1
      fi
      echo "[mira] WARNING: no MIRA_TOKEN/MIRA_API_KEYS — server will be open. Set one in $MIRA_ENV"
    fi
    # setsid: own session — survives parent shell/process-group kills (tool runners, SSH drops)
    setsid nohup bun "$REPO_DIR/packages/server/src/index.ts" >>"$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    # Boot involves DB migrate + tool registration + MCP connects — poll, don't guess
    for _ in $(seq 1 25); do
      if curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
        echo "[mira] ✓ running on http://127.0.0.1:$PORT (pid $(cat "$PID_FILE"), log $LOG_FILE)"
        exit 0
      fi
      kill -0 "$(cat "$PID_FILE")" 2>/dev/null || break
      sleep 1
    done
    echo "[mira] ✗ failed to start — tail $LOG_FILE:"; tail -5 "$LOG_FILE"; exit 1
    ;;
  stop)
    [ -f "$PID_FILE" ] && kill "$(cat "$PID_FILE")" 2>/dev/null && rm -f "$PID_FILE" && echo "[mira] stopped" || echo "[mira] not running"
    ;;
  status)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "[mira] running (pid $(cat "$PID_FILE"))"
      curl -s "http://127.0.0.1:$PORT/health" | head -c 200; echo
    else echo "[mira] stopped"; fi
    ;;
esac
