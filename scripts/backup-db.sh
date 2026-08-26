#!/usr/bin/env bash
set -euo pipefail

# Use MIRA_DIR from env (set by serve-local.sh: $HOME/.mira default)
MIRA_DIR="${MIRA_DIR:-$HOME/.mira}"
DB_PATH="${MIRA_DIR}/data/mira.db"
BACKUP_DIR="${MIRA_DIR}/backups"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="${BACKUP_DIR}/mira.db.${TIMESTAMP}.sql.gz"

# Create backups directory if missing
mkdir -p "${BACKUP_DIR}"

# Check if DB exists
if [[ ! -f "${DB_PATH}" ]]; then
  echo "Error: Database not found at ${DB_PATH}" >&2
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
