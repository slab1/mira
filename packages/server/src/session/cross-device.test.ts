import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { createDatabase, migrate } from '../storage/db.js'
import { SessionPrompt } from './prompt.js'
import { Bus } from '../bus/index.js'
import { PermissionManager } from '../permission/index.js'
import { ToolRegistry } from '../tools/registry.js'
import type { Gateway } from '../gateway/index.js'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'
import {
  autoExportSession,
  autoImportSessions,
  exportAllSessions,
  getExportDir,
} from './cross-device.js'

const stubGateway: Gateway = {
  stream: () => Promise.resolve((async function* () {})()),
  complete: async () => ({ text: '' }),
  summarize: async () => '',
  listModels: async () => [],
  stats: () => ({
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUSD: 0,
    avgLatencyMs: 0,
    byModel: {},
  }),
}

let db!: ReturnType<typeof createDatabase>
let prompt!: SessionPrompt
let testExportDir!: string

beforeAll(async () => {
  db = createDatabase(':memory:')
  await migrate(db)
  const bus = new Bus()
  const permissions = new PermissionManager({})
  const tools = new ToolRegistry({ db, bus: new Bus(), permissions, gateway: stubGateway })
  prompt = new SessionPrompt({ db, bus, gateway: stubGateway, tools, permissions })
  // Use a unique temp dir for each test run
  testExportDir = join(tmpdir(), `mira-cross-device-test-${Date.now()}`)
  await mkdir(testExportDir, { recursive: true })
})

afterAll(async () => {
  try {
    await rm(testExportDir, { recursive: true, force: true })
  } catch {}
})

async function seedSession(opts?: { title?: string; updatedAt?: number }) {
  const s = await prompt.createSession({ title: opts?.title ?? 'test-session' })
  if (opts?.updatedAt) {
    db.update(db.schema.sessions)
      .set({ updatedAt: opts.updatedAt })
      .where(eq(db.schema.sessions.id, s.id))
      .run()
  }
  const m1 = crypto.randomUUID()
  await db.insert(db.schema.messages).values({
    id: m1,
    sessionID: s.id,
    role: 'user',
    createdAt: 1000,
  })
  await db.insert(db.schema.parts).values({
    id: crypto.randomUUID(),
    messageID: m1,
    sessionID: s.id,
    type: 'text',
    text: 'hello cross-device',
    createdAt: 1000,
  })
  await prompt.setTodos(s.id, [
    {
      id: crypto.randomUUID(),
      sessionID: s.id,
      content: 'a todo',
      status: 'pending',
      priority: 'high',
      createdAt: 1000,
    },
  ])
  return s
}

describe('cross-device: getExportDir', () => {
  test('returns ~/.mira/exports by default', () => {
    const dir = getExportDir()
    expect(dir).toContain('.mira')
    expect(dir).toContain('exports')
  })

  test('respects MIRA_EXPORT_DIR env', () => {
    const prev = process.env.MIRA_EXPORT_DIR
    process.env.MIRA_EXPORT_DIR = '/tmp/custom-exports'
    try {
      expect(getExportDir()).toBe('/tmp/custom-exports')
    } finally {
      if (prev !== undefined) process.env.MIRA_EXPORT_DIR = prev
      else delete process.env.MIRA_EXPORT_DIR
    }
  })
})

describe('cross-device: autoExportSession', () => {
  test('exports session to JSON file with correct envelope', async () => {
    const session = await seedSession({ title: 'export-me' })
    const ok = await autoExportSession(db, session.id, testExportDir)
    expect(ok).toBe(true)

    const files = await readdir(testExportDir)
    const jsonFile = files.find((f) => f === `${session.id}.json`)
    expect(jsonFile).toBeDefined()

    const raw = await Bun.file(join(testExportDir, jsonFile!)).text()
    const envelope = JSON.parse(raw)
    expect(envelope.version).toBe(1)
    expect(typeof envelope.exportedAt).toBe('string')
    expect(envelope.session.id).toBe(session.id)
    expect(envelope.session.title).toBe('export-me')
    expect(envelope.messages).toHaveLength(1)
    expect(envelope.messages[0].role).toBe('user')
    expect(envelope.messages[0].parts[0].text).toBe('hello cross-device')
    expect(envelope.todos).toHaveLength(1)
    expect(envelope.todos[0].content).toBe('a todo')
  })

  test('skips export when updatedAt unchanged', async () => {
    const session = await seedSession({ title: 'skip-me' })
    const ok1 = await autoExportSession(db, session.id, testExportDir)
    expect(ok1).toBe(true)
    // Second export — same updatedAt → skip
    const ok2 = await autoExportSession(db, session.id, testExportDir)
    expect(ok2).toBe(false)
  })

  test('re-exports when session is modified', async () => {
    const session = await seedSession({ title: 'modify-me' })
    await autoExportSession(db, session.id, testExportDir)

    // Simulate modification: update updatedAt
    const newTime = Date.now() + 10000
    db.update(db.schema.sessions)
      .set({ updatedAt: newTime })
      .where(eq(db.schema.sessions.id, session.id))
      .run()

    const ok = await autoExportSession(db, session.id, testExportDir)
    expect(ok).toBe(true)

    const raw = await Bun.file(join(testExportDir, `${session.id}.json`)).text()
    const envelope = JSON.parse(raw)
    expect(envelope.session.updatedAt).toBe(newTime)
  })

  test('returns false for nonexistent session', async () => {
    const ok = await autoExportSession(db, 'does-not-exist', testExportDir)
    expect(ok).toBe(false)
  })
})

describe('cross-device: autoImportSessions', () => {
  let importDir!: string

  beforeEach(async () => {
    importDir = join(testExportDir, `import-${Date.now()}`)
    await mkdir(importDir, { recursive: true })
  })

  test('imports session not in DB with original ID', async () => {
    // Create an export file manually
    const sessionID = crypto.randomUUID()
    const envelope = {
      version: 1,
      exportedAt: new Date().toISOString(),
      session: {
        id: sessionID,
        title: 'remote-session',
        model: 'openrouter/anthropic/claude-sonnet-4',
        provider: 'openrouter',
        createdAt: 1000,
        updatedAt: 2000,
        parentID: null,
        agent: null,
        ownerID: null,
        tokensIn: null,
        tokensOut: null,
        costUsd: null,
        cwd: null,
        projectId: null,
      },
      messages: [
        {
          id: crypto.randomUUID(),
          role: 'user',
          createdAt: 1000,
          parts: [
            {
              id: crypto.randomUUID(),
              type: 'text',
              text: 'from another device',
              tool: null,
              toolCallID: null,
              args: null,
              result: null,
              isError: null,
              createdAt: 1000,
            },
          ],
        },
      ],
      todos: [
        {
          id: crypto.randomUUID(),
          content: 'remote todo',
          status: 'pending',
          priority: 'high',
          createdAt: 1000,
        },
      ],
    }
    await writeFile(join(importDir, `${sessionID}.json`), JSON.stringify(envelope))

    const imported = await autoImportSessions(db, importDir)
    expect(imported).toBe(1)

    // Verify session exists in DB with ORIGINAL id
    const session = await db.query.sessions.findFirst({
      where: (s, { eq }) => eq(s.id, sessionID),
    })
    expect(session).toBeDefined()
    expect(session!.title).toBe('remote-session')
    expect(session!.createdAt).toBe(1000)
    expect(session!.updatedAt).toBe(2000)

    // Verify messages
    const messages = await db.query.messages.findMany({
      where: (m, { eq }) => eq(m.sessionID, sessionID),
    })
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('user')

    // Verify parts
    const parts = await db.query.parts.findMany({
      where: (p, { eq }) => eq(p.sessionID, sessionID),
    })
    expect(parts).toHaveLength(1)
    expect(parts[0].text).toBe('from another device')

    // Verify todos
    const todos = await db.query.todos.findMany({
      where: (t, { eq }) => eq(t.sessionID, sessionID),
    })
    expect(todos).toHaveLength(1)
    expect(todos[0].content).toBe('remote todo')
  })

  test('skips session that already exists in DB', async () => {
    const session = await seedSession({ title: 'already-here' })

    // Create export file for existing session
    const envelope = {
      version: 1,
      exportedAt: new Date().toISOString(),
      session: {
        id: session.id,
        title: session.title,
        model: session.model,
        provider: session.provider,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        parentID: null,
        agent: null,
        ownerID: null,
        tokensIn: null,
        tokensOut: null,
        costUsd: null,
        cwd: null,
        projectId: null,
      },
      messages: [],
      todos: [],
    }
    await writeFile(join(importDir, `${session.id}.json`), JSON.stringify(envelope))

    const imported = await autoImportSessions(db, importDir)
    expect(imported).toBe(0) // skipped — already in DB
  })

  test('skips malformed JSON files', async () => {
    await writeFile(join(importDir, 'bad.json'), 'not json at all')
    const imported = await autoImportSessions(db, importDir)
    expect(imported).toBe(0)
  })

  test('skips files with wrong version', async () => {
    await writeFile(
      join(importDir, 'wrong-version.json'),
      JSON.stringify({ version: 99, session: { id: 'x' } }),
    )
    const imported = await autoImportSessions(db, importDir)
    expect(imported).toBe(0)
  })

  test('returns 0 for empty directory', async () => {
    const imported = await autoImportSessions(db, importDir)
    expect(imported).toBe(0)
  })
})

describe('cross-device: exportAllSessions', () => {
  test('exports all sessions to dir', async () => {
    const dir = join(testExportDir, `export-all-${Date.now()}`)
    await mkdir(dir, { recursive: true })

    const s1 = await seedSession({ title: 'all-1' })
    const s2 = await seedSession({ title: 'all-2' })

    const count = await exportAllSessions(db, dir)
    // Shared DB has sessions from prior tests — at least our 2 should be exported
    expect(count).toBeGreaterThanOrEqual(2)

    const files = await readdir(dir)
    expect(files).toContain(`${s1.id}.json`)
    expect(files).toContain(`${s2.id}.json`)
  })

  test('respects sinceTimestamp filter', async () => {
    const dir = join(testExportDir, `export-since-${Date.now()}`)
    await mkdir(dir, { recursive: true })

    // Old session (updatedAt = 1000)
    await seedSession({ title: 'old-one', updatedAt: 1000 })
    // Recent session (updatedAt = now)
    const recent = await seedSession({ title: 'recent-one' })

    const count = await exportAllSessions(db, dir, Date.now() - 5000)
    expect(count).toBeGreaterThanOrEqual(1)

    const files = await readdir(dir)
    expect(files).toContain(`${recent.id}.json`)
  })
})
