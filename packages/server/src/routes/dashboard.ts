/**
 * Engineering Dashboard — unified visibility API.
 *
 * Aggregates metrics from all subsystems:
 *   - Agent health (reliability scores)
 *   - Benchmark trends (governance proposals)
 *   - Learning activity (memory quality)
 *   - Promotions/Rollbacks (governance lifecycle)
 *   - Memory growth (knowledge base stats)
 *   - Cost tracking (agent run costs)
 */

import type { Hono } from 'hono'
import type { MiraDB } from '../storage/db.js'
import type { Bus } from '../bus/index.js'
import type { GovernanceGate } from '../patching/governance/index.js'
import type { AgentMetricsStore } from '../agents/metrics.js'
import type { MemoryQualityTracker } from '../learning/quality.js'
import type { WorkspaceIntelligence } from '../workspace/intelligence.js'
import type { RepoKnowledgeGraph } from '../repo/graph.js'

export interface DashboardDeps {
  db?: MiraDB
  bus?: Bus
  governance?: GovernanceGate
  agentMetrics?: AgentMetricsStore
  memoryQuality?: MemoryQualityTracker
  workspace?: WorkspaceIntelligence
  repoGraph?: RepoKnowledgeGraph
}

export interface DashboardData {
  agents: {
    total: number
    avgReliability: number
    topPerformer: string | null
    stats: Array<{ agent: string; runs: number; reliabilityScore: number; successRate: number }>
  }
  governance: {
    totalProposals: number
    byState: Record<string, number>
    recentTransitions: Array<{ proposalId: string; from: string; to: string; at: number }>
  }
  learning: {
    totalMemories: number
    byProvenance: Record<string, number>
    qualityScores: Array<{ memoryId: string; qualityScore: number; recommendation: string }>
    retirementCandidates: number
  }
  workspace: {
    summary: Record<string, number>
    openItems: number
  }
  repo: {
    nodes: number
    edges: number
    byKind: Record<string, number>
  }
  cost: {
    totalTokens: number
    totalRuns: number
    avgCostPerRun: number
  }
}

export function mountDashboardRoutes(app: Hono<{ Variables: { requestId: string } }>, deps: DashboardDeps) {
  app.get('/dashboard', async (c) => {
    const data = await aggregateDashboard(deps)
    return c.json(data)
  })
}

async function aggregateDashboard(deps: DashboardDeps): Promise<DashboardData> {
  const agentStats = deps.agentMetrics?.stats() ?? []
  const memoryScores = deps.memoryQuality?.scores() ?? []
  const workspaceSummary = deps.workspace?.summary() ?? {}
  const repoStats = deps.repoGraph?.stats() ?? { nodes: 0, edges: 0, byKind: {} }

  const proposals = (await deps.governance?.list()) ?? []
  const byState: Record<string, number> = {}
  for (const p of proposals) {
    byState[p.state] = (byState[p.state] ?? 0) + 1
  }

  const totalTokens = agentStats.reduce((s, a) => s + a.totalCostTokens, 0)
  const totalRuns = agentStats.reduce((s, a) => s + a.runs, 0)

  return {
    agents: {
      total: agentStats.length,
      avgReliability: agentStats.length ? agentStats.reduce((s, a) => s + a.reliabilityScore, 0) / agentStats.length : 0,
      topPerformer: agentStats.length ? agentStats.sort((a, b) => b.reliabilityScore - a.reliabilityScore)[0]?.agent ?? null : null,
      stats: agentStats.map((a) => ({ agent: a.agent, runs: a.runs, reliabilityScore: a.reliabilityScore, successRate: a.successRate })),
    },
    governance: {
      totalProposals: proposals.length,
      byState,
      recentTransitions: proposals
        .filter((p) => p.state === 'PROMOTED' || p.state === 'ROLLED_BACK')
        .slice(0, 10)
        .map((p) => ({ proposalId: p.id, from: 'CANARY_PASSED', to: p.state, at: p.updatedAt })),
    },
    learning: {
      totalMemories: memoryScores.length,
      byProvenance: {},
      qualityScores: memoryScores.map((m) => ({ memoryId: m.memoryId, qualityScore: m.qualityScore, recommendation: m.recommendation })),
      retirementCandidates: memoryScores.filter((m) => m.recommendation === 'retire').length,
    },
    workspace: {
      summary: workspaceSummary,
      openItems: Object.entries(workspaceSummary).filter(([k]) => k.endsWith(':open')).reduce((s, [, v]) => s + v, 0),
    },
    repo: {
      nodes: repoStats.nodes,
      edges: repoStats.edges,
      byKind: repoStats.byKind,
    },
    cost: {
      totalTokens,
      totalRuns,
      avgCostPerRun: totalRuns ? totalTokens / totalRuns : 0,
    },
  }
}
