#!/usr/bin/env bash
set -euo pipefail

# Resolve DB — honor MIRA_DB, then MIRA_DIR/data/mira.db, then repo fallbacks
MIRA_DIR="${MIRA_DIR:-$HOME/.mira}"
# Source mira.env if present so MIRA_DB/MIRA_TOKEN are available
[ -f "${MIRA_DIR}/mira.env" ] && . "${MIRA_DIR}/mira.env" || true
if [[ -n "${MIRA_DB:-}" && -f "${MIRA_DB}" ]]; then
  DB_PATH="${MIRA_DB}"
elif [[ -f "${MIRA_DIR}/data/mira.db" ]]; then
  DB_PATH="${MIRA_DIR}/data/mira.db"
elif [[ -f "./data/mira.db" ]]; then
  DB_PATH="./data/mira.db"
elif [[ -f "./packages/server/data/mira.db" ]]; then
  DB_PATH="./packages/server/data/mira.db"
elif [[ -f "$(dirname "$0")/../packages/server/data/mira.db" ]]; then
  DB_PATH="$(dirname "$0")/../packages/server/data/mira.db"
else
  DB_PATH="${MIRA_DIR}/data/mira.db"
fi
BACKUP_DIR="${MIRA_DIR}/backups"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="${BACKUP_DIR}/mira.db.${TIMESTAMP}.sql.gz"

# Create backups directory if missing
mkdir -p "${BACKUP_DIR}"

# Check if DB exists
if [[ ! -f "${DB_PATH}" ]]; then
  echo "Error: Database not found at ${DB_PATH} (checked MIRA_DB, MIRA_DIR/data, ./data, packages/server/data)" >&2
  exit 1
fi

# Dump and compress
sqlite3 "${DB_PATH}" ".dump" | gzip -c > "${BACKUP_FILE}"

# Keep only the last 7 backups (rotate)
BACKUP_COUNT=$(ls "${BACKUP_DIR}"/mira.db.*.sql.gz 2>/dev/null | wc -l)
if [ "$BACKUP_COUNT" -gt 7 ]; then
  # Sort by timestamp (filename already encodes timestamp) and remove excess
  ls -1t "${BACKUP_DIR}"/mira.db.*.sql.gz | tail -n +8 | xargs -r rm --
fi

echo "Backup created: ${BACKUP_FILE} (keeping last 7)"
