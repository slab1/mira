#!/usr/bin/env bash
set -euo pipefail

DB_PATH="/app/data/mira.db"
BACKUP_DIR="/app/data/backups"
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

echo "Backup created: ${BACKUP_FILE}"
