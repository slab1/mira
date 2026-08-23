# Mira Database Backup

## Usage

The backup script `backup-db.sh` creates a compressed SQLite dump of Mira's database.

### Manual run
```bash
/tmp/aether/scripts/backup-db.sh
```

Output file:
```
/app/data/backups/mira.db.<YYYYMMDD_HHMMSS>.sql.gz
```

The script:
- Creates `/app/data/backups` if missing
- Dumps `/app/data/mira.db` via `sqlite3 .dump`
- Pipes to `gzip` for compressed storage
- Exits with error if DB is missing

### Cron setup
Add to crontab for automated backups, e.g., daily at 02:00:
```cron
0 2 * * * /tmp/aether/scripts/backup-db.sh >> /var/log/mira-backup.log 2>&1
```

### Docker volume notes
- Ensure the container has access to `/app/data` volume
- The backup directory is inside the same volume, so backups persist with the volume
- To restore:
  ```bash
  gunzip -c /app/data/backups/mira.db.<timestamp>.sql.gz | sqlite3 /app/data/mira.db
  ```
- For off-host storage, mount a host path to `/app/data/backups` or add a step to `rsync`/`s3` the `.sql.gz` files after creation
- SQLite requires the DB file to be writable and not locked during dump; run backups during low-traffic windows or use a read-only replica

### Requirements
- `sqlite3` CLI installed in container
- `gzip` installed
- Write permission to `/app/data/backups`
