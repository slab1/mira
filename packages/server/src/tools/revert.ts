/**
 * Tool: revert — agent self-correction for a bad edit.
 *
 * Before this tool existed, undo was only reachable from the web/TUI clients
 * (POST /session/:id/revert), so an agent that edited the wrong file — or the
 * right file at the wrong position — had no first-class way to drop its own
 * change. Its only recourse was prose ("run git checkout -- <file>").
 *
 * This wraps the snapshot store, which records the FULL pre-image of every
 * write/edit/patch before the mutation (tools/registry.ts). Unlike revertLast()
 * this restores FILES ONLY and never deletes conversation messages — an agent
 * correcting a mistake must not lose the context that led to it.
 */
import { resolve } from 'node:path'
import { z } from 'zod'
import type { ToolDef } from './registry.js'
import { listRecentSnapshots, revertSnapshot } from '../storage/snapshots.js'

const revertSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(400)
    .optional()
    .describe('File whose most recent change should be undone (relative to the session cwd)'),
  snapshotID: z
    .string()
    .min(1)
    .optional()
    .describe('Exact snapshot to restore (from revert_list) — takes precedence over path'),
})

export const revertTool = {
  name: 'revert',
  description:
    'Undo your own file edit: restores the pre-edit content of a file, or deletes it if you created it. ' +
    'Use this when you edited the wrong file or changed the wrong part of the right file. ' +
    'Call revert_list first to see what is undoable. Conversation history is NOT affected.',
  category: 'other',
  schema: revertSchema,
  async execute({ path, snapshotID }, ctx) {
    const db = ctx.db
    if (!db) return { ok: false, error: 'database unavailable' }
    const sessionID = ctx.sessionID
    if (!sessionID) return { ok: false, error: 'no session context' }
    if (!path && !snapshotID)
      return { ok: false, error: 'provide path (undo that file) or snapshotID (undo exact change)' }

    // Normalize to an absolute path the same way the snapshotter recorded it.
    const abs = path ? resolve(ctx.cwd ?? process.cwd(), path) : undefined
    const { reverted, reason } = revertSnapshot(db, sessionID, { snapshotID, path: abs })
    if (!reverted) return { ok: false, error: reason ?? 'nothing to revert' }

    return {
      ok: true,
      restored: reverted.path,
      // content === null means the file did not exist before → it was deleted
      action: reverted.existedBefore
        ? 'restored previous content'
        : 'deleted (file did not exist before)',
      snapshotID: reverted.id,
      at: new Date(reverted.createdAt).toISOString(),
    }
  },
} satisfies ToolDef<typeof revertSchema>

const revertListSchema = z.object({
  limit: z.number().int().positive().max(50).optional().describe('Max snapshots (default 10)'),
})

export const revertListTool = {
  name: 'revert_list',
  description:
    'List the file changes you can undo in this session (newest first), with their paths and timestamps. ' +
    'Pass a path or snapshotID to the revert tool.',
  category: 'other',
  schema: revertListSchema,
  async execute({ limit }, ctx) {
    if (!ctx.db || !ctx.sessionID) return { snapshots: [] }
    const snaps = listRecentSnapshots(ctx.db, ctx.sessionID, limit ?? 10)
    return {
      snapshots: snaps.map((s) => ({
        snapshotID: s.id,
        path: s.path,
        createdAt: new Date(s.createdAt).toISOString(),
        action: s.existedBefore ? 'restore' : 'delete (created by you)',
      })),
    }
  },
} satisfies ToolDef<typeof revertListSchema>
export const tools = [revertTool, revertListTool]
