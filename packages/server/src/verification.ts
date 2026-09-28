/**
 * Task Verification States (docs/VERIFICATION_STATES_DESIGN.md §2–§5)
 *
 * The state is a PURE FUNCTION of the child session's persisted tool-result
 * parts (exit-code evidence from `diagnose`/`bash`) — recomputed at each
 * terminal settle, never asserted by the agent (§5: there is no tool, route
 * or payload that writes these columns; only the two terminal writers fed by
 * persisted exit codes).
 *
 * Fail-closed (§3): unrecognized commands / unclassifiable results are
 * IGNORED (they prove nothing); a failed class stays failed until it is
 * re-run and passes. `EvidenceRef` is reused unchanged (§4) — kind `'message'`
 * + `{check, ok}` extras, capped at `EVIDENCE_CAP` newest.
 */
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { MiraDB } from './storage/db.js'
import { parts } from './storage/schema.js'
import { EVIDENCE_CAP, type EvidenceRef } from './memory/provenance.js'
import type { JsonValue } from './types/index.js'

export type VerificationState =
  | 'UNVERIFIED'
  | 'PARTIALLY_VERIFIED'
  | 'VERIFIED'
  | 'FAILED_VERIFICATION'

/** Closed class set (§3.2) — matches diagnose's check enum. */
export type VerificationClass = 'typecheck' | 'test' | 'build'

/** The shape every terminal writer merges into its single UPDATE (§5). */
export interface VerificationPatch {
  verificationState: VerificationState
  verificationEvidence: EvidenceRef[]
  verificationUpdatedAt: number
}

/** Normalized part row handed to the pure compute function. */
export interface VerificationPartInput {
  id?: string
  messageID?: string | null
  toolCallID?: string | null
  tool: string | null
  result: JsonValue | null
  isError?: boolean | null
  createdAt?: number | null
  /** bash crash fallback: command resolved from the sibling tool-call args. */
  command?: string | null
}

export interface VerificationOutcome {
  state: VerificationState
  evidence: EvidenceRef[]
}

function asRecord(v: JsonValue | null | undefined): Record<string, JsonValue> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, JsonValue>) : undefined
}

/**
 * §3.2 bash command → class (mirror of the per-target verification-command
 * map `learning/improvement.ts:481-524`): `bun test|npm test|pytest` → test,
 * `tsc --noEmit` → typecheck, `run build` → build. First match wins;
 * UNRECOGNIZED COMMANDS RETURN null → ignored (fail-closed: `ls` exit 0
 * proves nothing).
 */
export function classifyBashCommand(command: string): VerificationClass | null {
  if (/\b(?:bun|npm|yarn|pnpm)\s+test\b|\bpytest\b/.test(command)) return 'test'
  if (/\btsc\s+--noEmit\b/.test(command)) return 'typecheck'
  if (/\brun\s+build\b/.test(command)) return 'build'
  return null
}

/**
 * §3 state machine — pure, order-sensitive (chronological, oldest first).
 *
 *   no entries                         → UNVERIFIED
 *   any class's latest run failed      → FAILED_VERIFICATION
 *   latest 'test' run passed           → VERIFIED
 *   else any class latest passed       → PARTIALLY_VERIFIED
 */
export function computeVerification(input: readonly VerificationPartInput[]): VerificationOutcome {
  const runs: Array<{ cls: VerificationClass; ok: boolean }> = []
  const evidence: EvidenceRef[] = []

  for (const p of input) {
    const at = typeof p.createdAt === 'number' ? p.createdAt : Date.now()
    // §4: EvidenceRef reused — kind 'message' = tool-call id, extras snapshotted in.
    const ref = `msg:${p.messageID ?? ''}#${p.toolCallID ?? ''}`

    if (p.tool === 'diagnose') {
      // diagnose never throws → verdicts parsed from `result`, never `isError` (§1).
      const res = asRecord(p.result)
      const list = Array.isArray(res?.results) ? (res.results as JsonValue[]) : []
      for (const raw of list) {
        const r = asRecord(raw)
        const cls = r?.check
        // closed class set; anything else (unknown check) is ignored fail-closed
        if (cls !== 'typecheck' && cls !== 'test' && cls !== 'build') continue
        const ok = r?.ok === true
        runs.push({ cls, ok })
        evidence.push({ kind: 'message', ref, at, check: cls, ok })
      }
      // result without `results` (crash / prose) → nothing classifiable → ignored
    } else if (p.tool === 'bash') {
      const res = asRecord(p.result)
      const command =
        typeof res?.command === 'string'
          ? res.command
          : typeof p.command === 'string'
            ? p.command
            : null
      if (!command) continue
      const cls = classifyBashCommand(command)
      if (!cls) continue // unrecognized command → proves nothing (fail-closed)
      // tool-crash result ({error}, isError=true) on a matching command = FAIL;
      // otherwise ok = exitCode === 0 (missing exitCode !== 0 → fail, fail-closed).
      const ok = p.isError !== true && res?.exitCode === 0
      runs.push({ cls, ok })
      evidence.push({ kind: 'message', ref, at, check: cls, ok })
    }
    // other tools → not a verification signal → ignored
  }

  if (!runs.length) return { state: 'UNVERIFIED', evidence: [] }

  // §4: cap = EVIDENCE_CAP (8), newest kept.
  const evidence_capped =
    evidence.length > EVIDENCE_CAP ? evidence.slice(evidence.length - EVIDENCE_CAP) : evidence

  // latest-per-class wins (input is chronological → last write wins)
  const latest = new Map<VerificationClass, boolean>()
  for (const r of runs) latest.set(r.cls, r.ok)

  for (const ok of latest.values()) if (!ok) return { state: 'FAILED_VERIFICATION', evidence: evidence_capped }
  if (latest.get('test')) return { state: 'VERIFIED', evidence: evidence_capped }
  return { state: 'PARTIALLY_VERIFIED', evidence: evidence_capped }
}

/**
 * §5 chokepoint input: SELECT the child session's verification parts
 * (`type='tool-result' AND tool IN ('diagnose','bash')`, indexed `parts_session_idx`)
 * → compute → `{verificationState, verificationEvidence, verificationUpdatedAt}`.
 * No child link / no evidence → callers settle as `UNVERIFIED` (returns the
 * honest UNVERIFIED patch, or undefined only when the link is missing).
 * Never throws: a patch-build failure settles with NO patch (fail-closed —
 * status still lands, verification keeps its DB defaults).
 */
export async function buildVerificationPatch(
  db: MiraDB,
  childSessionID: string | null | undefined,
): Promise<VerificationPatch | undefined> {
  if (!childSessionID) return undefined
  try {
    const rows = await db
      .select({
        id: parts.id,
        messageID: parts.messageID,
        toolCallID: parts.toolCallID,
        tool: parts.tool,
        result: parts.result,
        isError: parts.isError,
        createdAt: parts.createdAt,
      })
      .from(parts)
      .where(
        and(
          eq(parts.sessionID, childSessionID),
          eq(parts.type, 'tool-result'),
          inArray(parts.tool, ['diagnose', 'bash']),
        ),
      )
      // chronological (stable rowid tiebreak = insertion order for equal ms)
      .orderBy(asc(parts.createdAt))

    // bash crash parts carry no `command` in `result` — resolve it from the
    // sibling tool-call part (tool-result parts don't store `args`, §1).
    const unresolved = rows.filter((r) => r.tool === 'bash' && !hasCommand(r.result))
    let cmdByCall = new Map<string, string>()
    const callIDs = [...new Set(unresolved.map((r) => r.toolCallID).filter((v): v is string => !!v))]
    if (callIDs.length) {
      const calls = await db
        .select({ toolCallID: parts.toolCallID, args: parts.args })
        .from(parts)
        .where(and(eq(parts.type, 'tool-call'), inArray(parts.toolCallID, callIDs)))
      for (const c of calls) {
        const a = asRecord(c.args)
        if (c.toolCallID && typeof a?.command === 'string') cmdByCall.set(c.toolCallID, a.command)
      }
    }

    const input: VerificationPartInput[] = rows.map((r) => ({
      ...r,
      command: r.toolCallID ? (cmdByCall.get(r.toolCallID) ?? null) : null,
    }))
    const { state, evidence } = computeVerification(input)
    return { verificationState: state, verificationEvidence: evidence, verificationUpdatedAt: Date.now() }
  } catch (e) {
    console.warn('[verification] patch build failed:', String(e))
    return undefined // fail-closed: no patch → row keeps honest defaults
  }
}

function hasCommand(result: JsonValue | null): boolean {
  const r = asRecord(result)
  return typeof r?.command === 'string'
}
