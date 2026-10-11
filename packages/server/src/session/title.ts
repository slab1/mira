/**
 * Session auto-titling.
 *
 * Main sessions stayed "New Session" forever unless the user renamed them, and
 * the session list became an unnamed wall. (Subagent sessions were already
 * titled from their task prompt by runSubagent — `↳ <prompt>`. This module
 * covers the main-session gap at the single chokepoint both paths share.)
 *
 * Rules:
 *   - Only DEFAULT titles are replaced. A user-chosen title (rename, import
 *     with explicit title, agent custom title) is never clobbered.
 *   - Derived deterministically from the first user prompt — no model call,
 *     no latency, works offline.
 *   - Fires once: after the first apply the title is no longer default.
 */
import type { MiraDB } from '../storage/db.js'
import type { Bus } from '../bus/index.js'
import { eq } from 'drizzle-orm'

const DEFAULT_TITLES = new Set(['', 'New Session', 'Imported Session'])
const AGENT_DEFAULT_RE = /^[A-Za-z0-9_-]{1,40} session$/

/** True when a title is a placeholder the auto-titler may replace. */
export function isDefaultTitle(title: string | null | undefined): boolean {
  const t = (title ?? '').trim()
  if (DEFAULT_TITLES.has(t)) return true
  return AGENT_DEFAULT_RE.test(t)
}

/** Derive a session title from the first user prompt. */
export function titleFromPrompt(text: string, max = 60): string {
  const firstLine = (text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!firstLine) return ''
  const collapsed = firstLine.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= max) return collapsed
  return collapsed.slice(0, max - 1).trimEnd() + '…'
}

/**
 * Apply an auto-title when the session still carries a default one.
 * Best-effort: never throws, publishes `session.updated` so open session
 * lists refresh without a reload.
 */
export async function maybeAutoTitle(
  db: MiraDB,
  bus: Bus | undefined,
  sessionID: string,
  currentTitle: string | null | undefined,
  promptText: string,
): Promise<void> {
  try {
    if (!isDefaultTitle(currentTitle)) return
    const title = titleFromPrompt(promptText)
    if (!title || title === currentTitle) return
    const now = Date.now()
    await db
      .update(db.schema.sessions)
      .set({ title, updatedAt: now })
      .where(eq(db.schema.sessions.id, sessionID))
    bus?.publish({
      type: 'session.updated',
      sessionID,
      payload: { id: sessionID, title, autoTitled: true },
      timestamp: now,
    })
  } catch (e) {
    console.warn('[session] auto-title failed:', String(e))
  }
}
