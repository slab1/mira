/**
 * Postgres Database Support
 * 
 * Optional Postgres support for Mira server.
 * 
 * Usage:
 *   Set MIRA_DB=postgres://user:pass@localhost:5432/mira
 *   Set MIRA_DB_PROVIDER=postgres
 *   
 *   Then import from this file instead of db.ts
 * 
 * Note: This is an experimental feature. For production use, ensure:
 *   - Proper migrations are run (drizzle-kit generate + drizzle-kit migrate)
 *   - Connection pooling is configured appropriately
 *   - SSL is enabled for remote connections
 */

import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool, type PoolClient } from 'pg'
import * as schema from './schema.js'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'

/** Postgres database type */
export type PgMiraDB = NodePgDatabase<typeof schema> & {
  pool: Pool
  schema: typeof schema
}

/**
 * Create a Postgres database connection
 * 
 * @param connectionString - Postgres connection string (e.g., postgres://user:pass@localhost:5432/mira)
 * @returns Postgres database instance
 */
export function createPostgresDatabase(connectionString: string): PgMiraDB {
  // Create connection pool with sensible defaults
  const pool = new Pool({
    connectionString,
    max: 20, // Maximum number of clients in the pool
    idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
    connectionTimeoutMillis: 2000, // Return an error after 2 seconds if connection could not be established
  })

  // Test connection
  pool.on('connect', () => {
    console.log('[mira] Postgres: connected to database')
  })

  pool.on('error', (err) => {
    console.error('[mira] Postgres: unexpected error', err)
  })

  // Create drizzle instance with pool + schema
  const db = drizzle({ client: pool, schema })
  const mira: PgMiraDB = Object.assign(db, { pool, schema })
  return mira
}

/**
 * Run migrations for Postgres
 * 
 * Note: This is a placeholder. For production, use drizzle-kit:
 *   npx drizzle-kit generate:pg
 *   npx drizzle-kit migrate
 */
export async function migratePostgres(db: PgMiraDB): Promise<void> {
  console.log('[mira] Postgres: migrations should be run via drizzle-kit')
  // For development, we can run a simple check
  const client = await db.pool.connect()
  try {
    const { rows } = await client.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'sessions')`,
    )
    if (rows[0].exists === false) {
      console.warn('[mira] Postgres: sessions table does not exist. Run migrations.')
    }
  } finally {
    client.release()
  }
}

/**
 * Check if a database is Postgres
 */
export function isPostgres(db: any): db is PgMiraDB {
  return db && typeof db.pool === 'object' && db.pool.constructor.name === 'Pool'
}

/**
 * Get a client from the pool for raw SQL queries
 */
export async function getPgClient(db: PgMiraDB): Promise<PoolClient> {
  return db.pool.connect()
}

// Re-export types
export type { Pool, PoolClient }
export { Pool }
