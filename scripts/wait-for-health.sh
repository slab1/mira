#!/usr/bin/env bash
set -euo pipefail
PORT=${PORT:-4096}
# healthz is unauthenticated liveness, always 127.0.0.1 (server binds loopback by default)
URL="http://127.0.0.1:${PORT}/healthz"
# If MIRA_TOKEN is set, health (auth) would need it, but healthz never does — use healthz for wait
for i in {1..30}; do
  if curl -sSf --max-time 2 "$URL" > /dev/null; then
    echo "Health OK ($URL)"
    exit 0
  fi
  sleep 1
done
echo "Health check failed ($URL) after 30s" >&2
curl -s "http://127.0.0.1:${PORT}/healthz" 2>&1 | head -c 200; echo
exit 1
