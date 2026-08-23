#!/usr/bin/env bash
set -e
PORT=${PORT:-4096}
URL="http://localhost:${PORT}/health"
for i in {1..30}; do
  if curl -sSf "$URL" > /dev/null; then
    echo "Health OK"
    exit 0
  fi
  sleep 1
done
echo "Health check failed"
exit 1
