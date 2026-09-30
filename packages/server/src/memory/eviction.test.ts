/**
 * Memory Eviction Engine — Tests
 *
 * Covers shouldEvict, evictStaleMemories, and previewEviction.
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { shouldEvict, evictStaleMemories, previewEviction } from './eviction.js'

// ── Helpers ────────────────────────────────────────────────────────

function createTestDb(): Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE knowledge (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      confidence REAL DEFAULT 0.5,
      lastVerifiedAt INTEGER,
      createdAt INTEGER,
      provenance TEXT,
      deleted_at INTEGER
    )
  `)
  return db
}

function insertEntry(
  db: Database,
  entry: {
    id: string
    kind: string
    confidence: number
    lastVerifiedAt: number
    createdAt: number
    provenance?: string
  },
): void {
  db.prepare(
    `INSERT INTO knowledge (id, kind, confidence, lastVerifiedAt, createdAt, provenance)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.id,
    entry.kind,
    entry.confidence,
    entry.lastVerifiedAt,
    entry.createdAt,
    entry.provenance ?? null,
  )
}

const NOW = Date.now()
const DAY = 24 * 60 * 60 * 1000

// ── shouldEvict ────────────────────────────────────────────────────

describe('shouldEvict', () => {
  test('evicts low-confidence memories', () => {
    const entry = { confidence: 0.1, lastVerifiedAt: NOW, createdAt: NOW }
    expect(shouldEvict(entry, NOW)).toBe(true)
  })

  test('keeps high-confidence memories', () => {
    const entry = { confidence: 0.9, lastVerifiedAt: NOW, createdAt: NOW }
    expect(shouldEvict(entry, NOW)).toBe(false)
  })

  test('evicts memories past max age', () => {
    const old = NOW - 200 * DAY
    const entry = { confidence: 0.9, lastVerifiedAt: old, createdAt: old }
    expect(shouldEvict(entry, NOW)).toBe(true)
  })

  test('keeps recent high-confidence memories', () => {
    const recent = NOW - 30 * DAY
    const entry = { confidence: 0.8, lastVerifiedAt: recent, createdAt: recent }
    expect(shouldEvict(entry, NOW)).toBe(false)
  })

  test('evicts cautioned memories when evictCautioned is true', () => {
    const stale = NOW - 100 * DAY
    const entry = {
      confidence: 0.6,
      lastVerifiedAt: stale,
      createdAt: stale,
      provenance: 'unverified',
    }
    expect(shouldEvict(entry, NOW, { evictCautioned: true })).toBe(true)
  })

  test('keeps cautioned memories when evictCautioned is false', () => {
    const stale = NOW - 100 * DAY
    const entry = {
      confidence: 0.6,
      lastVerifiedAt: stale,
      createdAt: stale,
      provenance: 'unverified',
    }
    expect(shouldEvict(entry, NOW, { evictCautioned: false })).toBe(false)
  })

  test('respects custom minConfidence threshold', () => {
    const entry = { confidence: 0.4, lastVerifiedAt: NOW, createdAt: NOW }
    expect(shouldEvict(entry, NOW, { minConfidence: 0.5 })).toBe(true)
    expect(shouldEvict(entry, NOW, { minConfidence: 0.3 })).toBe(false)
  })
})

// ── evictStaleMemories ─────────────────────────────────────────────

describe('evictStaleMemories', () => {
  let db: Database

  beforeEach(() => {
    db = createTestDb()
  })

  test('evicts stale memories and keeps fresh ones', () => {
    insertEntry(db, {
      id: 'stale-1',
      kind: 'episodic',
      confidence: 0.1,
      lastVerifiedAt: NOW - 10 * DAY,
      createdAt: NOW - 10 * DAY,
    })
    insertEntry(db, {
      id: 'fresh-1',
      kind: 'episodic',
      confidence: 0.9,
      lastVerifiedAt: NOW,
      createdAt: NOW,
    })

    const report = evictStaleMemories(db)

    expect(report.scanned).toBe(2)
    expect(report.evicted).toBe(1)
    expect(report.kept).toBe(1)
    expect(report.evictedIds).toContain('stale-1')
    expect(report.dryRun).toBe(false)
  })

  test('dry-run mode does not delete', () => {
    insertEntry(db, {
      id: 'stale-1',
      kind: 'episodic',
      confidence: 0.1,
      lastVerifiedAt: NOW - 10 * DAY,
      createdAt: NOW - 10 * DAY,
    })

    const report = evictStaleMemories(db, { dryRun: true })

    expect(report.evicted).toBe(1)
    expect(report.dryRun).toBe(true)

    const row = db.prepare('SELECT deleted_at FROM knowledge WHERE id = ?').get('stale-1') as {
      deleted_at: number | null
    }
    expect(row.deleted_at).toBeNull()
  })

  test('returns empty report when no memories to evict', () => {
    insertEntry(db, {
      id: 'fresh-1',
      kind: 'episodic',
      confidence: 0.9,
      lastVerifiedAt: NOW,
      createdAt: NOW,
    })

    const report = evictStaleMemories(db)

    expect(report.scanned).toBe(1)
    expect(report.evicted).toBe(0)
    expect(report.kept).toBe(1)
  })

  test('handles empty database', () => {
    const report = evictStaleMemories(db)

    expect(report.scanned).toBe(0)
    expect(report.evicted).toBe(0)
    expect(report.kept).toBe(0)
  })
})

// ── previewEviction ────────────────────────────────────────────────

describe('previewEviction', () => {
  let db: Database

  beforeEach(() => {
    db = createTestDb()
  })

  test('previews eviction without deleting', () => {
    insertEntry(db, {
      id: 'stale-1',
      kind: 'episodic',
      confidence: 0.1,
      lastVerifiedAt: NOW - 10 * DAY,
      createdAt: NOW - 10 * DAY,
    })
    insertEntry(db, {
      id: 'fresh-1',
      kind: 'episodic',
      confidence: 0.9,
      lastVerifiedAt: NOW,
      createdAt: NOW,
    })

    const report = previewEviction(db)

    expect(report.dryRun).toBe(true)
    expect(report.evicted).toBe(1)
    expect(report.kept).toBe(1)

    const row = db.prepare('SELECT deleted_at FROM knowledge WHERE id = ?').get('stale-1') as {
      deleted_at: number | null
    }
    expect(row.deleted_at).toBeNull()
  })
})
