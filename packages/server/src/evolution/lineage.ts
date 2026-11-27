/**
 * Evolution Lineage Store — Recursive Generational Baseline Tree (AIDE² Upgrade)
 *
 * Tracks the directed acyclic tree of recursive self-improvement generations in
 * SQLite (`evolution_generations`). Each accepted and human-approved generation
 * advances the active baseline pointer (`isActiveBase = true`), so subsequent
 * optimization rounds branch from the improved agent codebase instead of the
 * initial static baseline.
 *
 * Safety invariant (fail-closed):
 *   Automated verification/generalization/canary stages move a winning node into
 *   `promoted_pending_approval`. Transitioning a node to `promoted` +
 *   `isActiveBase = true` requires an explicit human promotion call verified
 *   against the content-addressed patch hash and anti-reward-hacking gate.
 */

import { createHash } from 'node:crypto'
import type { MiraDB } from '../storage/db.js'
import type { Bus } from '../bus/index.js'
import type { JsonValue } from '../types/index.js'
import type { DomainSuiteScore, HackingFinding } from './generalization.js'

export type GenerationStatus =
  | 'candidate'
  | 'verifying'
  | 'promoted_pending_approval'
  | 'promoted'
  | 'rejected'
  | 'pruned'

export interface GenerationNode {
  id: string
  parentId: string | null
  depth: number
  proposalId: string | null
  strategyArm: string
  title: string
  targetFile: string | null
  patch: string
  patchHash: string
  summary: string
  status: GenerationStatus
  isActiveBase: boolean
  trainScore: number
  heldOutScore: number
  generalizationGap: number
  rewardHackingScore: number
  hackingFindings: HackingFinding[]
  suiteBreakdown: DomainSuiteScore[]
  contextTokensUsed: number
  approvedBy: string | null
  rejectedReason: string | null
  createdAt: number
  updatedAt: number
  promotedAt: number | null
}

export interface CreateGenerationInput {
  id?: string
  parentId?: string | null
  proposalId?: string | null
  strategyArm: string
  title: string
  targetFile?: string | null
  patch: string
  summary: string
  status?: GenerationStatus
  trainScore: number
  heldOutScore: number
  generalizationGap: number
  rewardHackingScore: number
  hackingFindings?: HackingFinding[]
  suiteBreakdown?: DomainSuiteScore[]
  contextTokensUsed?: number
}

export function computePatchHash(patch: string, targetFile?: string | null): string {
  return createHash('sha256')
    .update(String(targetFile ?? ''))
    .update('\0')
    .update(String(patch ?? ''))
    .digest('hex')
}

interface RawRow {
  id: string
  parent_id: string | null
  depth: number
  proposal_id: string | null
  strategy_arm: string
  title: string
  target_file: string | null
  patch: string
  patch_hash: string
  summary: string
  status: string
  is_active_base: number
  train_score: number
  held_out_score: number
  generalization_gap: number
  reward_hacking_score: number
  hacking_findings: string | null
  suite_breakdown: string | null
  context_tokens_used: number
  approved_by: string | null
  rejected_reason: string | null
  created_at: number
  updated_at: number
  promoted_at: number | null
}

function rowToNode(r: RawRow): GenerationNode {
  let hackingFindings: HackingFinding[] = []
  let suiteBreakdown: DomainSuiteScore[] = []
  try {
    hackingFindings = r.hacking_findings ? (JSON.parse(r.hacking_findings) as HackingFinding[]) : []
  } catch {}
  try {
    suiteBreakdown = r.suite_breakdown ? (JSON.parse(r.suite_breakdown) as DomainSuiteScore[]) : []
  } catch {}
  return {
    id: r.id,
    parentId: r.parent_id,
    depth: r.depth,
    proposalId: r.proposal_id,
    strategyArm: r.strategy_arm,
    title: r.title,
    targetFile: r.target_file,
    patch: r.patch,
    patchHash: r.patch_hash,
    summary: r.summary,
    status: r.status as GenerationStatus,
    isActiveBase: r.is_active_base === 1,
    trainScore: r.train_score,
    heldOutScore: r.held_out_score,
    generalizationGap: r.generalization_gap,
    rewardHackingScore: r.reward_hacking_score,
    hackingFindings,
    suiteBreakdown,
    contextTokensUsed: r.context_tokens_used,
    approvedBy: r.approved_by,
    rejectedReason: r.rejected_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    promotedAt: r.promoted_at,
  }
}

export class EvolutionLineageStore {
  private db: MiraDB | null
  private bus?: Bus
  private memory = new Map<string, GenerationNode>()

  constructor(db?: MiraDB | null, bus?: Bus) {
    this.db = db ?? null
    this.bus = bus
    this.ensureTable()
    this.ensureRootSeed()
  }

  ensureTable(): void {
    const sqlite = this.db?.sqlite
    if (!sqlite) return
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS evolution_generations (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        depth INTEGER NOT NULL DEFAULT 0,
        proposal_id TEXT,
        strategy_arm TEXT NOT NULL,
        title TEXT NOT NULL,
        target_file TEXT,
        patch TEXT NOT NULL DEFAULT '',
        patch_hash TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'candidate',
        is_active_base INTEGER NOT NULL DEFAULT 0,
        train_score REAL NOT NULL DEFAULT 0,
        held_out_score REAL NOT NULL DEFAULT 0,
        generalization_gap REAL NOT NULL DEFAULT 0,
        reward_hacking_score REAL NOT NULL DEFAULT 0,
        hacking_findings TEXT,
        suite_breakdown TEXT,
        context_tokens_used INTEGER NOT NULL DEFAULT 0,
        approved_by TEXT,
        rejected_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        promoted_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS evolution_gen_parent_idx ON evolution_generations(parent_id);
      CREATE INDEX IF NOT EXISTS evolution_gen_status_idx ON evolution_generations(status);
      CREATE INDEX IF NOT EXISTS evolution_gen_depth_idx ON evolution_generations(depth);
    `)
  }

  private ensureRootSeed(): void {
    const existing = this.list(1)
    if (existing.length > 0) return
    const now = Date.now()
    const rootPatch = '# Baseline Gen 0 — Mira initial self-improvement anchor'
    const root: GenerationNode = {
      id: 'gen_0',
      parentId: null,
      depth: 0,
      proposalId: null,
      strategyArm: 'baseline',
      title: 'Initial Mira Baseline (Gen 0)',
      targetFile: null,
      patch: rootPatch,
      patchHash: computePatchHash(rootPatch, null),
      summary: 'Seed baseline generation prior to recursive self-improvement iterations.',
      status: 'promoted',
      isActiveBase: true,
      trainScore: 0.74,
      heldOutScore: 0.72,
      generalizationGap: 0.02,
      rewardHackingScore: 0,
      hackingFindings: [],
      suiteBreakdown: [
        { domain: 'coding_repair', score: 0.72, passed: true, reason: 'Baseline benchmark' },
        { domain: 'algorithmic_efficiency', score: 0.73, passed: true, reason: 'Baseline benchmark' },
        { domain: 'reasoning_robustness', score: 0.72, passed: true, reason: 'Baseline benchmark' },
        { domain: 'ood_shift', score: 0.71, passed: true, reason: 'Baseline benchmark' },
      ],
      contextTokensUsed: 0,
      approvedBy: 'system_seed',
      rejectedReason: null,
      createdAt: now,
      updatedAt: now,
      promotedAt: now,
    }
    this.saveNode(root)
  }

  private saveNode(node: GenerationNode): void {
    const sqlite = this.db?.sqlite
    if (!sqlite) {
      this.memory.set(node.id, node)
      return
    }
    sqlite
      .prepare(
        `INSERT OR REPLACE INTO evolution_generations (
          id, parent_id, depth, proposal_id, strategy_arm, title, target_file,
          patch, patch_hash, summary, status, is_active_base,
          train_score, held_out_score, generalization_gap, reward_hacking_score,
          hacking_findings, suite_breakdown, context_tokens_used,
          approved_by, rejected_reason, created_at, updated_at, promoted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        node.id,
        node.parentId,
        node.depth,
        node.proposalId,
        node.strategyArm,
        node.title,
        node.targetFile,
        node.patch,
        node.patchHash,
        node.summary,
        node.status,
        node.isActiveBase ? 1 : 0,
        node.trainScore,
        node.heldOutScore,
        node.generalizationGap,
        node.rewardHackingScore,
        JSON.stringify(node.hackingFindings),
        JSON.stringify(node.suiteBreakdown),
        node.contextTokensUsed,
        node.approvedBy,
        node.rejectedReason,
        node.createdAt,
        node.updatedAt,
        node.promotedAt,
      )
  }

  get(id: string): GenerationNode | null {
    const sqlite = this.db?.sqlite
    if (!sqlite) return this.memory.get(id) ?? null
    const row = sqlite
      .prepare(`SELECT * FROM evolution_generations WHERE id = ?`)
      .get(id) as RawRow | undefined
    return row ? rowToNode(row) : null
  }

  getActiveBase(): GenerationNode {
    const sqlite = this.db?.sqlite
    if (!sqlite) {
      for (const n of this.memory.values()) {
        if (n.isActiveBase) return n
      }
      this.ensureRootSeed()
      return this.memory.get('gen_0')!
    }
    const row = sqlite
      .prepare(
        `SELECT * FROM evolution_generations WHERE is_active_base = 1 ORDER BY depth DESC, promoted_at DESC LIMIT 1`,
      )
      .get() as RawRow | undefined
    if (row) return rowToNode(row)
    this.ensureRootSeed()
    return this.get('gen_0')!
  }

  list(limit = 100, status?: GenerationStatus): GenerationNode[] {
    const sqlite = this.db?.sqlite
    if (!sqlite) {
      let arr = Array.from(this.memory.values())
      if (status) arr = arr.filter((n) => n.status === status)
      return arr.sort((a, b) => b.createdAt - a.createdAt || b.depth - a.depth).slice(0, limit)
    }
    if (status) {
      const rows = sqlite
        .prepare(
          `SELECT * FROM evolution_generations WHERE status = ? ORDER BY depth DESC, created_at DESC LIMIT ?`,
        )
        .all(status, limit) as RawRow[]
      return rows.map(rowToNode)
    }
    const rows = sqlite
      .prepare(
        `SELECT * FROM evolution_generations ORDER BY depth DESC, created_at DESC LIMIT ?`,
      )
      .all(limit) as RawRow[]
    return rows.map(rowToNode)
  }

  getAncestors(id: string, maxDepth = 32): GenerationNode[] {
    const chain: GenerationNode[] = []
    let cur = this.get(id)
    const seen = new Set<string>()
    while (cur && !seen.has(cur.id) && chain.length < maxDepth) {
      seen.add(cur.id)
      chain.push(cur)
      cur = cur.parentId ? this.get(cur.parentId) : null
    }
    return chain.reverse()
  }

  createCandidate(input: CreateGenerationInput): GenerationNode {
    const activeBase = this.getActiveBase()
    const parent = input.parentId ? (this.get(input.parentId) ?? activeBase) : activeBase
    const now = Date.now()
    const depth = parent.depth + 1
    const id =
      input.id ??
      `gen_${depth}_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    const node: GenerationNode = {
      id,
      parentId: parent.id,
      depth,
      proposalId: input.proposalId ?? null,
      strategyArm: input.strategyArm,
      title: input.title,
      targetFile: input.targetFile ?? null,
      patch: input.patch,
      patchHash: computePatchHash(input.patch, input.targetFile ?? null),
      summary: input.summary,
      status: input.status ?? 'candidate',
      isActiveBase: false,
      trainScore: input.trainScore,
      heldOutScore: input.heldOutScore,
      generalizationGap: input.generalizationGap,
      rewardHackingScore: input.rewardHackingScore,
      hackingFindings: input.hackingFindings ?? [],
      suiteBreakdown: input.suiteBreakdown ?? [],
      contextTokensUsed: input.contextTokensUsed ?? 0,
      approvedBy: null,
      rejectedReason: null,
      createdAt: now,
      updatedAt: now,
      promotedAt: null,
    }
    this.saveNode(node)
    return node
  }

  submitForApproval(id: string): { ok: boolean; node?: GenerationNode; reason?: string } {
    const node = this.get(id)
    if (!node) return { ok: false, reason: 'generation not found' }
    if (node.rewardHackingScore >= 0.4) {
      return { ok: false, reason: 'blocked by anti-reward-hacking gate' }
    }
    if (node.status === 'promoted' || node.status === 'rejected') {
      return { ok: false, reason: `cannot submit terminal state ${node.status}` }
    }
    const updated: GenerationNode = {
      ...node,
      status: 'promoted_pending_approval',
      updatedAt: Date.now(),
    }
    this.saveNode(updated)
    return { ok: true, node: updated }
  }

  /**
   * Human-gated promotion: advances `isActiveBase` to this generation inside a
   * transaction so subsequent evolution cycles optimize on top of this rewrite.
   */
  promoteGeneration(
    id: string,
    opts: { approver: string; expectedHash?: string },
  ): { ok: boolean; node?: GenerationNode; previousBaseId?: string; reason?: string } {
    const node = this.get(id)
    if (!node) return { ok: false, reason: 'generation not found' }
    if (node.status !== 'promoted_pending_approval') {
      return {
        ok: false,
        reason: `human promotion requires status promoted_pending_approval (got ${node.status})`,
      }
    }
    if (node.rewardHackingScore >= 0.4 || node.hackingFindings.some((f) => f.severity === 'critical')) {
      return {
        ok: false,
        reason: 'fail-closed: anti-reward-hacking findings prohibit promotion',
      }
    }
    if (opts.expectedHash && opts.expectedHash !== node.patchHash) {
      return {
        ok: false,
        reason: 'artifact hash mismatch: candidate changed since approval request',
      }
    }

    const prevBase = this.getActiveBase()
    const now = Date.now()
    const sqlite = this.db?.sqlite

    if (sqlite) {
      const tx = sqlite.transaction(() => {
        sqlite.prepare(`UPDATE evolution_generations SET is_active_base = 0 WHERE is_active_base = 1`).run()
        sqlite
          .prepare(
            `UPDATE evolution_generations
             SET status = 'promoted', is_active_base = 1, approved_by = ?, promoted_at = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(opts.approver, now, now, id)
      })
      tx()
    } else {
      for (const [k, v] of this.memory.entries()) {
        if (v.isActiveBase) {
          this.memory.set(k, { ...v, isActiveBase: false, updatedAt: now })
        }
      }
      this.memory.set(id, {
        ...node,
        status: 'promoted',
        isActiveBase: true,
        approvedBy: opts.approver,
        promotedAt: now,
        updatedAt: now,
      })
    }

    const promoted = this.get(id)!
    try {
      this.bus?.publish({
        type: 'evolution.generation_promoted' as unknown as import('../types/index.js').BusEventType,
        payload: {
          generationId: promoted.id,
          parentId: promoted.parentId,
          previousBaseId: prevBase.id,
          depth: promoted.depth,
          approver: opts.approver,
          heldOutScore: promoted.heldOutScore,
        } as unknown as JsonValue,
        timestamp: now,
      } as unknown as import('../types/index.js').BusEvent)
    } catch {}

    return { ok: true, node: promoted, previousBaseId: prevBase.id }
  }

  rejectGeneration(
    id: string,
    opts: { reason: string; actor: string },
  ): { ok: boolean; node?: GenerationNode; reason?: string } {
    const node = this.get(id)
    if (!node) return { ok: false, reason: 'generation not found' }
    if (node.isActiveBase) {
      return { ok: false, reason: 'cannot reject the active baseline generation directly' }
    }
    const updated: GenerationNode = {
      ...node,
      status: 'rejected',
      isActiveBase: false,
      rejectedReason: opts.reason || `rejected by ${opts.actor}`,
      updatedAt: Date.now(),
    }
    this.saveNode(updated)
    return { ok: true, node: updated }
  }

  summary(): {
    totalGenerations: number
    maxDepth: number
    pendingApprovalCount: number
    promotedCount: number
    rejectedCount: number
    hackingBlockedCount: number
    activeBaseId: string
    activeBaseDepth: number
    activeBaseHeldOutScore: number
  } {
    const all = this.list(500)
    const active = this.getActiveBase()
    return {
      totalGenerations: all.length,
      maxDepth: all.reduce((m, n) => Math.max(m, n.depth), 0),
      pendingApprovalCount: all.filter((n) => n.status === 'promoted_pending_approval').length,
      promotedCount: all.filter((n) => n.status === 'promoted').length,
      rejectedCount: all.filter((n) => n.status === 'rejected').length,
      hackingBlockedCount: all.filter((n) => n.rewardHackingScore >= 0.4).length,
      activeBaseId: active.id,
      activeBaseDepth: active.depth,
      activeBaseHeldOutScore: active.heldOutScore,
    }
  }
}
