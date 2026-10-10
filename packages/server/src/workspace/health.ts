/**
 * Project Health Score (master findings P2.2) — composite signal aggregation.
 *
 * Distinct from existing scores by scope:
 *   - /health          = process health (uptime, tools, MCP)
 *   - /learning/score  = per-session agent quality
 *   - THIS module      = the PROJECT: open defects, guardrail pressure,
 *                        self-improvement outcomes, debt inventory.
 *
 * Read-only aggregation over stores that P0/P1/P2 already populate:
 * findings (issues), audit_entries (guardrail deny rate), governance
 * proposals (promotion health), workspace_items (tech-debt inventory).
 * Every component degrades to neutral when its source is empty or missing —
 * an absent signal never invents a penalty.
 */

import type { MiraDB } from '../storage/db.js'
import type { WorkspaceIntelligence } from './intelligence.js'
import type { GovernanceGate } from '../patching/governance/index.js'

export interface HealthComponent {
  key: string
  label: string
  /** 0..100 — higher is healthier */
  score: number
  /** human-readable evidence for the score */
  detail: string
  /** number of observations the score is based on (0 = no data, neutral) */
  observations: number
}

export interface ProjectHealth {
  /** composite 0..100 (higher is healthier) */
  score: number
  grade: 'A' | 'B' | 'C' | 'D' | 'F'
  components: HealthComponent[]
  generatedAt: number
}

function gradeFor(score: number): ProjectHealth['grade'] {
  if (score >= 90) return 'A'
  if (score >= 75) return 'B'
  if (score >= 60) return 'C'
  if (score >= 40) return 'D'
  return 'F'
}

const SEVERITY_WEIGHT: Record<string, number> = { critical: 10, major: 4, minor: 1.5, info: 0.5 }

/** Open-defects component: fewer + less severe open findings = healthier. */
function findingsComponent(db: MiraDB | undefined): HealthComponent {
  const rows = (() => {
    try {
      return (
        (db?.sqlite
          .prepare(
            `SELECT severity, COUNT(*) c FROM findings WHERE status = 'open' GROUP BY severity`,
          )
          .all() as { severity: string; c: number }[]) ?? []
      )
    } catch {
      return []
    }
  })()
  const total = rows.reduce((s, r) => s + r.c, 0)
  if (total === 0) {
    return {
      key: 'defects',
      label: 'Open defects',
      score: 100,
      detail: 'no open findings',
      observations: 0,
    }
  }
  const debt = rows.reduce((s, r) => s + (SEVERITY_WEIGHT[r.severity] ?? 1) * r.c, 0)
  // 10 weighted points ≈ floor of 0; cap so extreme backlogs don't go negative
  const score = Math.max(0, 100 - debt * 10)
  const breakdown = rows.map((r) => `${r.c} ${r.severity}`).join(', ')
  return {
    key: 'defects',
    label: 'Open defects',
    score,
    detail: `${total} open findings (${breakdown})`,
    observations: total,
  }
}

/** Guardrail component: deny rate among audited tool decisions. */
function guardrailComponent(db: MiraDB | undefined): HealthComponent {
  const rows = (() => {
    try {
      return (
        (db?.sqlite
          .prepare(`SELECT decision, COUNT(*) c FROM audit_entries GROUP BY decision`)
          .all() as { decision: string; c: number }[]) ?? []
      )
    } catch {
      return []
    }
  })()
  const total = rows.reduce((s, r) => s + r.c, 0)
  if (total === 0) {
    return {
      key: 'guardrails',
      label: 'Guardrail pressure',
      score: 100,
      detail: 'no audited decisions',
      observations: 0,
    }
  }
  const denied = rows.filter((r) => r.decision === 'deny').reduce((s, r) => s + r.c, 0)
  const warned = rows.filter((r) => r.decision === 'warn').reduce((s, r) => s + r.c, 0)
  const rate = denied / total
  // deny rate is pressure: 0% → 100, 5%+ → heavily penalized
  const score = Math.max(0, Math.round(100 - rate * 100 * 4 - (warned / total) * 20))
  return {
    key: 'guardrails',
    label: 'Guardrail pressure',
    score,
    detail: `${denied} denied / ${warned} warned of ${total} audited decisions (${(rate * 100).toFixed(1)}% deny rate)`,
    observations: total,
  }
}

/** Governance component: promotion health of self-improvement proposals. */
async function governanceComponent(
  governance: GovernanceGate | undefined,
): Promise<HealthComponent> {
  const proposals = (await governance?.list()) ?? []
  if (proposals.length === 0) {
    return {
      key: 'evolution',
      label: 'Self-improvement health',
      score: 100,
      detail: 'no proposals yet',
      observations: 0,
    }
  }
  const byState: Record<string, number> = {}
  for (const p of proposals) byState[p.state] = (byState[p.state] ?? 0) + 1
  const promoted = byState['PROMOTED'] ?? 0
  const rolledBack = byState['ROLLED_BACK'] ?? 0
  const rejected = byState['REJECTED'] ?? 0
  // rejections are cheap learning; rollbacks are real damage
  const penalty = rolledBack * 15 + rejected * 4
  const score = Math.max(0, 100 - penalty)
  return {
    key: 'evolution',
    label: 'Self-improvement health',
    score,
    detail: `${proposals.length} proposals: ${promoted} promoted, ${rejected} rejected, ${rolledBack} rolled back`,
    observations: proposals.length,
  }
}

/** Debt inventory component: open tech-debt + directly-created issue items. */
function debtComponent(workspace: WorkspaceIntelligence | undefined): HealthComponent {
  const [techDebt, directIssues, activeItems] = (() => {
    try {
      const techDebt = workspace?.query({ kind: 'tech-debt', status: 'open' }) ?? []
      // Issues mirrored from findings carry metadata.findingId — they are
      // already scored under the defects component, so exclude them here
      // to avoid double-counting the same signal in two components.
      const directIssues = (workspace?.query({ kind: 'issue', status: 'open' }) ?? []).filter(
        (i) => !i.metadata.findingId,
      )
      const activeItems = Object.entries(workspace?.summary() ?? {})
        .filter(([k]) => k.endsWith(':open') || k.endsWith(':in-progress'))
        .reduce((s, [, v]) => s + v, 0)
      return [techDebt.length, directIssues.length, activeItems] as const
    } catch {
      return [0, 0, 0] as const
    }
  })()
  const penalized = techDebt + directIssues
  if (penalized === 0) {
    return {
      key: 'debt',
      label: 'Debt inventory',
      score: 100,
      detail: activeItems
        ? `${activeItems} active workspace items — all mirrored findings, already scored under defects`
        : 'no tracked debt items',
      observations: 0,
    }
  }
  const score = Math.max(0, 100 - penalized * 8)
  return {
    key: 'debt',
    label: 'Debt inventory',
    score,
    detail: `${techDebt} tech-debt + ${directIssues} direct issue items (${activeItems} total workspace items active; findings mirrored as issues are scored under defects)`,
    observations: penalized,
  }
}

export interface HealthDeps {
  db?: MiraDB
  workspace?: WorkspaceIntelligence
  governance?: GovernanceGate
}

export async function computeProjectHealth(deps: HealthDeps): Promise<ProjectHealth> {
  const components = [
    findingsComponent(deps.db),
    guardrailComponent(deps.db),
    await governanceComponent(deps.governance),
    debtComponent(deps.workspace),
  ]
  // Components with no data are excluded from the composite rather than
  // counted as perfect — a score must reflect evidence, not absence.
  const evidenced = components.filter((c) => c.observations > 0)
  const composite = evidenced.length
    ? Math.round(evidenced.reduce((s, c) => s + c.score, 0) / evidenced.length)
    : 100
  return { score: composite, grade: gradeFor(composite), components, generatedAt: Date.now() }
}
