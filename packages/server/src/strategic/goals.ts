/**
 * Strategic Memory — structured long-term goals (master findings P2.1).
 *
 * The audit found episodic/semantic/procedural layers implemented but
 * strategic memory genuinely missing, with only dead scaffolding nearby
 * (ledger ActiveTask[] with zero writers, workspace 'roadmap' items with
 * zero call sites). This module is the real layer: a structured goals
 * store following the findings.ts precedent (typed records → agent tools →
 * prompt injection → REST), not freeform text entries.
 *
 * A Goal answers the three strategic questions the addendum asks for:
 *   - What are we trying to achieve?        (title, description)
 *   - Why does it exist / what rationale?   (rationale)
 *   - How do we know we got there?          (milestones, status)
 */

import type { MiraDB } from '../storage/db.js'

export type GoalStatus = 'active' | 'achieved' | 'abandoned'
export type GoalPriority = 'high' | 'medium' | 'low'

export interface GoalMilestone {
  id: string
  label: string
  done: boolean
}

export interface Goal {
  id: string
  title: string
  description: string
  /** Why this goal exists — the decision rationale behind it */
  rationale: string
  status: GoalStatus
  priority: GoalPriority
  milestones: GoalMilestone[]
  metadata: Record<string, string | number | boolean>
  createdAt: number
  updatedAt: number
}

export interface GoalInput {
  title: string
  description?: string
  rationale?: string
  status?: GoalStatus
  priority?: GoalPriority
  metadata?: Record<string, string | number | boolean>
}

export class GoalStore {
  constructor(private deps: { db?: MiraDB }) {
    this.initSchema()
  }

  private initSchema(): void {
    this.deps.db?.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS strategic_goals (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        rationale TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        priority TEXT NOT NULL DEFAULT 'medium',
        milestones TEXT NOT NULL DEFAULT '[]',
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS strategic_goals_status_idx ON strategic_goals(status);
      CREATE INDEX IF NOT EXISTS strategic_goals_priority_idx ON strategic_goals(priority);
    `)
  }

  create(input: GoalInput): Goal {
    const now = Date.now()
    const goal: Goal = {
      id: `goal_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      title: input.title.trim().slice(0, 300),
      description: (input.description ?? '').slice(0, 4000),
      rationale: (input.rationale ?? '').slice(0, 4000),
      status: input.status ?? 'active',
      priority: input.priority ?? 'medium',
      milestones: [],
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    }
    this.deps.db?.sqlite
      .prepare(
        `INSERT INTO strategic_goals
           (id, title, description, rationale, status, priority, milestones, metadata, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        goal.id,
        goal.title,
        goal.description,
        goal.rationale,
        goal.status,
        goal.priority,
        JSON.stringify(goal.milestones),
        JSON.stringify(goal.metadata),
        goal.createdAt,
        goal.updatedAt,
      )
    return goal
  }

  get(id: string): Goal | null {
    const row = this.deps.db?.sqlite
      .prepare(`SELECT * FROM strategic_goals WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined
    return row ? this.rowToGoal(row) : null
  }

  list(filter?: { status?: GoalStatus; priority?: GoalPriority; limit?: number }): Goal[] {
    const sqlite = this.deps.db?.sqlite
    if (!sqlite) return []
    const conditions: string[] = []
    const params: string[] = []
    if (filter?.status) {
      conditions.push('status = ?')
      params.push(filter.status)
    }
    if (filter?.priority) {
      conditions.push('priority = ?')
      params.push(filter.priority)
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = Math.min(Math.max(1, filter?.limit ?? 100), 500)
    const rows = sqlite
      .prepare(`SELECT * FROM strategic_goals ${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params, String(limit)) as Record<string, unknown>[]
    return rows.map((r) => this.rowToGoal(r))
  }

  updateStatus(id: string, status: GoalStatus): Goal | null {
    const goal = this.get(id)
    if (!goal) return null
    this.deps.db?.sqlite
      .prepare(`UPDATE strategic_goals SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, Date.now(), id)
    return { ...goal, status, updatedAt: Date.now() }
  }

  addMilestone(id: string, label: string): Goal | null {
    const goal = this.get(id)
    if (!goal) return null
    const milestone: GoalMilestone = {
      id: `ms_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
      label: label.trim().slice(0, 300),
      done: false,
    }
    const milestones = [...goal.milestones, milestone]
    this.persistMilestones(id, milestones)
    return { ...goal, milestones, updatedAt: Date.now() }
  }

  completeMilestone(id: string, milestoneId: string): Goal | null {
    const goal = this.get(id)
    if (!goal) return null
    const milestones = goal.milestones.map((m) =>
      m.id === milestoneId ? { ...m, done: !m.done } : m,
    )
    this.persistMilestones(id, milestones)
    return { ...goal, milestones, updatedAt: Date.now() }
  }

  /** Active goals rendered for loop-context injection ("" when none). */
  activeGoalsForContext(limit = 5): string {
    const goals = this.list({ status: 'active', limit })
    if (!goals.length) return ''
    return `Active goals (steer decisions toward these — check before starting major work):\n${goals
      .map((g) => {
        const ms = g.milestones.length
          ? ` (${g.milestones.filter((m) => m.done).length}/${g.milestones.length} milestones)`
          : ''
        const why = g.rationale ? ` — why: ${g.rationale.slice(0, 150)}` : ''
        return `- [${g.priority}] ${g.title}${ms}${why}`
      })
      .join('\n')}`
  }

  private persistMilestones(id: string, milestones: GoalMilestone[]): void {
    this.deps.db?.sqlite
      .prepare(`UPDATE strategic_goals SET milestones = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(milestones), Date.now(), id)
  }

  private rowToGoal(r: Record<string, unknown>): Goal {
    return {
      id: r.id as string,
      title: r.title as string,
      description: (r.description as string) ?? '',
      rationale: (r.rationale as string) ?? '',
      status: r.status as GoalStatus,
      priority: r.priority as GoalPriority,
      milestones: JSON.parse((r.milestones as string) ?? '[]') as GoalMilestone[],
      metadata: JSON.parse((r.metadata as string) ?? '{}') as Record<
        string,
        string | number | boolean
      >,
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
    }
  }
}

export function createGoalStore(deps: { db?: MiraDB }): GoalStore {
  return new GoalStore(deps)
}

/** Singleton for prompt injection + agent tools — set by createLearningSystem */
let _shared: GoalStore | undefined
export function setSharedGoals(store: GoalStore): void {
  _shared = store
}
export function sharedGoals(): GoalStore | undefined {
  return _shared
}
