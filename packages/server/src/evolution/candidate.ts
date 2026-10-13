/**
 * Evolution Candidate — build a REAL, appliable candidate from observed evidence
 *
 * Docs: MIRA_WEAKNESSES_AND_OBSTACLES.md §3/§5/§24 — a proposal must be a real
 * change to be worth verifying. Until now the evolution pipeline emitted a
 * placeholder with `--- a/<engine>` headers pointing at paths that do not
 * exist, so its own proposals could never be materialized into a variant tree
 * and measured. Everything downstream (variant, shadow, canary) was honest; the
 * pipeline's OUTPUT was not.
 *
 * This module is the bridge: given a proposed change and the files it claims to
 * touch, produce a governance Patch **only when the change is genuinely
 * appliable**:
 *   - the change is a real unified diff (patching/apply-change.isUnifiedDiff)
 *   - the diff's target file matches one of the claimed files
 *   - that file EXISTS inside the repository root
 *   - the path cannot escape the repository (no traversal, no absolute paths)
 *
 * When any of those fail the answer is `null` — the caller records an
 * INVESTIGATION, not a fabricated patch. §24's "modify code safely" only means
 * something when the modification is real.
 *
 * Documentation Maintenance — 10 items:
 * | # | Item | Status | Evidence |
 * |---|------|--------|----------|
 * | 1 | Implementation path | Implemented | packages/server/src/evolution/candidate.ts |
 * | 2 | Public interfaces | Implemented | buildCandidatePatch(opts): CandidatePatch \| null; diffTargetFile(diff): string \| null; isSafeRepoPath(p): boolean |
 * | 3 | Events | Implemented | none — pure; caller records the outcome |
 * | 4 | Configuration | Implemented | repoRoot (default process.cwd()); no env knobs |
 * | 5 | Tests | Implemented | packages/server/src/evolution/candidate.test.ts (valid candidate, traversal rejected, missing file, mismatched diff target, non-diff input) |
 * | 6 | Security boundaries | Implemented | §6/§8: path traversal + absolute paths rejected; target must exist under repoRoot; symlink escape blocked by realpath containment check |
 * | 7 | Operational procedures | Implemented | POST /evolution/observe → buildCandidatePatch → variant materialization → shadow measures by execution |
 * | 8 | Migration strategy | Implemented | additive, pure module; proposals without candidates record an investigation |
 * | 9 | Rollback strategy | Implemented | nothing persisted here; variants are disposable |
 * | 10 | Known limitations | Implemented | does not generate fixes — it validates fixes produced elsewhere (agent/human); diff generation is Target |
 */

import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { isUnifiedDiff } from '../patching/apply-change.js'
import type { ImprovementProposal } from './proposal.js'
import type { Patch } from '../patching/patcher.js'

/** Target file declared by a unified diff's `+++ b/<path>` header. */
export function diffTargetFile(diff: string): string | null {
  const m = /^\+\+\+\s+b\/(.+)$/m.exec(String(diff ?? ''))
  const raw = m?.[1]?.trim()
  if (!raw) return null
  // Strip a trailing tab/date column some diff emitters add.
  const path = raw.split('\t')[0].trim()
  return path.length > 0 ? path : null
}

/**
 * A repo-relative path that cannot escape the repository root.
 * Rejects absolute paths, parent traversal, and empty paths.
 */
export function isSafeRepoPath(p: string): boolean {
  const s = String(p ?? '').trim()
  if (!s || s.length > 500) return false
  if (isAbsolute(s)) return false
  if (s.includes('\0')) return false
  const norm = s.replace(/\\/g, '/')
  if (norm.startsWith('../') || norm === '..' || norm.includes('/../')) return false
  return true
}

export interface CandidatePatchOptions {
  proposal: ImprovementProposal
  /** The proposed change — must be a real unified diff. */
  change: string
  /** Files the proposal claims to touch (from the observe request/evidence). */
  claimedFiles?: string[]
  /** Repository root the change must resolve inside. */
  repoRoot?: string
}

export interface CandidatePatch {
  patch: Patch
  targetFile: string
  absolutePath: string
  /** Why this is a real candidate — recorded so audits can tell. */
  basis: string
}

/**
 * Build a governance Patch from a proposed change, or return null when the
 * change is not genuinely appliable. Never invents a target or a diff.
 */
export function buildCandidatePatch(opts: CandidatePatchOptions): CandidatePatch | null {
  const { proposal, change } = opts
  const repoRoot = resolve(opts.repoRoot ?? process.cwd())

  // 1. The change must be a real unified diff — not prose, not a placeholder.
  if (!isUnifiedDiff(change)) return null

  // 2. The diff must name a target file, and it must be inside the repository.
  const target = diffTargetFile(change)
  if (!target || !isSafeRepoPath(target)) return null

  // 3. The target must be one the proposal actually claims to touch — otherwise
  //    a diff could smuggle in an unrelated file.
  const claimed = (opts.claimedFiles ?? []).map((f) => String(f).replace(/^\.\//, ''))
  if (claimed.length > 0 && !claimed.includes(target)) return null

  // 4. The file must exist, and resolve INSIDE the repository (symlink escape).
  const absolute = join(repoRoot, target)
  if (!existsSync(absolute)) return null
  try {
    if (!statSync(absolute).isFile()) return null
    const realRoot = realpathSync(repoRoot)
    const realFile = realpathSync(absolute)
    const rel = relative(realRoot, realFile)
    if (rel.startsWith('..') || isAbsolute(rel)) return null
  } catch {
    return null
  }

  const patch: Patch = {
    id: `cand_${proposal.id}`,
    painPointId: 'correctness',
    kind: proposal.type === 'fix' ? 'fix' : 'improvement',
    targetFile: target,
    reason: `${proposal.cause} — ${proposal.title}`.slice(0, 300),
    change,
    verification: 'tsc --noEmit',
    severity: proposal.risk === 'high' ? 'major' : proposal.risk === 'medium' ? 'minor' : 'trivial',
    score: Math.round(proposal.confidence * 10),
    createdAt: Date.now(),
    diff: change,
    rollbackPlan: proposal.rollbackPlan,
  } as unknown as Patch

  return {
    patch,
    targetFile: target,
    absolutePath: absolute,
    basis: `real unified diff against an existing file (${target}); proposal confidence ${proposal.confidence.toFixed(2)}`,
  }
}
