/**
 * Bounded Loop Context & Memory Manager (AIDE² Upgrade)
 *
 * Prevents unbounded context bloat across multi-generation recursive search
 * iterations. Retains recent generation candidates in full detail while
 * deterministically compacting older ancestor steps into concise invariants,
 * winning strategy notes, and LoopGuard-blocked dead-end signatures.
 */

export interface AncestorContextItem {
  id: string
  depth: number
  strategyArm: string
  status: string
  summary: string
  heldOutScore: number
  rewardHackingScore: number
}

export interface ContextBudgetOptions {
  budgetTokens?: number
  maxRecentFull?: number
  deadEndSignatures?: string[]
}

export interface CompactedAncestor {
  id: string
  depth: number
  strategyArm: string
  status: string
  digest: string
  compacted: boolean
}

export interface BoundedLoopContextResult {
  budgetTokens: number
  usedTokens: number
  utilizationPct: number
  retainedCount: number
  compactedCount: number
  truncatedCount: number
  prunedDeadEnds: number
  ancestorChain: CompactedAncestor[]
  compactedDigest: string
}

const DEFAULT_BUDGET_TOKENS = 2048
const DEFAULT_MAX_RECENT_FULL = 3
const CHARS_PER_TOKEN = 4

export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN))
}

function clipText(text: string, maxChars: number): string {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`
}

export class BoundedLoopContextManager {
  private readonly defaultBudgetTokens: number
  private readonly defaultMaxRecentFull: number

  constructor(opts?: { budgetTokens?: number; maxRecentFull?: number }) {
    this.defaultBudgetTokens =
      typeof opts?.budgetTokens === 'number' && opts.budgetTokens >= 128
        ? Math.floor(opts.budgetTokens)
        : DEFAULT_BUDGET_TOKENS
    this.defaultMaxRecentFull =
      typeof opts?.maxRecentFull === 'number' && opts.maxRecentFull >= 1
        ? Math.floor(opts.maxRecentFull)
        : DEFAULT_MAX_RECENT_FULL
  }

  /**
   * Compact an ordered ancestor chain (oldest -> newest) strictly within budgetTokens.
   */
  compact(
    ancestors: AncestorContextItem[],
    opts: ContextBudgetOptions = {},
  ): BoundedLoopContextResult {
    const budgetTokens =
      typeof opts.budgetTokens === 'number' && opts.budgetTokens >= 128
        ? Math.floor(opts.budgetTokens)
        : this.defaultBudgetTokens
    const maxRecentFull =
      typeof opts.maxRecentFull === 'number' && opts.maxRecentFull >= 1
        ? Math.floor(opts.maxRecentFull)
        : this.defaultMaxRecentFull
    const deadEnds = (opts.deadEndSignatures ?? []).slice(0, 12)

    // Reserve small header/dead-end budget first
    const deadEndLine =
      deadEnds.length > 0
        ? `Avoid dead-ends: ${deadEnds.map((d) => clipText(d, 48)).join(' | ')}`
        : ''
    let usedTokens = estimateTokens(deadEndLine)

    // Walk newest -> oldest so the active base and immediate parents get priority
    const orderedNewestFirst = [...ancestors].sort((a, b) => b.depth - a.depth)
    const selected: CompactedAncestor[] = []
    let retainedCount = 0
    let compactedCount = 0
    let truncatedCount = 0

    for (let idx = 0; idx < orderedNewestFirst.length; idx++) {
      const node = orderedNewestFirst[idx]!
      const isRecent = idx < maxRecentFull
      const isFlagged = node.rewardHackingScore >= 0.4 || node.status === 'rejected'

      const rawDigest = isRecent
        ? `G${node.depth} [${node.strategyArm}/${node.status}] heldOut=${node.heldOutScore.toFixed(2)}: ${clipText(node.summary, 220)}`
        : `G${node.depth} [${node.strategyArm}] ${node.status} (${node.heldOutScore.toFixed(2)}): ${clipText(node.summary, 72)}`

      const cost = estimateTokens(rawDigest)
      if (usedTokens + cost <= budgetTokens) {
        usedTokens += cost
        selected.push({
          id: node.id,
          depth: node.depth,
          strategyArm: node.strategyArm,
          status: node.status,
          digest: rawDigest,
          compacted: !isRecent || isFlagged,
        })
        if (isRecent && !isFlagged) retainedCount++
        else compactedCount++
      } else {
        // Attempt ultra-compact one-line form if room remains for at least 16 tokens
        const micro = `G${node.depth}:${node.strategyArm}=${node.heldOutScore.toFixed(2)}`
        const microCost = estimateTokens(micro)
        if (usedTokens + microCost <= budgetTokens) {
          usedTokens += microCost
          selected.push({
            id: node.id,
            depth: node.depth,
            strategyArm: node.strategyArm,
            status: node.status,
            digest: micro,
            compacted: true,
          })
          compactedCount++
        } else {
          truncatedCount++
        }
      }
    }

    // Restore chronological order (oldest -> active base) for readable prompt/UI rendering
    selected.sort((a, b) => a.depth - b.depth)

    const digestLines = [...selected.map((s) => s.digest), ...(deadEndLine ? [deadEndLine] : [])]
    const compactedDigest = digestLines.join('\n')
    const finalTokens = Math.min(budgetTokens, estimateTokens(compactedDigest))

    return {
      budgetTokens,
      usedTokens: finalTokens,
      utilizationPct: Math.min(100, Math.round((finalTokens / budgetTokens) * 100)),
      retainedCount,
      compactedCount,
      truncatedCount,
      prunedDeadEnds: deadEnds.length,
      ancestorChain: selected,
      compactedDigest,
    }
  }
}
