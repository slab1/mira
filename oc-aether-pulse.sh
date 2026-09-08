#!/usr/bin/env bash
# oc-aether-pulse.sh — hourly cognitive pulse cron wrapper
# Installs hourly cron: 0 * * * * /path/to/mira/oc-aether-pulse.sh
# Calls shared/aether_core.ts:pulse() → L2→L3 consolidation, RCSI, audit, checkpoint pruning.
# Also invokes opencode_improvement/track for audit trail.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Ensure bun is on PATH (supports volta/nvm/bun installs)
export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:/usr/local/bin:$PATH"

echo "[oc-aether-pulse] $(date -Is) — triggering pulse"

# Prefer bun; fallback to node
if command -v bun >/dev/null 2>&1; then
  bun run shared/aether_core.ts --once 2>&1 | tee -a "$SCRIPT_DIR/shared/aether_core.pulse.log" || true
elif command -v node >/dev/null 2>&1; then
  node --loader ts-node/esm shared/aether_core.ts 2>&1 | tee -a "$SCRIPT_DIR/shared/aether_core.pulse.log" || true
else
  echo "[oc-aether-pulse] no bun/node found — skip" | tee -a "$SCRIPT_DIR/shared/aether_core.pulse.log"
fi

# Track pulse via opencode_improvement (best-effort)
if [ -f "$SCRIPT_DIR/opencode_improvement/track.py" ]; then
  python3 -m opencode_improvement.track aether pulse --duration 0 2>&1 || true
elif [ -f "$SCRIPT_DIR/packages/server/src/opencode_improvement/track.ts" ]; then
  bun run packages/server/src/opencode_improvement/track.ts aether pulse 2>&1 || true
fi

# Cron install helper: run `bash oc-aether-pulse.sh --install-cron` to add hourly entry
if [ "${1:-}" = "--install-cron" ]; then
  CRON_LINE="0 * * * * $SCRIPT_DIR/oc-aether-pulse.sh >> $SCRIPT_DIR/shared/aether_core.pulse.log 2>&1"
  (crontab -l 2>/dev/null | grep -v "oc-aether-pulse.sh"; echo "$CRON_LINE") | crontab -
  echo "[oc-aether-pulse] cron installed: $CRON_LINE"
  crontab -l | grep oc-aether-pulse || true
fi

echo "[oc-aether-pulse] $(date -Is) — done"
