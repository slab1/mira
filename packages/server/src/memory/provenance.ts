/**
 * Trust & Provenance — shared helpers (docs/PROVENANCE_DESIGN.md §2–§4)
 *
 * One vocabulary for every memory write chokepoint: `KnowledgeBase.store()`,
 * `MemoryController.store_experience/store_fact`, the `memory_write` tool and
 * the learning routes all funnel through `normalizeProvenance()`.
 *
 * `ProvenanceLevel` + `PROVENANCE_CONFIDENCE` are owned by
 * `learning/knowledge.ts` (parallel-lane diff) — this module IMPORTS them and
 * never redefines them. No ranking/quality logic lives here: provenance =
 * origin + evidence (static); utility/quality = outcome (dynamic, elsewhere);
 * temporalDecay = freshness (ranking).
 */
import { PROVENANCE_CONFIDENCE, type ProvenanceLevel } from '../learning/knowledge.js'
import type { JsonValue } from '../types/index.js'

// ── Types (§2.1 / §4) ─────────────────────────────────────────────

/** Origin class of a memory. */
export type SourceKind =
  | 'agent-authored'
  | 'tool-output'
  | 'user-stated'
  | 'imported'
  | 'derived'
  | 'unknown'

/** A link backing a claim. Opaque string `ref` — never a required fs path.
 *  Extends `Record<string, JsonValue>` so evidence arrays stay assignable to
 *  the JSON-typed tool-result envelopes (memory_search, packet provenance). */
export interface EvidenceRef extends Record<string, JsonValue> {
  kind: 'url' | 'ci' | 'benchmark' | 'session' | 'finding' | 'file' | 'message'
  ref: string // URL, run id, session id, finding id, "path:line"
  at: number // ms epoch
}

/** The provenance fields every normalized memory record always carries (§2.1). */
export interface NormalizedProvenance {
  provenance: ProvenanceLevel
  confidence: number
  sourceKind: SourceKind
  sourceRef: string | null
  createdBy: string
  evidence: EvidenceRef[]
  derivedFrom: string[]
  lastVerifiedAt: number
}

/** Optional input fields — all defaulted at the chokepoint, never required. */
export interface NormalizeInput {
  provenance?: ProvenanceLevel
  confidence?: number
  sourceKind?: SourceKind
  sourceRef?: string | null
  createdBy?: string
  evidence?: EvidenceRef[]
  derivedFrom?: string[]
  createdAt?: number
  lastVerifiedAt?: number
}

export interface NormalizeCtx {
  now?: number
  /** actor fallback when the input names none: agent:<name>, user, scheduler:online, system, legacy */
  createdBy?: string
  /** resolved parent entries for `derived` memories — weakest-link rule (§3) */
  parents?: Array<{ provenance: ProvenanceLevel; confidence: number }>
}

// ── Constants (§3 / §4) ───────────────────────────────────────────

export const EVIDENCE_CAP = 8 // §4: max 8 evidence refs per memory
export const DERIVED_CHAIN_CAP = 5 // §2.1: parent-id chain cap
export const CORROBORATION_BUMP = 0.05 // §3: per distinct new evidence ref
export const CONFIDENCE_CAP = 0.95 // §3: corroboration never reaches human-verified
export const DERIVED_CONFIDENCE_CAP = 0.7 // §3: derived can never launder trust upward
export const STALE_AFTER_MS = 90 * 24 * 60 * 60 * 1000 // §3: staleness window
export const STALE_CONFIDENCE_CAP = 0.4 // §3: effective cap once stale

const EVIDENCE_LEVEL: Partial<Record<EvidenceRef['kind'], ProvenanceLevel>> = {
  ci: 'ci-verified',
  benchmark: 'benchmark-verified',
}

// ── Level mapping (§3 default mapping) ────────────────────────────

function levelForEvidence(evidence: EvidenceRef[]): ProvenanceLevel | undefined {
  let best: ProvenanceLevel | undefined
  for (const ev of evidence) {
    const lvl = EVIDENCE_LEVEL[ev.kind]
    if (lvl && (!best || PROVENANCE_CONFIDENCE[lvl] > PROVENANCE_CONFIDENCE[best])) best = lvl
  }
  return best
}

function levelForKind(sourceKind: SourceKind, evidence: EvidenceRef[]): ProvenanceLevel {
  switch (sourceKind) {
    case 'user-stated':
      return 'human-verified'
    case 'tool-output':
      // ci|benchmark evidence upgrades tool output; bare tool output stays agent-level
      return levelForEvidence(evidence) ?? 'agent-generated'
    case 'imported':
    case 'agent-authored':
    case 'derived': // handled by deriveFromParents() before this is consulted
      return 'agent-generated'
    case 'unknown':
      return 'unverified'
  }
}

/** Weakest-link rule for synthesized memories (§3): min(parent level) capped at
 *  benchmark-verified, min(parent confidence) capped at 0.7. No parents → honest
 *  floor (agent-generated/0.5), never upward. */
function deriveFromParents(
  parents: Array<{ provenance: ProvenanceLevel; confidence: number }>,
): { level: ProvenanceLevel; confidence: number } {
  if (!parents.length) return { level: 'agent-generated', confidence: 0.5 }
  let worst = parents[0]!
  for (const p of parents)
    if (PROVENANCE_CONFIDENCE[p.provenance] < PROVENANCE_CONFIDENCE[worst.provenance]) worst = p
  const level =
    PROVENANCE_CONFIDENCE[worst.provenance] > PROVENANCE_CONFIDENCE['benchmark-verified']
      ? 'benchmark-verified'
      : worst.provenance
  const confidence = Math.min(
    DERIVED_CONFIDENCE_CAP,
    Math.min(...parents.map((p) => p.confidence)),
  )
  return { level, confidence }
}

function sanitizeEvidence(refs: EvidenceRef[] | undefined, fallbackAt: number): EvidenceRef[] {
  if (!refs?.length) return []
  return refs
    .filter((r) => !!r && typeof r.ref === 'string' && r.ref.length > 0)
    .map((r) => ({ kind: r.kind, ref: r.ref, at: typeof r.at === 'number' ? r.at : fallbackAt }))
    .slice(0, EVIDENCE_CAP)
}

// ── Public API ────────────────────────────────────────────────────

/**
 * THE normalization point (§5 chokepoint 1): every write spreads this result
 * so provenance/confidence/sourceKind/sourceRef/createdBy/evidence/
 * derivedFrom/lastVerifiedAt are never undefined.
 *
 * Default mapping (§3): user-stated→human-verified 1.0 · tool-output+ci/benchmark
 * evidence→ci-verified 0.9 / benchmark-verified 0.85 · tool-output w/o evidence,
 * agent-authored, imported→agent-generated 0.5 · unknown→unverified 0.2 ·
 * derived→weakest parent capped (≤0.7 / ≤benchmark-verified).
 * Explicit `input.provenance`/`input.confidence` win (lane defaults are the
 * fallback) — except a derived record, which can never be lifted above its cap.
 */
export function normalizeProvenance(
  input: NormalizeInput = {},
  ctx: NormalizeCtx = {},
): NormalizedProvenance {
  const now = ctx.now ?? Date.now()
  const sourceKind = input.sourceKind ?? 'agent-authored'
  const evidence = sanitizeEvidence(input.evidence, input.createdAt ?? now)
  const derivedFrom = (input.derivedFrom ?? []).slice(0, DERIVED_CHAIN_CAP)

  let provenance: ProvenanceLevel
  let confidence: number
  if (sourceKind === 'derived') {
    const d = deriveFromParents(ctx.parents ?? [])
    provenance = d.level
    confidence =
      input.confidence !== undefined ? Math.min(input.confidence, d.confidence) : d.confidence
  } else if (input.provenance !== undefined || input.confidence !== undefined) {
    provenance = input.provenance ?? levelForKind(sourceKind, evidence)
    confidence = input.confidence ?? PROVENANCE_CONFIDENCE[provenance]
  } else {
    provenance = levelForKind(sourceKind, evidence)
    confidence = PROVENANCE_CONFIDENCE[provenance]
  }

  return {
    provenance,
    confidence,
    sourceKind,
    sourceRef: input.sourceRef ?? null,
    createdBy: input.createdBy ?? ctx.createdBy ?? 'system',
    evidence,
    derivedFrom,
    lastVerifiedAt: input.lastVerifiedAt ?? input.createdAt ?? now,
  }
}

/** Read-time staleness (§3.2): stored confidence is never rewritten; once the
 *  memory has not been verified for 90d the EFFECTIVE score caps at 0.4. */
export function effectiveConfidence(
  entry: { confidence?: number; lastVerifiedAt?: number; createdAt?: number },
  now = Date.now(),
): number {
  const effective = entry.confidence ?? 0
  const verifiedAt = entry.lastVerifiedAt ?? entry.createdAt ?? now
  return now - verifiedAt > STALE_AFTER_MS
    ? Math.min(effective, STALE_CONFIDENCE_CAP)
    : effective
}

/** §4: flag, don't hide — low-confidence memories surface WITH the ⚠ caution
 *  flag (never filtered, never multiplied into rank). */
export function cautionFlag(
  entry: {
    provenance?: ProvenanceLevel
    confidence?: number
    lastVerifiedAt?: number
    createdAt?: number
  },
  now = Date.now(),
): boolean {
  const verifiedAt = entry.lastVerifiedAt ?? entry.createdAt ?? now
  return (
    effectiveConfidence(entry, now) < 0.5 ||
    entry.provenance === 'unverified' ||
    now - verifiedAt > STALE_AFTER_MS
  )
}

/**
 * §3.1 rise — corroboration only: a DISTINCT new evidence ref appends (cap 8)
 * and bumps confidence +0.05 (cap 0.95), refreshing lastVerifiedAt. Level
 * changes happen only at write time via normalizeProvenance when evidence of
 * that class is present — never from this arithmetic. Read-modify-write
 * (last-writer-wins is acceptable; evidence is append-mostly). Returns a new
 * entry — the caller persists it.
 */
export function corroborate<
  T extends { evidence?: EvidenceRef[]; confidence?: number; lastVerifiedAt?: number },
>(entry: T, ref: EvidenceRef): T {
  const evidence = entry.evidence ?? []
  if (evidence.length >= EVIDENCE_CAP) return entry
  if (evidence.some((e) => e.kind === ref.kind && e.ref === ref.ref)) return entry
  return {
    ...entry,
    evidence: [...evidence, ref],
    confidence: Math.min(CONFIDENCE_CAP, (entry.confidence ?? 0) + CORROBORATION_BUMP),
    lastVerifiedAt: typeof ref.at === 'number' ? ref.at : Date.now(),
  }
}

/** §2.4 backfill at read time: legacy rows with `metadata.sourceUrls`/`url`
 *  but no evidence derive URL evidence and become `imported`. Persisted
 *  lazily on the next write — no bulk rewrite. */
export function backfillEvidence<
  T extends {
    evidence: EvidenceRef[]
    sourceKind: SourceKind
    metadata: Record<string, JsonValue>
    createdAt: number
  },
>(entry: T): T {
  if (entry.evidence.length) return entry
  const meta = entry.metadata as Record<string, JsonValue | undefined>
  const urls = Array.isArray(meta.sourceUrls)
    ? meta.sourceUrls.filter((u): u is string => typeof u === 'string')
    : typeof meta.url === 'string'
      ? [meta.url]
      : []
  if (!urls.length) return entry
  return {
    ...entry,
    sourceKind: 'imported',
    evidence: urls.slice(0, EVIDENCE_CAP).map((u) => ({ kind: 'url', ref: u, at: entry.createdAt })),
  }
}
