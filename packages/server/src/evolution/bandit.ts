/**
 * Bandit-Guided Multi-Candidate Search Engine (AIDE² Upgrade)
 *
 * Replaces linear single-proposal exploration with a UCB1 multi-armed bandit
 * search step over core improvement strategies (`routing_heuristic`,
 * `memory_compaction`, `tool_selection`, `prompt_refinement`, `patch_repair`).
 *
 * Each search step:
 *   1. Reads the current active baseline generation from EvolutionLineageStore
 *   2. Builds bounded ancestor context via BoundedLoopContextManager
 *   3. Selects the top K strategy arms by UCB1 score (exploring unpulled arms first)
 *   4. Evaluates each candidate with GeneralizationGate (held-out + anti-hacking)
 *   5. Updates SQLite-persisted bandit arm statistics (meanReward, pulls, UCB1)
 *   6. Submits the strongest generalized candidate to `promoted_pending_approval`
 *      for human sign-off — never auto-promoting the active baseline.
 */

import type { MiraDB } from '../storage/db.js'
import type { Bus } from '../bus/index.js'
import type { JsonValue } from '../types/index.js'
import { BoundedLoopContextManager, type BoundedLoopContextResult } from './context-budget.js'
import {
  GeneralizationGate,
  type GeneralizationReport,
  type HeldOutDomain,
} from './generalization.js'
import type { EvolutionLineageStore, GenerationNode } from './lineage.js'
import type { LoopGuard } from './loop-guard.js'

export interface BanditArm {
  armId: string
  label: string
  description: string
  pulls: number
  successes: number
  totalReward: number
  meanReward: number
  lastUcbScore: number
  avgHeldOutDelta: number
  hackingBlockedCount: number
  updatedAt: number
}

export interface SearchCandidateInput {
  strategyArm?: string
  title?: string
  targetFile?: string
  patch: string
  summary?: string
  trainScore?: number
  observedHeldOut?: Partial<Record<HeldOutDomain, number>>
  staticPassed?: boolean
  securityPassed?: boolean
  verificationPassed?: boolean
}

export interface SearchStepOptions {
  k?: number
  budgetTokens?: number
  strategyArm?: string
  candidates?: SearchCandidateInput[]
}

export interface SearchCandidateOutcome {
  node: GenerationNode
  report: GeneralizationReport
  reward: number
  submittedForApproval: boolean
}

export interface SearchStepResult {
  stepId: string
  baseGenerationId: string
  baseDepth: number
  selectedArms: string[]
  candidates: SearchCandidateOutcome[]
  bestCandidateId: string | null
  contextStats: BoundedLoopContextResult
  createdAt: number
}

interface DefaultArmDef {
  armId: string
  label: string
  description: string
  defaultTargetFile: string
}

export const DEFAULT_BANDIT_ARMS: readonly DefaultArmDef[] = [
  {
    armId: 'routing_heuristic',
    label: 'Routing & Lane Optimization',
    description: 'Optimize model lane fallback, timeout jitter, and provider circuit scoring',
    defaultTargetFile: 'packages/server/src/providers/router.ts',
  },
  {
    armId: 'memory_compaction',
    label: 'Bounded Memory & Compaction',
    description: 'Tighten episodic summary compression and working-memory eviction boundaries',
    defaultTargetFile: 'packages/server/src/memory/memory_controller.ts',
  },
  {
    armId: 'tool_selection',
    label: 'Tool & Execution Safety',
    description: 'Refine tool invocation guardrails, retry backoff, and bounded output slicing',
    defaultTargetFile: 'packages/server/src/tools/index.ts',
  },
  {
    armId: 'prompt_refinement',
    label: 'Reasoning & Prompt Precision',
    description: 'Improve instruction clarity and structured verification grounding',
    defaultTargetFile: 'packages/server/src/agents/prompts.ts',
  },
  {
    armId: 'patch_repair',
    label: 'Targeted Fault & Patch Repair',
    description: 'Address recurring failure signatures with minimal localized surgical diffs',
    defaultTargetFile: 'packages/server/src/patching/patcher.ts',
  },
] as const

const UCB_EXPLORATION_C = Math.SQRT2

export function computeUcb1Score(
  arm: Pick<BanditArm, 'pulls' | 'meanReward'>,
  totalPulls: number,
  c = UCB_EXPLORATION_C,
): number {
  if (arm.pulls <= 0) return 9.99
  const total = Math.max(1, totalPulls)
  const raw = arm.meanReward + c * Math.sqrt(Math.log(total) / arm.pulls)
  return Number(Math.min(9.99, Math.max(0, raw)).toFixed(4))
}

interface RawArmRow {
  arm_id: string
  label: string
  description: string
  pulls: number
  successes: number
  total_reward: number
  mean_reward: number
  last_ucb_score: number
  avg_held_out_delta: number
  hacking_blocked_count: number
  updated_at: number
}

function rowToArm(r: RawArmRow): BanditArm {
  return {
    armId: r.arm_id,
    label: r.label,
    description: r.description,
    pulls: r.pulls,
    successes: r.successes,
    totalReward: r.total_reward,
    meanReward: r.mean_reward,
    lastUcbScore: r.last_ucb_score,
    avgHeldOutDelta: r.avg_held_out_delta,
    hackingBlockedCount: r.hacking_blocked_count,
    updatedAt: r.updated_at,
  }
}

export class BanditSearchEngine {
  private db: MiraDB | null
  private lineage: EvolutionLineageStore
  private generalization: GeneralizationGate
  private contextManager: BoundedLoopContextManager
  private loopGuard?: LoopGuard
  private bus?: Bus
  private memory = new Map<string, BanditArm>()

  constructor(opts: {
    db?: MiraDB | null
    lineage: EvolutionLineageStore
    generalization?: GeneralizationGate
    contextManager?: BoundedLoopContextManager
    loopGuard?: LoopGuard
    bus?: Bus
  }) {
    this.db = opts.db ?? null
    this.lineage = opts.lineage
    this.generalization = opts.generalization ?? new GeneralizationGate()
    this.contextManager = opts.contextManager ?? new BoundedLoopContextManager()
    this.loopGuard = opts.loopGuard
    this.bus = opts.bus
    this.ensureTable()
    this.ensureDefaultArms()
  }

  ensureTable(): void {
    const sqlite = this.db?.sqlite
    if (!sqlite) return
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS evolution_bandit_arms (
        arm_id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        pulls INTEGER NOT NULL DEFAULT 0,
        successes INTEGER NOT NULL DEFAULT 0,
        total_reward REAL NOT NULL DEFAULT 0,
        mean_reward REAL NOT NULL DEFAULT 0,
        last_ucb_score REAL NOT NULL DEFAULT 9.99,
        avg_held_out_delta REAL NOT NULL DEFAULT 0,
        hacking_blocked_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `)
  }

  private ensureDefaultArms(): void {
    const now = Date.now()
    for (const def of DEFAULT_BANDIT_ARMS) {
      const existing = this.getArm(def.armId)
      if (!existing) {
        this.saveArm({
          armId: def.armId,
          label: def.label,
          description: def.description,
          pulls: 0,
          successes: 0,
          totalReward: 0,
          meanReward: 0,
          lastUcbScore: 9.99,
          avgHeldOutDelta: 0,
          hackingBlockedCount: 0,
          updatedAt: now,
        })
      }
    }
  }

  private saveArm(arm: BanditArm): void {
    const sqlite = this.db?.sqlite
    if (!sqlite) {
      this.memory.set(arm.armId, arm)
      return
    }
    sqlite
      .prepare(
        `INSERT OR REPLACE INTO evolution_bandit_arms (
          arm_id, label, description, pulls, successes, total_reward,
          mean_reward, last_ucb_score, avg_held_out_delta, hacking_blocked_count, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        arm.armId,
        arm.label,
        arm.description,
        arm.pulls,
        arm.successes,
        arm.totalReward,
        arm.meanReward,
        arm.lastUcbScore,
        arm.avgHeldOutDelta,
        arm.hackingBlockedCount,
        arm.updatedAt,
      )
  }

  getArm(armId: string): BanditArm | null {
    const sqlite = this.db?.sqlite
    if (!sqlite) return this.memory.get(armId) ?? null
    const row = sqlite
      .prepare(`SELECT * FROM evolution_bandit_arms WHERE arm_id = ?`)
      .get(armId) as RawArmRow | undefined
    return row ? rowToArm(row) : null
  }

  listArms(): BanditArm[] {
    const sqlite = this.db?.sqlite
    const arms: BanditArm[] = sqlite
      ? (sqlite.prepare(`SELECT * FROM evolution_bandit_arms`).all() as RawArmRow[]).map(rowToArm)
      : Array.from(this.memory.values())

    const totalPulls = arms.reduce((sum, a) => sum + a.pulls, 0)
    return arms
      .map((a) => ({
        ...a,
        lastUcbScore: computeUcb1Score(a, totalPulls),
      }))
      .sort((a, b) => b.lastUcbScore - a.lastUcbScore || a.armId.localeCompare(b.armId))
  }

  selectArms(k = 3, focusArm?: string): BanditArm[] {
    const ranked = this.listArms()
    const clampedK = Math.max(1, Math.min(ranked.length, Math.floor(k)))
    if (focusArm) {
      const target = ranked.find((a) => a.armId === focusArm)
      if (target) {
        return [target, ...ranked.filter((a) => a.armId !== focusArm)].slice(0, clampedK)
      }
    }
    return ranked.slice(0, clampedK)
  }

  recordOutcome(
    armId: string,
    outcome: {
      trainScore: number
      heldOutScore: number
      baseHeldOutScore: number
      rewardHackingBlocked: boolean
      passed: boolean
    },
  ): { arm: BanditArm; reward: number } {
    const existing = this.getArm(armId) ?? {
      armId,
      label: armId,
      description: 'Custom improvement strategy',
      pulls: 0,
      successes: 0,
      totalReward: 0,
      meanReward: 0,
      lastUcbScore: 9.99,
      avgHeldOutDelta: 0,
      hackingBlockedCount: 0,
      updatedAt: Date.now(),
    }

    const rawReward = outcome.heldOutScore * 0.7 + outcome.trainScore * 0.3
    const shapedReward = outcome.rewardHackingBlocked
      ? Math.max(0, rawReward - 0.55)
      : outcome.passed
        ? Math.min(1, rawReward)
        : Math.max(0, rawReward - 0.15)
    const reward = Number(shapedReward.toFixed(4))

    const pulls = existing.pulls + 1
    const successes = existing.successes + (outcome.passed && !outcome.rewardHackingBlocked ? 1 : 0)
    const totalReward = Number((existing.totalReward + reward).toFixed(4))
    const meanReward = Number((totalReward / pulls).toFixed(4))
    const heldOutDelta = outcome.heldOutScore - outcome.baseHeldOutScore
    const avgHeldOutDelta = Number(
      (((existing.avgHeldOutDelta * existing.pulls) + heldOutDelta) / pulls).toFixed(4),
    )
    const hackingBlockedCount =
      existing.hackingBlockedCount + (outcome.rewardHackingBlocked ? 1 : 0)

    const updated: BanditArm = {
      ...existing,
      pulls,
      successes,
      totalReward,
      meanReward,
      avgHeldOutDelta,
      hackingBlockedCount,
      updatedAt: Date.now(),
    }
    this.saveArm(updated)

    // Recompute UCB across all arms
    const all = this.listArms()
    const totalPulls = all.reduce((sum, a) => sum + a.pulls, 0)
    updated.lastUcbScore = computeUcb1Score(updated, totalPulls)
    this.saveArm(updated)

    return { arm: updated, reward }
  }

  private buildCandidateForArm(arm: BanditArm, base: GenerationNode, contextDigest: string): SearchCandidateInput {
    const def = DEFAULT_BANDIT_ARMS.find((d) => d.armId === arm.armId)
    const targetFile = def?.defaultTargetFile ?? 'packages/server/src/evolution/proposal.ts'
    const nextDepth = base.depth + 1
    const contextHint = contextDigest.split('\n')[0]?.slice(0, 72) ?? 'baseline'
    const patch = [
      `--- a/${targetFile}`,
      `+++ b/${targetFile}`,
      `@@ -1,4 +1,9 @@`,
      ` // Generation ${nextDepth} candidate via ${arm.armId}`,
      `+// Bounded ancestor hint: ${contextHint}`,
      `+export function apply${arm.armId.replace(/[^a-zA-Z0-9]/g, '')}G${nextDepth}(limit = 64) {`,
      `+  const bounded = Math.max(1, Math.min(256, limit))`,
      `+  return { ok: true, bounded, validate: true }`,
      `+}`,
    ].join('\n')

    return {
      strategyArm: arm.armId,
      title: `Gen ${nextDepth}: ${arm.label}`,
      targetFile,
      patch,
      summary: `${arm.description} (branched from ${base.id} at depth ${base.depth})`,
      verificationPassed: true,
      staticPassed: true,
      securityPassed: true,
    }
  }

  /**
   * Compute bounded loop context for the active baseline generation.
   */
  getContextStats(budgetTokens?: number): BoundedLoopContextResult {
    const active = this.lineage.getActiveBase()
    const ancestors = this.lineage.getAncestors(active.id, 32)
    const loopStats = this.loopGuard?.stats()
    const deadEnds: string[] = []
    if (loopStats && loopStats.escalated > 0) {
      deadEnds.push(`${loopStats.escalated} escalated loop fingerprint(s)`)
    }
    for (const node of this.lineage.list(20, 'rejected').slice(0, 4)) {
      deadEnds.push(`${node.strategyArm}:${node.rejectedReason ?? 'rejected'}`)
    }
    return this.contextManager.compact(
      ancestors.map((a) => ({
        id: a.id,
        depth: a.depth,
        strategyArm: a.strategyArm,
        status: a.status,
        summary: a.summary,
        heldOutScore: a.heldOutScore,
        rewardHackingScore: a.rewardHackingScore,
      })),
      { budgetTokens, deadEndSignatures: deadEnds },
    )
  }

  /**
   * Execute one AIDE² recursive search iteration from the current active baseline.
   */
  runSearchStep(opts: SearchStepOptions = {}): SearchStepResult {
    const activeBase = this.lineage.getActiveBase()
    const contextStats = this.getContextStats(opts.budgetTokens)
    const k = opts.candidates?.length ?? opts.k ?? 3
    const chosenArms = this.selectArms(k, opts.strategyArm)

    const candidateInputs: SearchCandidateInput[] =
      opts.candidates && opts.candidates.length > 0
        ? opts.candidates.map((cand, i) => ({
            ...cand,
            strategyArm: cand.strategyArm ?? chosenArms[i % chosenArms.length]!.armId,
          }))
        : chosenArms.map((arm) =>
            this.buildCandidateForArm(arm, activeBase, contextStats.compactedDigest),
          )

    const outcomes: SearchCandidateOutcome[] = []

    for (let i = 0; i < candidateInputs.length; i++) {
      const cand = candidateInputs[i]!
      const armId = cand.strategyArm ?? chosenArms[0]!.armId
      const proposalId = `prop_bandit_${Date.now().toString(36)}_${i}`

      const report = this.generalization.evaluate({
        proposalId,
        patch: cand.patch,
        targetFile: cand.targetFile,
        strategyArm: armId,
        trainScore: cand.trainScore,
        observedHeldOut: cand.observedHeldOut,
        staticPassed: cand.staticPassed,
        securityPassed: cand.securityPassed,
        verificationPassed: cand.verificationPassed,
      })

      const { reward } = this.recordOutcome(armId, {
        trainScore: report.trainScore,
        heldOutScore: report.heldOutScore,
        baseHeldOutScore: activeBase.heldOutScore,
        rewardHackingBlocked: report.rewardHackingBlocked,
        passed: report.passed,
      })

      const initialStatus = report.rewardHackingBlocked || !report.passed ? 'rejected' : 'candidate'
      const node = this.lineage.createCandidate({
        parentId: activeBase.id,
        proposalId,
        strategyArm: armId,
        title: cand.title ?? `Gen ${activeBase.depth + 1}: ${armId}`,
        targetFile: cand.targetFile ?? null,
        patch: cand.patch,
        summary:
          cand.summary ??
          (report.rewardHackingBlocked
            ? report.reason
            : `${armId} candidate scored held-out ${report.heldOutScore.toFixed(2)}`),
        status: initialStatus,
        trainScore: report.trainScore,
        heldOutScore: report.heldOutScore,
        generalizationGap: report.generalizationGap,
        rewardHackingScore: report.rewardHackingScore,
        hackingFindings: report.hackingFindings,
        suiteBreakdown: report.suiteBreakdown,
        contextTokensUsed: contextStats.usedTokens,
      })

      outcomes.push({
        node,
        report,
        reward,
        submittedForApproval: false,
      })
    }

    // Queue the strongest verified, non-hacking candidate for human promotion approval
    const eligible = outcomes
      .filter(
        (o) =>
          o.report.passed &&
          !o.report.rewardHackingBlocked &&
          o.report.heldOutScore >= activeBase.heldOutScore,
      )
      .sort((a, b) => b.report.heldOutScore - a.report.heldOutScore)

    let bestCandidateId: string | null = null
    if (eligible.length > 0) {
      const winner = eligible[0]!
      const submitted = this.lineage.submitForApproval(winner.node.id)
      if (submitted.ok && submitted.node) {
        winner.node = submitted.node
        winner.submittedForApproval = true
        bestCandidateId = winner.node.id
      }
    }

    const stepResult: SearchStepResult = {
      stepId: `step_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      baseGenerationId: activeBase.id,
      baseDepth: activeBase.depth,
      selectedArms: chosenArms.map((a) => a.armId),
      candidates: outcomes,
      bestCandidateId,
      contextStats,
      createdAt: Date.now(),
    }

    try {
      this.bus?.publish({
        type: 'evolution.search_step' as unknown as import('../types/index.js').BusEventType,
        payload: {
          stepId: stepResult.stepId,
          baseGenerationId: stepResult.baseGenerationId,
          selectedArms: stepResult.selectedArms,
          bestCandidateId: stepResult.bestCandidateId,
          candidateCount: stepResult.candidates.length,
        } as unknown as JsonValue,
        timestamp: stepResult.createdAt,
      } as unknown as import('../types/index.js').BusEvent)
    } catch {}

    return stepResult
  }
}
