#!/usr/bin/env bash
set -euo pipefail
PORT=${PORT:-4096}
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
mira_port() {
  for p in "$REPO_DIR/.mira/port" ".mira/port" "$PWD/.mira/port"; do
    if [ -f "$p" ]; then v=$(cat "$p" 2>/dev/null | tr -d ' \r\n'); if [ -n "$v" ] && [ "$v" -gt 0 ] 2>/dev/null; then echo "$v"; return 0; fi; fi
  done
  echo "$PORT"
}
# healthz is unauthenticated liveness, always 127.0.0.1 (server binds loopback by default)
# Try effective port + scan 4096-4106 so rotation doesn't break CI wait.
for i in {1..30}; do
  EP=$(mira_port)
  for try_port in "$EP" 4096 4097 4098 4099 4100 4101 4102 4103 4104 4105 4106; do
    URL="http://127.0.0.1:${try_port}/healthz"
    if curl -sSf --max-time 2 "$URL" > /dev/null 2>&1; then
      echo "Health OK ($URL)"
      exit 0
    fi
  done
  sleep 1
done
EP=$(mira_port)
echo "Health check failed (http://127.0.0.1:${EP}/healthz) after 30s" >&2
curl -s "http://127.0.0.1:${EP}/healthz" 2>&1 | head -c 200; echo
exit 1
