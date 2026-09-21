#!/usr/bin/env bash
# Guarded dependency installer — the ONLY supported way to run `bun install`
# on dev machines (Windows laptop, Android proot, CI uses plain `bun install`).
#
# Why this exists (2026-09-20): three install failure modes bit us hard —
#   1. Disk 100% full mid-install → half-extracted packages, cryptic
#      "Cannot find package X" errors minutes later in build/test.
#   2. Concurrent `bun install` processes (two terminals/agents) racing on
#      the same store → corrupt entries bun then skips as "already installed".
#   3. Killed installs (timeouts) → partial cache entries never retried.
#
# This wrapper: refuses when disk is low, serializes via flock, installs,
# then verifies integrity with scripts/verify-install.js.
#
# Usage: scripts/install.sh [-- <extra bun install args>]
# Env:   MIRA_BUN_BACKEND (default: symlink — required on Android proot where
#          copy/hardlink hit EPERM; unset/empty = bun default from bunfig.toml)
#        MIRA_SKIP_DISK_CHECK=1  (bypass the free-space guard)
#        MIRA_MIN_FREE_GB (default: 2)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOCK_FILE="${TMPDIR:-/tmp}/mira-bun-install.lock"
MIN_FREE_GB="${MIRA_MIN_FREE_GB:-2}"
BACKEND="${MIRA_BUN_BACKEND:-symlink}"

# --- single-install guard (flock auto-releases if the holder dies) ---
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "install.sh: another 'bun install' is already running (lock: $LOCK_FILE)." >&2
  echo "Wait for it to finish — concurrent installs corrupt the package store." >&2
  exit 1
fi

# --- disk-space guard ---
if [ "${MIRA_SKIP_DISK_CHECK:-0}" != "1" ]; then
  FREE_KB="$(df -k "$REPO_DIR" | tail -1 | awk '{print $4}')"
  FREE_GB=$((FREE_KB / 1024 / 1024))
  if [ "$FREE_GB" -lt "$MIN_FREE_GB" ]; then
    echo "install.sh: REFUSING — only ${FREE_GB}G free on $(df "$REPO_DIR" | tail -1 | awk '{print $1}'), need >= ${MIN_FREE_GB}G." >&2
    echo "Free space first (safe targets):" >&2
    echo "  npm cache clean --force; rm -rf ~/.cache/pip /tmp/aether/.turbo" >&2
    echo "  rm -rf /tmp/*.tgz /tmp/bun.zip <stale test DBs/logs in /tmp>" >&2
    echo "  rm -rf <inactive-project>/node_modules   (regenerable via reinstall)" >&2
    echo "Keep: bun install cache (~/.bun/install/cache, needed offline), active node_modules, LLVM." >&2
    exit 1
  fi
  echo "install.sh: disk ok (${FREE_GB}G free)."
fi

# --- install (exactly one backend flag; extra args appended) ---
cd "$REPO_DIR"
if [ -n "$BACKEND" ]; then
  bun install --backend="$BACKEND" "$@"
else
  bun install "$@"
fi

# --- verify integrity (fail fast with actionable errors) ---
node scripts/verify-install.js
