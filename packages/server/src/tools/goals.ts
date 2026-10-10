/**
 * Tools: goal_write / goal_list / goal_update — strategic memory (long-term goals).
 *
 * Mirrors the findings.ts pattern: structured cross-agent records persisted in
 * SQLite, queryable across sessions. Agents write goals when the user states a
 * durable objective (ship X, reach Y% Z), and check active goals before major
 * work — they are injected into every loop context via activeGoalsForContext().
 */
import { z } from 'zod'
import type { ToolDef } from './registry.js'
import type { JsonValue } from '../types/index.js'
import { sharedGoals, type Goal } from '../strategic/goals.js'

const goalWriteSchema = z.object({
  title: z.string().min(1).describe('One-line goal statement'),
  description: z.string().optional().describe('What achieving this goal means concretely'),
  rationale: z
    .string()
    .optional()
    .describe('Why this goal exists — decision context for future sessions'),
  priority: z.enum(['high', 'medium', 'low']).optional().describe('Priority (default medium)'),
})

const goalWrite = {
  name: 'goal_write',
  description:
    'Persist a long-term goal (strategic memory) so future sessions steer toward it. ' +
    'Use when the user states a durable objective — not for transient tasks (use todowrite for those).',
  category: 'memory',
  schema: goalWriteSchema,
  async execute({ title, description, rationale, priority }, ctx) {
    const store = sharedGoals()
    if (!store) return { error: 'goal store unavailable (no database)' }
    const goal = store.create({
      title,
      description,
      rationale,
      priority,
      metadata: { sessionID: ctx.sessionID },
    })
    ctx.bus?.publish({
      type: 'job.updated',
      sessionID: ctx.sessionID,
      payload: { goal: goal.id, action: 'created' },
      timestamp: Date.now(),
    })
    return { id: goal.id, title: goal.title, status: goal.status, priority: goal.priority }
  },
} satisfies ToolDef<typeof goalWriteSchema>

const goalListSchema = z.object({
  status: z
    .enum(['active', 'achieved', 'abandoned'])
    .optional()
    .describe('Filter by status (default: all)'),
  limit: z.number().int().positive().max(100).optional().describe('Max rows (default 50)'),
})

const goalList = {
  name: 'goal_list',
  description:
    'List strategic goals, newest first. Check active goals before starting major work ' +
    'so effort aligns with stated long-term objectives.',
  category: 'memory',
  schema: goalListSchema,
  async execute({ status, limit }) {
    const store = sharedGoals()
    if (!store) return { error: 'goal store unavailable (no database)' }
    return store.list({ status, limit }) as unknown as JsonValue
  },
} satisfies ToolDef<typeof goalListSchema>

const goalUpdateSchema = z.object({
  id: z.string().describe('Goal ID to update'),
  action: z.enum(['achieve', 'abandon', 'reactivate', 'add_milestone', 'complete_milestone']),
  milestoneLabel: z.string().optional().describe('Label for add_milestone'),
  milestoneId: z.string().optional().describe('Milestone ID for complete_milestone'),
})

const goalUpdate = {
  name: 'goal_update',
  description:
    "Update a goal's lifecycle or milestones: achieve, abandon, reactivate, add_milestone, " +
    'or toggle complete_milestone. Reflects real progress on strategic objectives.',
  category: 'memory',
  schema: goalUpdateSchema,
  async execute({ id, action, milestoneLabel, milestoneId }, ctx) {
    const store = sharedGoals()
    if (!store) return { error: 'goal store unavailable (no database)' }
    let goal: Goal | null = null
    switch (action) {
      case 'achieve':
        goal = store.updateStatus(id, 'achieved')
        break
      case 'abandon':
        goal = store.updateStatus(id, 'abandoned')
        break
      case 'reactivate':
        goal = store.updateStatus(id, 'active')
        break
      case 'add_milestone':
        if (!milestoneLabel?.trim()) return { error: 'milestoneLabel required for add_milestone' }
        goal = store.addMilestone(id, milestoneLabel)
        break
      case 'complete_milestone':
        if (!milestoneId) return { error: 'milestoneId required for complete_milestone' }
        goal = store.completeMilestone(id, milestoneId)
        break
    }
    if (!goal) return { error: `goal not found: ${id}` }
    ctx.bus?.publish({
      type: 'job.updated',
      sessionID: ctx.sessionID,
      payload: { goal: goal.id, action },
      timestamp: Date.now(),
    })
    return { id: goal.id, status: goal.status, milestones: goal.milestones } as unknown as JsonValue
  },
} satisfies ToolDef<typeof goalUpdateSchema>

export const tools = [goalWrite, goalList, goalUpdate]
export default tools
