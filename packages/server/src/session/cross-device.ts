/**
 * Cross-Device Session Resume (P2-2)
 *
 * File-based session sync: auto-export on delete/shutdown, auto-import on startup.
 * Users can copy `~/.mira/exports/` between machines for manual sync.
 *
 * Design:
 *   - Exports are versioned JSON envelopes (same format as GET /session/:id/export?format=json)
 *   - Import restores sessions with their ORIGINAL id (not a copy)
 *   - Skip-if-unchanged: compare updatedAt to avoid redundant writes
 *   - No networking, no auth — pure file I/O
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import type { MiraDB } from '../storage/db.js'
import type { JsonValue } from '../types/index.js'
import { eq } from 'drizzle-orm'
import { log, warn } from '../util/logger.js'

/** Export directory — MIRA_EXPORT_DIR env or ~/.mira/exports/ */
export function getExportDir(): string {
  return process.env.MIRA_EXPORT_DIR?.trim() || join(homedir(), '.mira', 'exports')
}

/** Ensure the export directory exists. Returns the path. */
async function ensureExportDir(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  return dir
}

// ── Auto-Export ─────────────────────────────────────────────────────

interface ExportEnvelope {
  version: 1
  exportedAt: string
  session: {
    id: string
    title: string
    model: string
    provider: string
    createdAt: number
    updatedAt: number
    parentID: string | null
    agent: string | null
    ownerID: string | null
    tokensIn: number | null
    tokensOut: number | null
    costUsd: number | null
    cwd: string | null
    projectId: string | null
  }
  messages: Array<{
    id: string
    role: string
    createdAt: number
    parts: Array<{
      id: string
      type: string
      text: string | null
      tool: string | null
      toolCallID: string | null
      args: JsonValue | null
      result: JsonValue
      isError: boolean | null
      createdAt: number
    }>
  }>
  todos: Array<{
    id: string
    content: string
    status: string
    priority: string
    createdAt: number
  }>
  snapshots: Array<{
    id: string
    path: string
    messageID: string | null
    content: string | null
    createdAt: number
  }>
}

/**
 * Export a single session to a JSON file.
 * Skips if the file already exists with the same updatedAt.
 * @returns true if exported, false if skipped
 */
export async function autoExportSession(
  db: MiraDB,
  sessionID: string,
  exportDir?: string,
): Promise<boolean> {
  const dir = exportDir ?? getExportDir()
  await ensureExportDir(dir)

  // Fetch session
  const session = await db.query.sessions.findFirst({
    where: (s, { eq }) => eq(s.id, sessionID),
  })
  if (!session) return false

  const filePath = join(dir, `${sessionID}.json`)

  // Skip-if-unchanged: check existing file's updatedAt
  try {
    const existing = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(existing) as ExportEnvelope
    if (parsed.session?.updatedAt === session.updatedAt) return false
  } catch {
    // File doesn't exist or is malformed — proceed with export
  }

  // Fetch messages with parts
  const messages = await db.query.messages.findMany({
    where: (m, { eq }) => eq(m.sessionID, sessionID),
    with: { parts: true },
    orderBy: (m, { asc }) => [asc(m.createdAt)],
  })

  // Fetch todos
  const todos = await db.query.todos.findMany({
    where: (t, { eq }) => eq(t.sessionID, sessionID),
  })

  // Fetch snapshots
  const snapshots = await db.query.fileSnapshots.findMany({
    where: (s, { eq }) => eq(s.sessionID, sessionID),
    orderBy: (s, { asc }) => [asc(s.createdAt)],
  })

  const envelope: ExportEnvelope = {
    version: 1,
    exportedAt: new Date().toISOString(),
    session: {
      id: session.id,
      title: session.title,
      model: session.model,
      provider: session.provider,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      parentID: session.parentID,
      agent: session.agent,
      ownerID: session.ownerID,
      tokensIn: session.tokensIn,
      tokensOut: session.tokensOut,
      costUsd: session.costUsd,
      cwd: session.cwd,
      projectId: session.projectId,
    },
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      createdAt: m.createdAt,
      parts: (m.parts ?? []).map((p) => ({
        id: p.id,
        type: p.type,
        text: p.text,
        tool: p.tool,
        toolCallID: p.toolCallID,
        args: p.args,
        result: p.result,
        isError: p.isError,
        createdAt: p.createdAt,
      })),
    })),
    todos: todos.map((t) => ({
      id: t.id,
      content: t.content,
      status: t.status,
      priority: t.priority,
      createdAt: t.createdAt,
    })),
    snapshots: snapshots.map((s) => ({
      id: s.id,
      path: s.path,
      messageID: s.messageID,
      content: s.content,
      createdAt: s.createdAt,
    })),
  }

  await writeFile(filePath, JSON.stringify(envelope, null, 2), 'utf-8')
  log(
    `cross-device: exported session ${sessionID} (${messages.length} messages, ${todos.length} todos, ${snapshots.length} snapshots) → ${filePath}`,
  )
  return true
}

// ── Auto-Import ─────────────────────────────────────────────────────

/**
 * Scan the export directory and import any sessions not already in the DB.
 * Uses the ORIGINAL session ID (true restore, not a copy).
 * @returns number of sessions imported
 */
export async function autoImportSessions(db: MiraDB, exportDir?: string): Promise<number> {
  const dir = exportDir ?? getExportDir()
  await ensureExportDir(dir)

  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return 0
  }

  const jsonFiles = files.filter((f) => f.endsWith('.json'))
  if (jsonFiles.length === 0) return 0

  let imported = 0
  for (const file of jsonFiles) {
    try {
      const raw = await readFile(join(dir, file), 'utf-8')
      const envelope = JSON.parse(raw) as ExportEnvelope

      // Validate envelope
      if (envelope.version !== 1 || !envelope.session?.id) continue

      const sessionID = envelope.session.id

      // Check if session already exists in DB
      const existing = await db.query.sessions.findFirst({
        where: (s, { eq }) => eq(s.id, sessionID),
      })
      if (existing) continue

      // Insert session with ORIGINAL id
      await db.insert(db.schema.sessions).values({
        id: sessionID,
        title: envelope.session.title,
        model: envelope.session.model,
        provider: envelope.session.provider,
        createdAt: envelope.session.createdAt,
        updatedAt: envelope.session.updatedAt,
        parentID: envelope.session.parentID,
        agent: envelope.session.agent,
        ownerID: envelope.session.ownerID,
        tokensIn: envelope.session.tokensIn,
        tokensOut: envelope.session.tokensOut,
        costUsd: envelope.session.costUsd,
        cwd: envelope.session.cwd,
        projectId: envelope.session.projectId,
      })

      // Insert messages with ORIGINAL ids
      let copiedMessages = 0
      let copiedParts = 0
      for (const m of envelope.messages ?? []) {
        try {
          await db.insert(db.schema.messages).values({
            id: m.id,
            sessionID,
            role: m.role as 'user' | 'assistant' | 'system',
            createdAt: m.createdAt,
          })
          copiedMessages++
          for (const p of m.parts ?? []) {
            await db.insert(db.schema.parts).values({
              id: p.id,
              messageID: m.id,
              sessionID,
              type: p.type as 'text' | 'tool-call' | 'tool-result' | 'reasoning' | 'file',
              text: p.text,
              tool: p.tool,
              toolCallID: p.toolCallID,
              args: (typeof p.args === 'object' && p.args !== null ? p.args : null) as Record<
                string,
                JsonValue
              > | null,
              result: p.result,
              isError: p.isError,
              createdAt: p.createdAt,
            })
            copiedParts++
          }
        } catch {
          /* skip malformed message, keep the rest */
        }
      }

      // Insert todos with ORIGINAL ids
      let copiedTodos = 0
      for (const t of envelope.todos ?? []) {
        try {
          await db.insert(db.schema.todos).values({
            id: t.id,
            sessionID,
            content: t.content,
            status: t.status as 'pending' | 'in_progress' | 'completed' | 'cancelled',
            priority: t.priority as 'high' | 'medium' | 'low',
            createdAt: t.createdAt,
          })
          copiedTodos++
        } catch {
          /* skip malformed todo */
        }
      }

      // Insert snapshots with ORIGINAL ids
      let copiedSnapshots = 0
      for (const s of envelope.snapshots ?? []) {
        try {
          await db.insert(db.schema.fileSnapshots).values({
            id: s.id,
            sessionID,
            messageID: s.messageID,
            path: s.path,
            content: s.content,
            createdAt: s.createdAt,
          })
          copiedSnapshots++
        } catch {
          /* skip malformed snapshot */
        }
      }

      imported++
      log(
        `cross-device: imported session ${sessionID} "${envelope.session.title}" (${copiedMessages} msgs, ${copiedParts} parts, ${copiedTodos} todos, ${copiedSnapshots} snapshots)`,
      )
    } catch (e) {
      warn(`cross-device: failed to import ${file}:`, String(e))
    }
  }

  if (imported > 0) {
    log(`cross-device: imported ${imported} session(s) from ${dir}`)
  }
  return imported
}

/**
 * Export all sessions that have been modified since the given timestamp.
 * Used during graceful shutdown to capture recently-active sessions.
 */
export async function exportAllSessions(
  db: MiraDB,
  exportDir?: string,
  sinceTimestamp?: number,
): Promise<number> {
  const dir = exportDir ?? getExportDir()
  await ensureExportDir(dir)

  const allSessions = await db.query.sessions.findMany()
  let exported = 0

  for (const session of allSessions) {
    // Skip sessions not modified since cutoff (if provided)
    if (sinceTimestamp && session.updatedAt < sinceTimestamp) continue

    const ok = await autoExportSession(db, session.id, dir)
    if (ok) exported++
  }

  if (exported > 0) {
    log(`cross-device: exported ${exported} session(s) to ${dir}`)
  }
  return exported
}
