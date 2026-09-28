/**
 * Agent Reliability Scoring — per-agent historical evidence for planners.
 *
 * Metrics per agent:
 *   successRate, failureRate, avgLatencyMs, totalCost, reliabilityScore
 *
 * reliabilityScore = successRate * latencyScore * costScore
 *   latencyScore: 1 at <=5s avg, decays to 0.1 at >=60s
 *   costScore:    1 at <=1M tokens, decays to 0.1 at >=50M
 *
 * Persisted to SQLite (agent_metrics table), queryable for agent selection.
 */

import type { MiraDB } from '../storage/db.js'

export interface AgentRunRecord {
  agent: string
  taskSignature: string
  outcome: 'success' | 'failure'
  latencyMs: number
  costTokens: number
  timestamp: number
}

export interface AgentStats {
  agent: string
  runs: number
  successRate: number
  failureRate: number
  avgLatencyMs: number
  totalCostTokens: number
  reliabilityScore: number
  lastRunAt: number
}

export class AgentMetricsStore {
  constructor(private deps: { db?: MiraDB }) {
    this.initSchema()
  }

  private initSchema(): void {
    this.deps.db?.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL,
        task_signature TEXT NOT NULL,
        outcome TEXT NOT NULL,
        latency_ms REAL NOT NULL,
        cost_tokens INTEGER NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_runs_agent_idx ON agent_runs(agent);
      CREATE INDEX IF NOT EXISTS agent_runs_ts_idx ON agent_runs(ts);
    `)
  }

  record(run: AgentRunRecord): void {
    this.deps.db?.sqlite
      .prepare(
        `INSERT INTO agent_runs (agent, task_signature, outcome, latency_ms, cost_tokens, ts)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(run.agent, run.taskSignature, run.outcome, run.latencyMs, run.costTokens, run.timestamp)
  }

  /** Aggregate stats for all agents (or one). */
  stats(agent?: string): AgentStats[] {
    const sqlite = this.deps.db?.sqlite
    if (!sqlite) return []
    const rows = sqlite
      .prepare(
        `SELECT agent, COUNT(*) runs,
                SUM(CASE WHEN outcome='success' THEN 1 ELSE 0 END) successes,
                AVG(latency_ms) avglat,
                SUM(cost_tokens) cost,
                MAX(ts) last_ts
         FROM agent_runs ${agent ? 'WHERE agent = ?' : ''} GROUP BY agent`,
      )
      .all(...(agent ? [agent] : [])) as { agent: string; runs: number; successes: number; avglat: number; cost: number; last_ts: number }[]
    return rows.map((r) => {
      const successRate = r.runs ? r.successes / r.runs : 0
      const failureRate = 1 - successRate
      const latencyScore = Math.min(1, Math.max(0.1, 1 - (r.avglat - 5000) / 55000))
      const costScore = Math.min(1, Math.max(0.1, 1 - (r.cost - 1_000_000) / 49_000_000))
      return {
        agent: r.agent,
        runs: r.runs,
        successRate,
        failureRate,
        avgLatencyMs: r.avglat,
        totalCostTokens: r.cost,
        reliabilityScore: successRate * latencyScore * costScore,
        lastRunAt: r.last_ts,
      }
    })
  }

  /** Rank agents by reliability for a task (used by planners). */
  ranked(agents: string[]): AgentStats[] {
    return this.stats().filter((s) => agents.includes(s.agent)).sort((a, b) => b.reliabilityScore - a.reliabilityScore)
  }
}

export function createAgentMetrics(deps: { db?: MiraDB }): AgentMetricsStore {
  return new AgentMetricsStore(deps)
}
