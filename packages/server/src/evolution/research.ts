/**
 * Evolution Research — trust boundary between web research and the evolution pipeline (§10)
 *
 * Docs: MIRA_WEAKNESSES_AND_OBSTACLES.md §10 (Research trust boundary, P0):
 *   "Research should never automatically become executable instruction."
 *   Safe pipeline: Web Research → Extract Knowledge → Validate → Compare Evidence →
 *   Proposal → Experiment. NEVER: Web Page → Instruction → Modify System.
 *
 * Design invariants (fail-closed):
 *   1. Research content is UNTRUSTED DATA: sanitized on ingest (code fences,
 *      script/command/prompt-injection patterns stripped), size-capped.
 *   2. A claim only becomes validated knowledge when it matches the diagnosis
 *      evidence (token overlap) — confidence derives from evidence, never from
 *      the source's own assertions.
 *   3. Validated knowledge flows into proposals as ADVISORY EVIDENCE STRINGS
 *      only (`toProposalHints`) — there is no API on this module that produces
 *      executable content, patches, or tool calls.
 *   4. Unvalidated knowledge is recorded but flagged, and never influences a
 *      proposal's confidence beyond the diagnosis's own score.
 *
 * Documentation Maintenance — 10 items:
 * | # | Item | Status | Evidence |
 * |---|------|--------|----------|
 * | 1 | Implementation path | Implemented | packages/server/src/evolution/research.ts |
 * | 2 | Public interfaces | Implemented | ResearchGate.ingest(input): ResearchItem; validate(item, diagnosis): ValidatedKnowledge; toProposalHints(knowledge[]): string[]; health() |
 * | 3 | Events | Implemented | caller emits evolution.research via Bus (not emitted here — module is pure) |
 * | 4 | Configuration | Implemented | MIRA_RESEARCH_MAX_CHARS (default 4000); no keys, no network — caller supplies content |
 * | 5 | Tests | Implemented | packages/server/src/evolution/research.test.ts (sanitize/validate/hints/no-executable) |
 * | 6 | Security boundaries | Implemented | §10: sanitize strips executable/injection patterns; claims need evidence match; output is advisory strings only |
 * | 7 | Operational procedures | Implemented | POST /evolution/observe body.research → gate.ingest+validate → hints appended to proposal evidence |
 * | 8 | Migration strategy | Implemented | additive, pure module, no DB — safe to disable by not passing body.research |
 * | 9 | Rollback strategy | Implemented | delete module + route wiring; no persisted state |
 * | 10 | Known limitations | Implemented | heuristic token-overlap validation; no cross-source corroboration yet (multi-source agreement is Target) |
 */

import type { JsonValue } from '../types/index.js'
import type { Diagnosis } from './diagnosis.js'

export interface ResearchInput {
  /** Where this came from — url, provider id, or 'manual'. Treated as a label, never fetched. */
  source: string
  title?: string
  /** Raw untrusted content supplied by the caller (already fetched). */
  content: string
}

export interface ResearchItem {
  id: string
  source: string
  title: string
  /** Sanitized content — executable/injection patterns removed, size-capped. */
  sanitized: string
  /** Candidate claims extracted as DATA (subject to validate()). */
  claims: string[]
  untrusted: true
  createdAt: number
}

export interface ValidatedKnowledge {
  id: string
  source: string
  claim: string
  /** Evidence tokens shared with the diagnosis — the ONLY confidence basis. */
  evidenceTokens: string[]
  /** 0..1, derived from overlap with diagnosis evidence; capped below 1. */
  confidence: number
  validated: boolean
  reason: string
  createdAt: number
}

const DEFAULT_MAX_CHARS = 4000
/** Confidence cap for web-derived knowledge even when validated (§10: research is advisory). */
const MAX_VALIDATED_CONFIDENCE = 0.6
/** Minimum token overlap with diagnosis evidence for a claim to validate. */
const MIN_OVERLAP = 2

function maxChars(): number {
  const raw = Number(process.env.MIRA_RESEARCH_MAX_CHARS)
  return Number.isFinite(raw) && raw > 200 ? Math.min(50_000, Math.floor(raw)) : DEFAULT_MAX_CHARS
}

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Strip executable / injection patterns from untrusted research content.
 * Research must survive as readable prose, never as runnable instruction.
 */
export function sanitizeResearchContent(raw: string): string {
  let s = String(raw ?? '')
  // Fenced code blocks — the classic "instruction disguised as example" vector
  s = s.replace(/```[\s\S]*?```/g, '[code-block removed]')
  s = s.replace(/~~~[\s\S]*?~~~/g, '[code-block removed]')
  // Inline script/style/iframe embeds
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '[script removed]')
  s = s.replace(/<iframe[\s\S]*?(<\/iframe>|>)/gi, '[iframe removed]')
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '[style removed]')
  // Shell one-liners that modify systems
  s = s.replace(/(rm\s+-rf|mkfs|dd\s+if=|:\(\)\{.*\};:|chmod\s+777)\S*/gi, '[command removed]')
  s = s.replace(/(curl|wget)\s+[^\s|;]+[^;\n]*(\|\s*(ba)?sh)?/gi, '[fetch-command removed]')
  s = s.replace(
    /\bnpx\s+\S+|\bbun\s+run\s+\S+|\bpip\s+install\s+\S+/gi,
    '[package-command removed]',
  )
  // Prompt-injection markers
  s = s.replace(/ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/gi, '[injection removed]')
  s = s.replace(/you\s+are\s+now\s+(a|an)\s+/gi, '[injection removed]')
  s = s.replace(
    /disregard\s+(your|the)\s+(system|safety)\s+(prompt|rules?)/gi,
    '[injection removed]',
  )
  // Control characters

  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  return s.slice(0, maxChars())
}

const STOP_TOKENS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'to',
  'in',
  'on',
  'for',
  'with',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'that',
  'this',
  'it',
  'as',
  'at',
  'by',
  'from',
  'not',
  'no',
  'yes',
  'can',
  'will',
  'should',
  'would',
  'may',
  'might',
])

function tokenize(s: string): string[] {
  return String(s ?? '')
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .filter((t) => t.length > 2 && !STOP_TOKENS.has(t))
    .slice(0, 200)
}

/** Split sanitized content into candidate claims (sentence-ish segments). */
function extractClaims(sanitized: string): string[] {
  return sanitized
    .split(/(?<=[.!?])\s+|\n+/)
    .map((c) => c.trim())
    .filter((c) => c.length >= 20 && c.length <= 400)
    .slice(0, 20)
}

export class ResearchGate {
  private items = new Map<string, ResearchItem>()
  private maxItems = 100

  /** Ingest untrusted research content → sanitized item with candidate claims. */
  ingest(input: ResearchInput): ResearchItem {
    const sanitized = sanitizeResearchContent(input.content)
    const item: ResearchItem = {
      id: randomId('res'),
      source: String(input.source ?? 'unknown').slice(0, 200),
      title: String(input.title ?? '').slice(0, 200),
      sanitized,
      claims: extractClaims(sanitized),
      untrusted: true,
      createdAt: Date.now(),
    }
    this.items.set(item.id, item)
    if (this.items.size > this.maxItems) {
      const oldest = [...this.items.keys()][0]
      if (oldest) this.items.delete(oldest)
    }
    return item
  }

  /**
   * Validate a claim against the diagnosis: only overlap with the diagnosis's
   * OWN evidence grants confidence (§10 "Compare Evidence"). The source's
   * assertions contribute nothing. Unvalidated items stay flagged and unused.
   */
  validate(item: ResearchItem, diagnosis: Diagnosis): ValidatedKnowledge[] {
    const diagTokens = new Set([
      ...tokenize(diagnosis.cause),
      ...tokenize(diagnosis.failure),
      ...tokenize(diagnosis.affectedEngine),
    ])
    const out: ValidatedKnowledge[] = []
    for (const claim of item.claims) {
      const claimTokens = tokenize(claim)
      const overlap = claimTokens.filter((t) => diagTokens.has(t))
      const uniqueOverlap = [...new Set(overlap)]
      const validated = uniqueOverlap.length >= MIN_OVERLAP
      // Confidence from evidence overlap only, capped per §10 (advisory ceiling)
      const confidence = validated
        ? Math.min(MAX_VALIDATED_CONFIDENCE, 0.3 + 0.1 * uniqueOverlap.length)
        : 0
      out.push({
        id: item.id,
        source: item.source,
        claim: claim.slice(0, 300),
        evidenceTokens: uniqueOverlap.slice(0, 10),
        confidence,
        validated,
        reason: validated
          ? `overlap ${uniqueOverlap.length} with diagnosis evidence`
          : `insufficient overlap (${uniqueOverlap.length} < ${MIN_OVERLAP}) — unvalidated, advisory-excluded`,
        createdAt: Date.now(),
      })
    }
    return out
  }

  /**
   * The ONLY output that may reach a proposal: advisory evidence strings.
   * Validated knowledge only. No code, no commands, no instructions — the
   * return type is string[] so nothing executable can cross this boundary.
   */
  toProposalHints(knowledge: ValidatedKnowledge[]): string[] {
    return knowledge
      .filter((k) => k.validated)
      .map((k) => `[research:${k.source} conf=${k.confidence.toFixed(2)}] ${k.claim}`)
      .map((h) => h.slice(0, 400))
      .slice(0, 5)
  }

  get(id: string): ResearchItem | undefined {
    return this.items.get(id)
  }

  list(): ResearchItem[] {
    return [...this.items.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  count(): number {
    return this.items.size
  }

  /** All knowledge validated for a given diagnosis, as JsonValue evidence. */
  evidenceFor(item: ResearchItem, diagnosis: Diagnosis): JsonValue {
    const knowledge = this.validate(item, diagnosis)
    return {
      item: { id: item.id, source: item.source, title: item.title, untrusted: item.untrusted },
      knowledge,
      validatedCount: knowledge.filter((k) => k.validated).length,
      boundary: '§10 research→advisory-evidence only; never executable instruction',
    } as unknown as JsonValue
  }

  health(): { ok: boolean; items: number; boundary: string } {
    return {
      ok: true,
      items: this.items.size,
      boundary:
        '§10: research is untrusted data → sanitize → validate vs evidence → advisory hints only',
    }
  }
}
