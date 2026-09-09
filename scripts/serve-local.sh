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
# Auto-export all vars from mira.env (so provider keys like NVIDIA_API_KEY, OPENROUTER_API_KEY are inherited)
set -a
[ -f "$MIRA_ENV" ] && . "$MIRA_ENV"
set +a
export MIRA_TOKEN="${MIRA_TOKEN:-}"
export MIRA_API_KEYS="${MIRA_API_KEYS:-}"

export MIRA_DB="${MIRA_DB:-$MIRA_DIR/data/mira.db}"
export HOST="${HOST:-127.0.0.1}"          # loopback only — expose via cloudflared tunnel
export PORT
# Browser clients on GitHub Pages need CORS; tunnels are same-origin for curl/API users.
export CORS_ORIGINS="${CORS_ORIGINS:-https://slab1.github.io}"
# Re-export provider keys that may have been set via mira.env (auto-export via set -a handles this, but be explicit for clarity)
export NVIDIA_API_KEY="${NVIDIA_API_KEY:-}"
export OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-}"
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-}"

effective_port() {
  # Prefer .mira/port written by server rotation (repo root or cwd)
  for p in "$REPO_DIR/.mira/port" ".mira/port" "$PWD/.mira/port"; do
    if [ -f "$p" ]; then
      v=$(cat "$p" 2>/dev/null | tr -d ' \r\n')
      if [ -n "$v" ] && [ "$v" -gt 0 ] 2>/dev/null && [ "$v" -le 65535 ] 2>/dev/null; then echo "$v"; return 0; fi
    fi
  done
  echo "$PORT"
}
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
      echo "[mira] No MIRA_TOKEN/MIRA_API_KEYS — server auto-generates one into $MIRA_ENV on first boot"
    fi
    # setsid: own session — survives parent shell/process-group kills (tool runners, SSH drops)
    setsid nohup bun "$REPO_DIR/packages/server/src/index.ts" >>"$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    # Boot involves DB migrate + tool registration + MCP connects — poll, don't guess
    # Poll rotation-aware: check .mira/port plus 4096-4106 so we don't miss a rotated port.
    for _ in $(seq 1 25); do
      EP=$(effective_port)
      # try effective port first, then scan 4096-4106
      for try_port in "$EP" 4096 4097 4098 4099 4100 4101 4102 4103 4104 4105 4106; do
        if [ -z "$try_port" ]; then continue; fi
        if curl -sf "http://127.0.0.1:$try_port/healthz" >/dev/null 2>&1; then
          echo "[mira] ✓ running on http://127.0.0.1:$try_port (pid $(cat "$PID_FILE"), log $LOG_FILE)"
          # persist effective port for callers that read $PORT env later
          if [ -f "$REPO_DIR/.mira/port" ]; then true; else mkdir -p "$REPO_DIR/.mira" && echo "$try_port" > "$REPO_DIR/.mira/port" 2>/dev/null || true; fi
          exit 0
        fi
      done
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
      EP=$(effective_port)
      echo "[mira] running (pid $(cat "$PID_FILE"), port $EP)"
      # try effective port, then scan
      for try_port in "$EP" 4096 4097 4098 4099 4100 4101 4102 4103 4104 4105 4106; do
        if curl -s "http://127.0.0.1:$try_port/health" 2>/dev/null | head -c 200 | grep -q "ok\|version\|tools"; then
          curl -s "http://127.0.0.1:$try_port/health" | head -c 200; echo; exit 0
        fi
      done
      # fallback: just try EP
      curl -s "http://127.0.0.1:$EP/health" | head -c 200; echo
    else echo "[mira] stopped"; fi
    ;;
esac
