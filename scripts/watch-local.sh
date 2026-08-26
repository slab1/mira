#!/usr/bin/env bash
# watch-local.sh — keep the Mira origin + zrok tunnel alive under Android LMK/OOM pressure.
# Tiny bash loop (~5MB RSS) that revives serve-local.sh whenever /healthz dies,
# and re-attaches the reserved zrok share (slab1-mira.shares.zrok.io) if it drops.
# Launch detached:  setsid nohup scripts/watch-local.sh >/dev/null 2>&1 &
# Updated: adds nightly SQLite backup integration (keep 7).
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="${HOME}/.mira/watchdog.log"
PORT="${PORT:-4096}"
ZROK_NAME="${ZROK_NAME:-slab1-mira}"
BACKUP_INTERVAL=1440  # run backup once per ~24h (60s * 1440 = 86400s)
BACKUP_COUNT=0
echo "[watchdog] started $(date -Iseconds)" >>"$LOG"
ZROK_FAILS=0
while true; do
  if ! curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
    echo "[watchdog] origin down $(date -Iseconds) → restarting" >>"$LOG"
    bash "$DIR/serve-local.sh" start >>"$LOG" 2>&1 || true
  fi
  # zrok: URL must answer AND process must exist. Act only on 3 consecutive
  # failures (~3 min) — transient network flakes shouldn't burn API rate limit.
  if curl -sf --max-time 25 "https://${ZROK_NAME}.shares.zrok.io/healthz" >/dev/null 2>&1 && pgrep -x zrok >/dev/null 2>&1; then
    ZROK_FAILS=0
  else
    ZROK_FAILS=$((ZROK_FAILS + 1))
    echo "[watchdog] zrok unhealthy (${ZROK_FAILS}/3) $(date -Iseconds)" >>"$LOG"
    if [ "$ZROK_FAILS" -ge 3 ]; then
      echo "[watchdog] restarting zrok share ${ZROK_NAME} $(date -Iseconds)" >>"$LOG"
      pkill -x zrok 2>/dev/null # TERM → clean name release (avoids 409 stale lease)
      sleep 5
      setsid nohup zrok share public -n "public:${ZROK_NAME}" "http://127.0.0.1:${PORT}" --headless >>"${HOME}/.mira/zrok.log" 2>&1 &
      ZROK_FAILS=0
    fi
  fi
  # Nightly SQLite backup integration (keep 7)
  BACKUP_COUNT=$((BACKUP_COUNT + 1))
  if [ "$BACKUP_COUNT" -ge "$BACKUP_INTERVAL" ]; then
    bash "$DIR/backup-db.sh" >>"$LOG" 2>&1 || true
    BACKUP_COUNT=0
  fi
  sleep 60
done