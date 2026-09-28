/**
 * Learning Quality Measurement — determines which memories improve outcomes,
 * which create regressions, and which should be forgotten.
 *
 * Tracks memory usage events (retrieved → task outcome) and computes
 * per-memory quality scores. Memories with consistently negative outcomes
 * are flagged for retirement.
 *
 * Persisted to SQLite (memory_quality table).
 */

import type { MiraDB } from '../storage/db.js'

export interface MemoryUsageEvent {
  memoryId: string
  taskId: string
  outcome: 'success' | 'failure'
  timestamp: number
}

export interface MemoryQualityScore {
  memoryId: string
  uses: number
  successes: number
  failures: number
  successRate: number
  qualityScore: number // -1..1: negative = harmful, positive = helpful
  recommendation: 'keep' | 'review' | 'retire'
  lastUsedAt: number
}

export class MemoryQualityTracker {
  constructor(private deps: { db?: MiraDB }) {
    this.initSchema()
  }

  private initSchema(): void {
    this.deps.db?.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS memory_quality (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memory_quality_memory_idx ON memory_quality(memory_id);
      CREATE INDEX IF NOT EXISTS memory_quality_ts_idx ON memory_quality(ts);
    `)
  }

  /** Record that a memory was used and whether the task succeeded. */
  record(event: MemoryUsageEvent): void {
    this.deps.db?.sqlite
      .prepare(
        `INSERT INTO memory_quality (memory_id, task_id, outcome, ts)
         VALUES (?, ?, ?, ?)`,
      )
      .run(event.memoryId, event.taskId, event.outcome, event.timestamp)
  }

  /** Compute quality scores for all memories that have been used. */
  scores(): MemoryQualityScore[] {
    const sqlite = this.deps.db?.sqlite
    if (!sqlite) return []
    const rows = sqlite
      .prepare(
        `SELECT memory_id, COUNT(*) uses,
                SUM(CASE WHEN outcome='success' THEN 1 ELSE 0 END) successes,
                SUM(CASE WHEN outcome='failure' THEN 1 ELSE 0 END) failures,
                MAX(ts) last_ts
         FROM memory_quality GROUP BY memory_id`,
      )
      .all() as { memory_id: string; uses: number; successes: number; failures: number; last_ts: number }[]
    return rows.map((r) => {
      const successRate = r.uses ? r.successes / r.uses : 0
      const qualityScore = r.uses >= 3 ? (r.successes - r.failures) / r.uses : 0
      const recommendation: MemoryQualityScore['recommendation'] =
        r.uses < 3 ? 'review' : qualityScore <= -0.3 ? 'retire' : qualityScore >= 0.3 ? 'keep' : 'review'
      return {
        memoryId: r.memory_id,
        uses: r.uses,
        successes: r.successes,
        failures: r.failures,
        successRate,
        qualityScore,
        recommendation,
        lastUsedAt: r.last_ts,
      }
    })
  }

  /** Memories recommended for retirement (harmful or stale). */
  retirementCandidates(): MemoryQualityScore[] {
    return this.scores().filter((s) => s.recommendation === 'retire')
  }
}

export function createMemoryQualityTracker(deps: { db?: MiraDB }): MemoryQualityTracker {
  return new MemoryQualityTracker(deps)
}
