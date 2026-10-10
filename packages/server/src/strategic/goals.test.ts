import { describe, test, expect, beforeEach } from 'bun:test'
import { createGoalStore, setSharedGoals, sharedGoals, type GoalStore } from './goals.js'
import { createLearningSystem } from '../learning/index.js'
import { Bus } from '../bus/index.js'
import { createDatabase, migrate, type MiraDB } from '../storage/db.js'

let db: MiraDB
let store: GoalStore

beforeEach(async () => {
  db = createDatabase(':memory:')
  await migrate(db)
  store = createGoalStore({ db })
  setSharedGoals(store)
})

describe('GoalStore', () => {
  test('create + get roundtrip with defaults', () => {
    const g = store.create({ title: 'Ship P0 wiring', rationale: 'unblocks 6 downstream features' })
    expect(g.id).toMatch(/^goal_/)
    expect(g.status).toBe('active')
    expect(g.priority).toBe('medium')
    expect(g.milestones).toEqual([])
    const fetched = store.get(g.id)
    expect(fetched?.title).toBe('Ship P0 wiring')
    expect(fetched?.rationale).toBe('unblocks 6 downstream features')
  })

  test('list filters by status and respects ordering', () => {
    const a = store.create({ title: 'a' })
    store.create({ title: 'b' })
    store.updateStatus(a.id, 'achieved')
    expect(store.list({ status: 'active' }).length).toBe(1)
    expect(store.list({ status: 'achieved' })[0]!.title).toBe('a')
    expect(store.list().length).toBe(2)
  })

  test('milestone lifecycle: add then toggle complete', () => {
    const g = store.create({ title: 'goal with milestones' })
    const withMs = store.addMilestone(g.id, 'wire store')!
    expect(withMs.milestones.length).toBe(1)
    const withMs2 = store.addMilestone(g.id, 'wire tools')!
    expect(withMs2.milestones.length).toBe(2)
    const toggled = store.completeMilestone(g.id, withMs2.milestones[0]!.id)!
    expect(toggled.milestones[0]!.done).toBe(true)
    expect(toggled.milestones[1]!.done).toBe(false)
    // toggle again → undone
    const untoggled = store.completeMilestone(g.id, withMs2.milestones[0]!.id)!
    expect(untoggled.milestones[0]!.done).toBe(false)
  })

  test('activeGoalsForContext renders priorities, progress, and rationale', () => {
    const g = store.create({
      title: 'Become agent OS',
      rationale: 'platform differentiation',
      priority: 'high',
    })
    store.addMilestone(g.id, 'P0 done')
    store.addMilestone(g.id, 'P1 done')
    store.completeMilestone(g.id, store.get(g.id)!.milestones[0]!.id)
    const other = store.create({ title: 'abandoned idea', priority: 'low' })
    store.updateStatus(other.id, 'abandoned')

    const ctx = store.activeGoalsForContext()
    expect(ctx).toContain('Active goals')
    expect(ctx).toContain('[high] Become agent OS')
    expect(ctx).toContain('(1/2 milestones)')
    expect(ctx).toContain('why: platform differentiation')
    expect(ctx).not.toContain('abandoned idea')
  })

  test('activeGoalsForContext empty when no goals', () => {
    expect(store.activeGoalsForContext()).toBe('')
  })

  test('updateStatus on unknown id returns null', () => {
    expect(store.updateStatus('missing', 'achieved')).toBeNull()
  })
})

describe('learning system wiring', () => {
  test('createLearningSystem creates the goal store and sets the shared singleton', () => {
    const bus = new Bus()
    const system = createLearningSystem({ db, bus })
    expect(system.goals).toBeDefined()
    // sharedGoals() singleton must be the same instance the system exposes
    // (the tools + prompt injection rely on it)
    expect(sharedGoals()).toBe(system.goals)

    const created = system.goals.create({ title: 'via system' })
    expect(system.goals.get(created.id)?.title).toBe('via system')
  })
})
