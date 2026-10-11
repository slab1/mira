/**
 * Edit critic (P3.6 groundwork → wrong-edit protection).
 *
 * The last undirected gap in wrong-edit protection: an agent's snippet can
 * match a file PERFECTLY while sitting in the wrong function, and no string
 * machinery can tell — the mismatch is intent, and `near` only helps when the
 * agent declares it. This module recovers intent from the only other source
 * available: the task text, judged by a second model call.
 *
 * Design (mirrors the Virtual-Diff critic gate in agents/critic.md, applied to
 * agent edits instead of self-improvement patches):
 *   - fires AFTER a successful mutation, fire-and-forget — never blocks the
 *     agent's tool result;
 *   - OFF by default (`compliance.editCritic` or MIRA_EDIT_CRITIC) — every edit
 *     costs a model call, and that is an operator decision;
 *   - one review in flight per session (a burst of edits does not pile up);
 *   - verdict 'unrelated' writes a finding (visible in the findings UI) and,
 *     when autoRollback is also enabled, reverts the edit via its snapshot —
 *     the job/agent keeps its context either way.
 */
import { basename } from 'node:path'
import type { MiraDB } from '../storage/db.js'
import type { Gateway } from '../gateway/types.js'
import { getConfig } from '../config/index.js'
import { autoRollbackEnabled } from '../compliance/index.js'
import { revertSnapshot } from '../storage/snapshots.js'
import { writeFinding } from './findings.js'
import { recentUserPrompts } from './edit-target.js'

export function editCriticEnabled(): boolean {
  try {
    const cfg = getConfig().compliance
    if (typeof cfg?.editCritic === 'boolean') return cfg.editCritic
  } catch {}
  const env = process.env.MIRA_EDIT_CRITIC?.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(env ?? '')) return true
  if (['0', 'false', 'no', 'off'].includes(env ?? '')) return false
  return false
}

/** One review in flight per session — edit bursts must not pile up model calls. */
const inFlight = new Set<string>()

/** Hard timeout on the critic call — a slow provider must not wedge the session. */
const CRITIC_TIMEOUT_MS = 30_000

const CRITIC_SYSTEM =
  'You are a code-edit critic. You are given the task the agent was asked to do, ' +
  'and the before/after of one file change it just made. Judge ONLY whether this ' +
  'change plausibly serves the stated task (right file, right region, right kind of change). ' +
  'You are not reviewing code quality. Reply with ONLY JSON: ' +
  '{"verdict":"ok"|"unrelated","reason":"<short, concrete>"}. ' +
  '"unrelated" means the change plausibly does NOT match the task intent. ' +
  'Be conservative: if the evidence is unclear, answer "ok".'

function clip(s: string | null, max: number): string {
  if (!s) return ''
  return s.length > max ? s.slice(0, max) + `…[+${s.length - max} chars]` : s
}

function parseVerdict(text: string): { verdict: 'ok' | 'unrelated'; reason: string } | null {
  try {
    const m = text.match(/\{[\s\S]*\}/)
    if (m) {
      const j = JSON.parse(m[0]) as { verdict?: string; reason?: string }
      if (j.verdict === 'unrelated')
        return { verdict: 'unrelated', reason: j.reason ?? 'critic flagged the change' }
      if (j.verdict === 'ok') return { verdict: 'ok', reason: j.reason ?? '' }
    }
  } catch {}
  // Non-JSON fallback: an explicit keyword beats a parse failure.
  if (/\bunrelated\b/i.test(text)) return { verdict: 'unrelated', reason: text.slice(0, 300) }
  return null // unclear → treat as no-op (conservative)
}

export interface CriticReviewResult {
  verdict: 'ok' | 'unrelated' | 'skipped' | 'error'
  reason?: string
  reverted?: boolean
}

/**
 * Review one completed mutation. Never throws — every failure degrades to a
 * logged no-op, because this runs beside the agent's tool result.
 */
export async function reviewEdit(
  db: MiraDB,
  gateway: Gateway,
  input: { sessionID: string; path: string; cwd: string },
): Promise<CriticReviewResult | null> {
  if (!editCriticEnabled()) return { verdict: 'skipped' }
  if (inFlight.has(input.sessionID)) return { verdict: 'skipped' }
  inFlight.add(input.sessionID)
  try {
    const taskText = recentUserPrompts(db, input.sessionID, 5).join('\n').trim()
    if (!taskText) return { verdict: 'skipped' } // no intent evidence → cannot judge

    // The pre-image recorded by the snapshotter IS this edit's before-state.
    const snap = db.sqlite
      .prepare(
        `SELECT content FROM file_snapshots WHERE session_id = ? AND path = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(input.sessionID, input.path) as { content: string | null } | undefined
    if (!snap) return { verdict: 'skipped' } // not a change this session made
    let after = ''
    try {
      after = await Bun.file(input.path).text()
    } catch {
      return { verdict: 'skipped' }
    }

    const smallModel = getConfig().smallModel
    const call = gateway.complete({
      model: smallModel || 'auto',
      system: CRITIC_SYSTEM,
      prompt:
        `TASK:\n${clip(taskText, 1500)}\n\n` +
        `FILE: ${basename(input.path)}\n\n` +
        `BEFORE:\n${clip(snap.content ?? '(file did not exist — created by this change)', 1800)}\n\n` +
        `AFTER:\n${clip(after, 1800)}\n\n` +
        `Does this change plausibly serve the task? Reply JSON only.`,
      maxTokens: 300,
    })
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('critic timeout')), CRITIC_TIMEOUT_MS),
    )
    const out = await Promise.race([call, timeout])
    const verdict = parseVerdict(out.text)
    if (!verdict) return { verdict: 'error', reason: 'unparseable critic response' }

    if (verdict.verdict === 'ok') return { verdict: 'ok', reason: verdict.reason }

    // 'unrelated' — record it where humans and agents look: the findings log.
    try {
      await writeFinding(db, {
        title: `Edit critic: ${basename(input.path)} may not match the task`,
        severity: 'minor',
        source: 'tool',
        evidence: verdict.reason,
        sessionID: input.sessionID,
      })
    } catch {}

    // Auto-revert only when the operator opted into that too.
    let reverted = false
    if (autoRollbackEnabled()) {
      const res = revertSnapshot(db, input.sessionID, { path: input.path })
      reverted = !!res.reverted
    }

    console.warn(
      `[edit-critic] ${basename(input.path)}: ${verdict.reason}` + (reverted ? ' — reverted' : ''),
    )
    return { verdict: 'unrelated', reason: verdict.reason, reverted }
  } catch (e) {
    return { verdict: 'error', reason: String(e) }
  } finally {
    inFlight.delete(input.sessionID)
  }
}
