#!/usr/bin/env bash
# ============================================================================
#  tunnels.sh — bring up all three public tunnels for the Mira server
#  Target: http://localhost:${MIRA_PORT:-4096}  (Mira server default port 4096)
#
#  Usage:
#    scripts/tunnels.sh start     # launch cloudflared + zrok + ngrok (those ready)
#    scripts/tunnels.sh stop      # kill all running tunnels
#    scripts/tunnels.sh status    # show which are running + where logs are
#
#  Pre-reqs per tunnel:
#    cloudflared : ~/.cloudflared/named-token.txt  (present — named tunnel, no login)
#                  set CF_QUICK=1 to use a quick *.trycloudflare.com tunnel instead
#                  (no domain needed; URL printed + saved to ~/.mira/cf-public-url.txt)
#    zrok        : ~/.zrok2/environment.json        (present — already `enable`d)
#    ngrok       : ~/.config/ngrok/ngrok.yml         (needs `ngrok config add-authtoken`)
#                  or env NGROK_AUTHTOKEN set
# ============================================================================
set -uo pipefail

PORT="${MIRA_PORT:-4096}"
LOG_DIR="${HOME}/.mira"
mkdir -p "$LOG_DIR"

CF_TOKEN="${HOME}/.cloudflared/named-token.txt"
ZROK_ENV="${HOME}/.zrok2/environment.json"
NGROK_CFG="${HOME}/.config/ngrok/ngrok.yml"

CF_PID="${LOG_DIR}/cloudflared.pid"; CF_LOG="${LOG_DIR}/cloudflared.log"
ZR_PID="${LOG_DIR}/zrok.pid";      ZR_LOG="${LOG_DIR}/zrok.log"
NG_PID="${LOG_DIR}/ngrok.pid";     NG_LOG="${LOG_DIR}/ngrok.log"

alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

start_cloudflared() {
  if alive "$CF_PID"; then echo "[cf] already running (pid $(cat "$CF_PID"))"; return; fi
  if [ "${CF_QUICK:-0}" = "1" ] || [ ! -f "$CF_TOKEN" ]; then
    # Quick tunnel — no Cloudflare login/domain needed; prints a *.trycloudflare.com URL.
    cloudflared tunnel --url "http://localhost:${PORT}" --no-autoupdate \
      > "$CF_LOG" 2>&1 &
    echo $! > "$CF_PID"
    echo "[cf] quick tunnel started (pid $(cat "$CF_PID")); resolving public URL..."
    URL=""
    for i in $(seq 1 20); do
      sleep 1
      URL=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$CF_LOG" 2>/dev/null | head -1)
      [ -n "$URL" ] && break
    done
    if [ -n "$URL" ]; then
      echo "$URL" > "${LOG_DIR}/cf-public-url.txt"
      echo "[cf] PUBLIC URL: $URL   (saved to ~/.mira/cf-public-url.txt)"
    else
      echo "[cf] (URL not captured yet — see $CF_LOG)"
    fi
  else
    # Named tunnel (persistent, custom hostname) via token in ~/.cloudflared/named-token.txt
    cloudflared tunnel run --token "$(cat "$CF_TOKEN")" --url "http://localhost:${PORT}" \
      > "$CF_LOG" 2>&1 &
    echo $! > "$CF_PID"
    echo "[cf] named tunnel started (pid $(cat "$CF_PID")) — public URL = the Cloudflare hostname you assigned to tunnel af4884bb…"
  fi
}

start_zrok() {
  if alive "$ZR_PID"; then echo "[zrok] already running (pid $(cat "$ZR_PID"))"; return; fi
  if [ ! -f "$ZROK_ENV" ]; then echo "[zrok] SKIP — not enabled (run: zrok enable <token>)"; return; fi
  # random public name (no --name) avoids 'shareConflict' on a reserved name
  zrok share public --headless "http://localhost:${PORT}" \
    > "$ZR_LOG" 2>&1 &
  echo $! > "$ZR_PID"
  echo "[zrok] started pid $(cat "$ZR_PID")  (log: $ZR_LOG)"
}

start_ngrok() {
  if alive "$NG_PID"; then echo "[ngrok] already running (pid $(cat "$NG_PID"))"; return; fi
  if [ ! -f "$NGROK_CFG" ] && [ -z "${NGROK_AUTHTOKEN:-}" ]; then
    echo "[ngrok] SKIP — no authtoken. Run: ngrok config add-authtoken \$NGROK_AUTHTOKEN"
    return
  fi
  if [ -n "${NGROK_AUTHTOKEN:-}" ] && [ ! -f "$NGROK_CFG" ]; then
    ngrok config add-authtoken "$NGROK_AUTHTOKEN" >/dev/null 2>&1 || true
  fi
  ngrok http "$PORT" --log "$NG_LOG" > "${LOG_DIR}/ngrok.out" 2>&1 &
  echo $! > "$NG_PID"
  echo "[ngrok] started pid $(cat "$NG_PID")  (log: $NG_LOG)"
}

stop_all() {
  for p in "$CF_PID" "$ZR_PID" "$NG_PID"; do
    if alive "$p"; then kill "$(cat "$p")" 2>/dev/null || true; rm -f "$p"; fi
  done
  echo "[tunnels] stopped"
}

status_all() {
  for name in cf:cloudflared zrok:zrok ngrok:ngrok; do
    label="${name%%:*}"; pidf="${name##*:}"
    case "$label" in
      cf) pidf="$CF_PID";; zrok) pidf="$ZR_PID";; ngrok) pidf="$NG_PID";;
    esac
    if alive "$pidf"; then echo "[$label] RUNNING (pid $(cat "$pidf"))"; else echo "[$label] stopped"; fi
  done
  [ -f "${LOG_DIR}/cf-public-url.txt" ] && echo "[cf] public URL: $(cat "${LOG_DIR}/cf-public-url.txt")"
  echo "--- logs ---"; ls -la "$LOG_DIR"/*.log 2>/dev/null
}

case "${1:-start}" in
  start)  start_cloudflared; start_zrok; start_ngrok;;
  stop)   stop_all;;
  status) status_all;;
  *) echo "usage: $0 {start|stop|status}"; exit 1;;
esac
