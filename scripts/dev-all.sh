#!/usr/bin/env bash
# dev-all.sh — start Mira server, Vite web UI, and Cloudflare tunnels
# Usage: scripts/dev-all.sh [start|stop|status]
set -euo pipefail

ACTION="${1:-start}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

log() { echo "[dev-all] $*"; }

start_mira() {
  log "starting Mira server..."
  bash "$SCRIPT_DIR/serve-local.sh" start
}

start_vite() {
  log "starting Vite web UI..."
  if pgrep -f "vite.*packages/web" >/dev/null 2>&1; then
    log "Vite already running"
    return
  fi
  cd "$REPO_ROOT/packages/web"
  nohup npm run dev > /tmp/vite.log 2>&1 &
  log "Vite started (log /tmp/vite.log)"
}

start_tunnels() {
  log "starting Cloudflare tunnels..."
  # API
  bash "$SCRIPT_DIR/cloudflare-local.sh" api start || true
  # Web
  bash "$SCRIPT_DIR/cloudflare-local.sh" web start || true
}

stop_all() {
  log "stopping tunnels..."
  bash "$SCRIPT_DIR/cloudflare-local.sh" api stop || true
  bash "$SCRIPT_DIR/cloudflare-local.sh" web stop || true
  log "stopping Vite..."
  pkill -f "vite.*packages/web" || true
  log "stopping Mira..."
  bash "$SCRIPT_DIR/serve-local.sh" stop || true
}

status_all() {
  log "Mira server:"
  bash "$SCRIPT_DIR/serve-local.sh" status || true
  log "Vite:"
  if pgrep -f "vite.*packages/web" >/dev/null 2>&1; then
    echo "  running"
  else
    echo "  stopped"
  fi
  log "Cloudflare tunnels:"
  bash "$SCRIPT_DIR/cloudflare-local.sh" api status || true
  bash "$SCRIPT_DIR/cloudflare-local.sh" web status || true
}

case "$ACTION" in
  start)
    start_mira
    sleep 2
    start_vite
    sleep 5
    start_tunnels
    log "dev stack started"
    ;;
  stop)
    stop_all
    log "dev stack stopped"
    ;;
  status)
    status_all
    ;;
  *)
    echo "Usage: $0 [start|stop|status]"
    exit 1
    ;;
esac
