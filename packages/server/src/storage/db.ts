/**
 * Storage — SQLite + Drizzle (Bun native)
 *
 * - WAL mode for concurrent read/write (server + TUI can read while loop writes)
 * - drizzle-orm/bun-sqlite driver (no better-sqlite3 native build needed)
 * - Schema in ./schema.ts, migrations via drizzle-kit or auto-create in dev
 *
 * Env: MIRA_DB=./data/mira.db (default)
 */

import { drizzle } from "drizzle-orm/bun-sqlite"
import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import * as schema from "./schema.js"
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite"

/** Drizzle instance (schema-aware → typed db.query.*) + raw client + schema refs */
export type MiraDB = BunSQLiteDatabase<typeof schema> & {
  sqlite: Database
  schema: typeof schema
}

export function createDatabase(path = "./data/mira.db") {
  // Ensure parent dir exists
  try { mkdirSync(dirname(path), { recursive: true }) } catch {}

  const sqlite = new Database(path)

  // WAL mode + sane pragmas (OpenCode pattern — pragmatism over Postgres for local)
  sqlite.exec("PRAGMA journal_mode = WAL;")
  sqlite.exec("PRAGMA synchronous = NORMAL;")
  sqlite.exec("PRAGMA foreign_keys = ON;")
  sqlite.exec("PRAGMA busy_timeout = 5000;")

  // Augment the drizzle instance with the raw client + schema (consumers use
  // both: query builder for ORM reads, raw sqlite for ad-hoc SQL like backups).
  const db = drizzle({ client: sqlite, schema })
  const mira = db as unknown as MiraDB
  mira.sqlite = sqlite
  mira.schema = schema
  return mira
}

/**
 * Auto-migrate: create tables if not exist (dev convenience).
 * For production, use `drizzle-kit generate` + `drizzle-kit migrate`.
 */
export async function migrate(db: MiraDB) {
  const sqlite: Database = db.sqlite
  if (!sqlite) return

  // Idempotent DDL — safe to run on every startup
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New Session',
      model TEXT NOT NULL DEFAULT 'openrouter/anthropic/claude-sonnet-4',
      provider TEXT NOT NULL DEFAULT 'openrouter',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      parent_id TEXT
    );
    CREATE INDEX IF NOT EXISTS sessions_updated_idx ON sessions(updated_at);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_session_idx ON messages(session_id);
    CREATE INDEX IF NOT EXISTS messages_created_idx ON messages(created_at);

    CREATE TABLE IF NOT EXISTS parts (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      text TEXT,
      tool TEXT,
      tool_call_id TEXT,
      args TEXT,
      result TEXT,
      is_error INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS parts_message_idx ON parts(message_id);
    CREATE INDEX IF NOT EXISTS parts_session_idx ON parts(session_id);

    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      priority TEXT NOT NULL DEFAULT 'medium',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS todos_session_idx ON todos(session_id);

    CREATE TABLE IF NOT EXISTS file_snapshots (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      message_id TEXT,
      path TEXT NOT NULL,
      content TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS file_snapshots_session_idx ON file_snapshots(session_id);
    CREATE INDEX IF NOT EXISTS file_snapshots_created_idx ON file_snapshots(created_at);

    CREATE TABLE IF NOT EXISTS message_queue (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS message_queue_session_idx ON message_queue(session_id);

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      child_session_id TEXT,
      agent TEXT,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      result TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS jobs_parent_session_idx ON jobs(parent_session_id);
    CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status);

    CREATE TABLE IF NOT EXISTS findings (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      source TEXT NOT NULL DEFAULT 'agent',
      severity TEXT NOT NULL DEFAULT 'info',
      title TEXT NOT NULL,
      evidence TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS findings_status_idx ON findings(status);
    CREATE INDEX IF NOT EXISTS findings_session_idx ON findings(session_id);
  `)
  // Idempotent column adds (SQLite lacks IF NOT EXISTS for columns)
  const addColumn = (table: string, col: string, type: string) => {
    try { sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type};`) } catch {}
  }
  addColumn("sessions", "tokens_in", "INTEGER")
  addColumn("sessions", "tokens_out", "INTEGER")
  addColumn("sessions", "cost_usd", "REAL")
  addColumn("sessions", "owner_id", "TEXT")
  addColumn("sessions", "agent", "TEXT")
  // console.log("[storage] migrated")
}

export { schema }
