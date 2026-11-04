# Postgres Support for Mira

## Overview

Mira now supports **Postgres** as an alternative to SQLite for production deployments. This provides:

- **Scalability**: Handle more concurrent connections and larger datasets
- **Reliability**: Better crash recovery and data integrity
- **Team Collaboration**: Multiple users can access the same database
- **Production Features**: Proper backups, replication, monitoring

## Quick Start

### 1. Install Dependencies

```bash
cd /workspace/github__slab1__mira/packages/server
bun add pg @types/pg
```

### 2. Configure Postgres

Set the database connection string:

```bash
export MIRA_DB="postgres://user:password@localhost:5432/mira"
export MIRA_DB_PROVIDER="postgres"
```

Or in your `mira.json`:

```json
{
  "database": {
    "provider": "postgres",
    "connectionString": "postgres://user:password@localhost:5432/mira"
  }
}
```

### 3. Run Migrations

Use drizzle-kit to generate and run migrations:

```bash
# Install drizzle-kit globally
npm install -g drizzle-kit

# Generate migrations
npx drizzle-kit generate:pg --schema=./src/storage/schema.ts

# Run migrations
npx drizzle-kit migrate --schema=./src/storage/schema.ts
```

### 4. Start Mira

```bash
cd /workspace/github__slab1__mira/packages/server
bun src/index.ts
```

## Configuration Options

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MIRA_DB` | Database connection string | `./data/mira.db` (SQLite) |
| `MIRA_DB_PROVIDER` | Database provider | Auto-detected from `MIRA_DB` |

### Connection String Format

```
postgres://username:password@hostname:port/database
postgresql://username:password@hostname:port/database
```

### Connection Pool Options

The Postgres connection pool uses these defaults:

- `max`: 20 connections
- `idleTimeoutMillis`: 30000 (30 seconds)
- `connectionTimeoutMillis`: 2000 (2 seconds)

To customize, modify the `createPostgresDatabase` function in `storage/pg-db.ts`.

## Migration from SQLite

### 1. Export SQLite Data

```bash
# Dump SQLite data to JSON
sqlite3 ./data/mira.db ".tables" | while read table; do
  sqlite3 -json ./data/mira.db "SELECT * FROM $table" > $table.json
done
```

### 2. Import to Postgres

```bash
# Create a Node script to import JSON files to Postgres
# Example: import-sessions.js
```

### 3. Update Configuration

Update your environment variables or `mira.json` to point to Postgres.

### 4. Restart Mira

```bash
bun src/index.ts
```

## Production Deployment

### Recommended Setup

```bash
# Use connection pooling
export MIRA_DB="postgres://user:password@localhost:5432/mira?pool_timeout=30"

# Enable SSL for remote connections
export MIRA_DB="postgres://user:password@localhost:5432/mira?sslmode=require"

# Use a connection pooler like PgBouncer for high traffic
```

### Monitoring

```bash
# Check active connections
psql -c "SELECT count(*) FROM pg_stat_activity WHERE datname = 'mira'"

# Check table sizes
psql -c "SELECT table_name, pg_size_pretty(pg_total_relation_size(table_name)) FROM information_schema.tables WHERE table_schema = 'public'"
```

### Backups

```bash
# Daily backup
pg_dump mira > mira-$(date +%Y-%m-%d).sql

# Compressed backup
pg_dump -Fc mira > mira-$(date +%Y-%m-%d).dump

# Restore
pg_restore -d mira mira-2024-01-01.dump
```

## Schema

The Postgres schema matches the SQLite schema. See `packages/server/src/storage/schema.ts` for the full schema definition.

### Key Tables

- `sessions` - Session metadata
- `messages` - Messages in sessions
- `parts` - Message parts (text, tool calls, results)
- `todos` - Todo items
- `api_keys` - API keys for authentication
- `orgs` - Organizations
- `org_memberships` - Organization memberships
- `users` - User information
- `audit_entries` - Audit log entries
- `evolution_ledger` - Evolution tracking

## Troubleshooting

### Connection Errors

**Error**: `Failed to connect to Postgres`

**Solution**: Check your connection string and ensure Postgres is running:

```bash
psql -h localhost -U username -d mira -c "SELECT 1"
```

### Migration Errors

**Error**: `relation "table_name" does not exist`

**Solution**: Run migrations:

```bash
npx drizzle-kit generate:pg
npx drizzle-kit migrate
```

### SSL Errors

**Error**: `SSL connection error`

**Solution**: Add `sslmode=require` to your connection string or disable SSL for local development:

```bash
export MIRA_DB="postgres://user:password@localhost:5432/mira?sslmode=disable"
```

## API Usage

### Using Postgres in Code

```typescript
import { createPostgresDatabase, migratePostgres } from './storage/pg-db.js'

// Create database connection
const db = createPostgresDatabase(process.env.MIRA_DB!)

// Run migrations (optional - for dev)
await migratePostgres(db)

// Use with Drizzle ORM
const sessions = await db.query.sessions.findMany()
```

### Using SQLite (Default)

```typescript
import { createDatabase, migrate } from './storage/db.js'

// Create database connection
const db = createDatabase(process.env.MIRA_DB)

// Run migrations
await migrate(db)

// Use with Drizzle ORM
const sessions = await db.query.sessions.findMany()
```

## Performance Tips

### Connection Pooling

- Use PgBouncer for high-traffic applications
- Configure pool size based on your workload
- Monitor connection usage

### Indexing

Ensure proper indexes are in place:

```sql
CREATE INDEX IF NOT EXISTS sessions_updated_idx ON sessions(updated_at)
CREATE INDEX IF NOT EXISTS messages_session_idx ON messages(session_id)
CREATE INDEX IF NOT EXISTS parts_message_idx ON parts(message_id)
```

### Vacuum

Regularly vacuum your database:

```bash
# Run vacuum manually
VACUUM ANALYZE

# Or set up autovacuum
ALTER TABLE sessions SET (autovacuum_vacuum_scale_factor = 0.01)
```

## Security

### SSL

Always use SSL for remote connections:

```
export MIRA_DB="postgres://user:password@localhost:5432/mira?sslmode=require"
```

### Authentication

- Use strong passwords
- Rotate credentials regularly
- Use IAM roles for cloud databases

### Network

- Restrict database access to trusted IPs
- Use firewalls and security groups
- Consider using a private network

## Comparison: SQLite vs Postgres

| Feature | SQLite | Postgres |
|---------|--------|----------|
| Concurrent Connections | Limited | High |
| Data Size | Limited (~140TB) | Virtually unlimited |
| Scalability | Single machine | Distributed |
| Backups | File copy | pg_dump |
| Replication | No | Yes |
| Transactions | ACID | ACID |
| Setup | Zero | Required |
| Maintenance | Low | Medium |
| Best For | Development, Local | Production, Team |

## Migration Tools

### Drizzle Kit

```bash
# Generate migrations
npx drizzle-kit generate:pg --schema=./src/storage/schema.ts

# Apply migrations
npx drizzle-kit migrate

# Studio (GUI)
npx drizzle-kit studio:pg
```

### Manual SQL

For simple migrations, you can use raw SQL:

```typescript
import { getPgClient } from './storage/pg-db.js'

const client = await getPgClient(db)
try {
  await client.query(`
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS new_column TEXT
  `)
} finally {
  client.release()
}
```

## Support

For issues with Postgres support:

1. Check the [Drizzle ORM documentation](https://orm.drizzle.team/docs/get-started/postgresql)
2. Check the [node-postgres documentation](https://node-postgres.com/)
3. Open an issue in the Mira repository

## License

Postgres support is provided under the same license as Mira (MIT).
