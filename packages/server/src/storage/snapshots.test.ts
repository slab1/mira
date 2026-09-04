import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDatabase, migrate, type MiraDB } from './db.js'
import {
  snapshotFile,
  revertLast,
  revertToMessage,
  listSnapshots,
  getSnapshotContent,
} from './snapshots.js'

const dir = mkdtempSync(join(tmpdir(), 'mira-snap-'))
const dbFile = join(dir, 'test.db')
let db!: MiraDB

/** Insert a parent session row (snapshots FK-reference sessions) */
async function mkSession(id: string) {
  await db.insert(db.schema.sessions).values({
    id,
    title: id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
}

beforeEach(async () => {
  if (db)
    try {
      db.sqlite.close()
    } catch {}
  try {
    rmSync(dbFile)
  } catch {}
  db = createDatabase(dbFile)
  await migrate(db)
})
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
})

describe('snapshotFile', () => {
  test('stores existing file content', async () => {
    await mkSession('s1')
    const p = join(dir, 'a.txt')
    writeFileSync(p, 'original')
    const snap = snapshotFile(db, { sessionID: 's1', path: p })
    expect(snap).not.toBeNull()
    expect(snap!.existedBefore).toBe(true)
    const rows = listSnapshots(db, 's1')
    expect(rows).toHaveLength(1)
    expect(rows[0].path).toBe(p)
  })

  test('records non-existent files as created-by-agent', async () => {
    await mkSession('s1')
    const p = join(dir, 'new.txt')
    const snap = snapshotFile(db, { sessionID: 's1', path: p })
    expect(snap!.existedBefore).toBe(false)
  })

  test('returns null for unreadable paths', async () => {
    await mkSession('s1')
    expect(snapshotFile(db, { sessionID: 's1', path: '/nonexistent-root-dir/x/y' })).not.toBeNull()
    expect(snapshotFile(db, { sessionID: 's1', path: '' })).toBeNull()
  })
})

describe('revertLast', () => {
  test('restores modified file to pre-edit content', async () => {
    await mkSession('s2')
    const p = join(dir, 'mod.txt')
    writeFileSync(p, 'v1')
    snapshotFile(db, { sessionID: 's2', path: p })
    writeFileSync(p, 'v2-agent-edit')

    const reverted = revertLast(db, 's2')
    expect(reverted).not.toBeNull()
    expect(readFileSync(p, 'utf-8')).toBe('v1')
    // Snapshot consumed — second revert finds nothing
    expect(revertLast(db, 's2')).toBeNull()
  })

  test('deletes files the agent created', async () => {
    await mkSession('s3')
    const p = join(dir, 'created.txt')
    snapshotFile(db, { sessionID: 's3', path: p }) // did not exist
    writeFileSync(p, 'agent content')

    revertLast(db, 's3')
    expect(existsSync(p)).toBe(false)
  })

  test('reverts are per-session and LIFO', async () => {
    await mkSession('s4')
    await mkSession('s5')
    const a = join(dir, 'lifo-a.txt')
    const b = join(dir, 'lifo-b.txt')
    writeFileSync(a, 'A1')
    writeFileSync(b, 'B1')
    snapshotFile(db, { sessionID: 's4', path: a })
    writeFileSync(a, 'A2')
    snapshotFile(db, { sessionID: 's4', path: b })
    writeFileSync(b, 'B2')

    revertLast(db, 's4') // undoes B edit
    expect(readFileSync(b, 'utf-8')).toBe('B1')
    expect(readFileSync(a, 'utf-8')).toBe('A2') // untouched
    revertLast(db, 's5') // other session — isolated
    revertLast(db, 's4') // undoes A edit
    expect(readFileSync(a, 'utf-8')).toBe('A1')
  })
})

describe('revertToMessage', () => {
  test('rewinds all mutations at/after message boundary', async () => {
    const s = 's6'
    await mkSession(s)
    await db
      .insert(db.schema.messages)
      .values({ id: 'm1', sessionID: s, role: 'user', createdAt: 1000 })
    await db
      .insert(db.schema.messages)
      .values({ id: 'm2', sessionID: s, role: 'assistant', createdAt: 2000 })

    const p1 = join(dir, 'rw-1.txt')
    const p2 = join(dir, 'rw-2.txt')
    writeFileSync(p1, 'one-v1')
    snapshotFile(db, { sessionID: s, messageID: 'm1', path: p1 })
    writeFileSync(p1, 'one-v2')
    snapshotFile(db, { sessionID: s, messageID: 'm2', path: p2 })
    writeFileSync(p2, 'two-created')

    const reverted = revertToMessage(db, s, 'm2')
    expect(reverted).toHaveLength(1)
    expect(existsSync(p2)).toBe(false) // agent-created file removed
    expect(readFileSync(p1, 'utf-8')).toBe('one-v2') // before boundary — untouched
  })

  test('throws for unknown message', () => {
    expect(() => revertToMessage(db, 'sx', 'nope')).toThrow('not found')
  })
})

describe('getSnapshotContent', () => {
  test('retrieves stored snapshot content and metadata', async () => {
    await mkSession('s-detail')
    const p = join(dir, 'detail.txt')
    writeFileSync(p, 'hello world snapshot')
    const snap = snapshotFile(db, { sessionID: 's-detail', path: p })
    expect(snap).not.toBeNull()

    const detail = getSnapshotContent(db, snap!.id)
    expect(detail).not.toBeNull()
    expect(detail!.path).toBe(p)
    expect(detail!.content).toBe('hello world snapshot')
    expect(detail!.existedBefore).toBe(true)

    expect(getSnapshotContent(db, 'nonexistent-id')).toBeNull()
  })
})
