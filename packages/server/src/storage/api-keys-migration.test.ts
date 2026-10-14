/**
 * api_keys migration regression tests.
 *
 * Regression: commit 0ce8b03 added `role`, `expires_at`, `revoked_at` and
 * `last_used_at` to the api_keys schema but did not add them to the idempotent
 * `addColumn` migration list. On any database created before that commit the
 * boot-time `SELECT ... role, expires_at, revoked_at FROM api_keys` throws
 * "no such column: role"; the error was swallowed, so the server started with an
 * EMPTY credential store and every issued API key silently returned 401.
 */
import { describe, test, expect, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase, migrate } from './db.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'mira-migrate-'))
  dirs.push(dir)
  return createDatabase(join(dir, 'mira.db'))
}

/** The pre-0ce8b03 api_keys shape, as shipped before per-credential role/lifecycle. */
function createLegacyApiKeys(sqlite: Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      key TEXT PRIMARY KEY,
      key_hash TEXT,
      key_prefix TEXT,
      owner TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `)
}

const LIFECYCLE_COLUMNS = ['role', 'expires_at', 'revoked_at', 'last_used_at']

function columnsOf(sqlite: Database): string[] {
  return (sqlite.query('PRAGMA table_info(api_keys)').all() as { name: string }[]).map(
    (r) => r.name,
  )
}

/** The exact projection index.ts runs at boot to hydrate the credential store. */
function bootProjectionWorks(sqlite: Database): boolean {
  try {
    sqlite.query('SELECT key, key_hash, owner, role, expires_at, revoked_at FROM api_keys').all()
    return true
  } catch {
    return false
  }
}

describe('api_keys lifecycle migration', () => {
  test('migrate() adds role/expires_at/revoked_at/last_used_at to a legacy table', async () => {
    const db = freshDb()
    createLegacyApiKeys(db.sqlite)
    expect(columnsOf(db.sqlite)).not.toContain('role')
    expect(bootProjectionWorks(db.sqlite)).toBe(false)

    await migrate(db)

    for (const c of LIFECYCLE_COLUMNS) expect(columnsOf(db.sqlite)).toContain(c)
    expect(bootProjectionWorks(db.sqlite)).toBe(true)
  })

  test('existing rows survive and read back as null lifecycle values', async () => {
    const db = freshDb()
    createLegacyApiKeys(db.sqlite)
    db.sqlite
      .query('INSERT INTO api_keys (key, key_hash, owner, created_at) VALUES (?,?,?,?)')
      .run('k1', 'h1', 'alice', 1)

    await migrate(db)

    const rows = db.sqlite
      .query('SELECT key, owner, role, expires_at, revoked_at FROM api_keys')
      .all() as {
      key: string
      owner: string
      role: string | null
      expires_at: number | null
      revoked_at: number | null
    }[]
    expect(rows.length).toBe(1)
    expect(rows[0].owner).toBe('alice')
    // Null => legacy per-owner role resolution, never expires, not revoked.
    expect(rows[0].role).toBeNull()
    expect(rows[0].expires_at).toBeNull()
    expect(rows[0].revoked_at).toBeNull()
  })

  test('created_by backfills to "default" on legacy rows', async () => {
    const db = freshDb()
    createLegacyApiKeys(db.sqlite)
    db.sqlite
      .query('INSERT INTO api_keys (key, key_hash, owner, created_at) VALUES (?,?,?,?)')
      .run('k1', 'h1', 'alice', 1)

    await migrate(db)

    const row = db.sqlite.query('SELECT created_by FROM api_keys WHERE key = ?').get('k1') as {
      created_by: string
    }
    expect(row.created_by).toBe('default')
  })

  test('migrate() is idempotent — running twice is a no-op', async () => {
    const db = freshDb()
    createLegacyApiKeys(db.sqlite)
    db.sqlite
      .query('INSERT INTO api_keys (key, key_hash, owner, created_at) VALUES (?,?,?,?)')
      .run('k1', 'h1', 'alice', 1)

    await migrate(db)
    const after1 = columnsOf(db.sqlite)
    await migrate(db)
    expect(columnsOf(db.sqlite)).toEqual(after1)
    expect(bootProjectionWorks(db.sqlite)).toBe(true)
  })

  test('explicit lifecycle values round-trip', async () => {
    const db = freshDb()
    await migrate(db)
    db.sqlite
      .query(
        'INSERT INTO api_keys (key, key_hash, owner, role, expires_at, revoked_at, created_at) VALUES (?,?,?,?,?,?,?)',
      )
      .run('k2', 'h2', 'bob', 'viewer', 1893456000000, 0, 1)

    const row = db.sqlite.query('SELECT * FROM api_keys WHERE key = ?').get('k2') as Record<
      string,
      unknown
    >
    expect(row.role).toBe('viewer')
    expect(row.expires_at).toBe(1893456000000)
    expect(row.revoked_at).toBe(0)
  })
})
