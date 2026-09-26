// Phase 5 ops hygiene — zero-result streak: 3 consecutive empty online cycles
// raise exactly one HIGH (schema `major`) finding; any cycle with insights
// resets the streak so the next dry spell can fire again.
import { describe, expect, test } from 'bun:test'
import { LearningScheduler } from './scheduler.js'
import { KnowledgeBase } from './knowledge.js'
import type { Insight, OnlineLearner } from './online.js'
import type { UsageLearner } from './usage.js'
import type { ImprovementEngine } from './improvement.js'
import { createDatabase, migrate } from '../storage/db.js'
import { listFindings } from '../tools/findings.js'
import type { Finding } from '../tools/findings.js'

function freshAnalysis() {
  return {
    window: { from: 0, to: 0, sessions: 0 },
    failurePatterns: [],
    successPatterns: [],
    toolStats: {},
    modelStats: {},
    generatedAt: Date.now(),
  }
}

function goodInsight(): Insight {
  return {
    id: 'ins_cycle_ok',
    source: 'https://x.local/cycle',
    sourceTitle: 'Cycle result',
    category: 'tool',
    summary: 'agent tool result worth keeping',
    pattern: 'Keep the agent tool result in memory.',
    relevance: 0.9,
    tags: ['agent'],
    rawExcerpt: '',
    createdAt: Date.now(),
  }
}

/** One scheduler whose online stub replays `queue` (one entry per cycle). */
async function makeScheduler(queue: Array<Insight[]>) {
  const db = createDatabase(':memory:')
  await migrate(db)
  let call = 0
  const online = { learnOnce: async () => queue[call++] ?? [] } as unknown as OnlineLearner
  const usage = { analyze: async () => freshAnalysis() } as unknown as UsageLearner
  const improvement = { runCycle: async () => ({ ok: true, applied: 0 }) } as unknown as ImprovementEngine
  const knowledge = new KnowledgeBase({ db })
  const scheduler = new LearningScheduler({ online, usage, improvement, knowledge, db })
  // Pre-arm the 4h improvement throttle so the insights cycle doesn't chain
  // improvement/skill-promotion side paths (keeps the test hermetic).
  ;(scheduler as unknown as { lastImprovementAt: number }).lastImprovementAt = Date.now()
  return { scheduler, db, knowledge }
}

async function streakFindings(db: Awaited<ReturnType<typeof createDatabase>>): Promise<Finding[]> {
  const all = await listFindings(db, { limit: 50 })
  return all.filter((f) => f.title.startsWith('Online learning zero-result streak'))
}

describe('LearningScheduler — zero-result streak finding', () => {
  test('3 empty cycles raise the finding exactly once; insights reset the streak', async () => {
    const { scheduler, db, knowledge } = await makeScheduler([
      [], // cycle 1 — empty
      [], // cycle 2 — empty
      [], // cycle 3 — empty → fire
      [], // cycle 4 — empty, already fired for this streak
      [goodInsight()], // cycle 5 — insights → reset, no finding
      [], // cycle 6 — streak rebuilding
      [], // cycle 7
      [], // cycle 8 — streak reaches 3 again → fire #2
    ])

    // Cycles 1–3: exactly one finding
    for (let i = 0; i < 3; i++) await scheduler.trigger('online')
    let findings = await streakFindings(db)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.severity).toBe('major') // schema HIGH tier
    expect(findings[0]!.title).toContain('3 consecutive')

    // Cycle 4: still once per streak
    await scheduler.trigger('online')
    expect(await streakFindings(db)).toHaveLength(1)

    // Cycle 5: insights → streak reset, no new finding, insight persisted
    await scheduler.trigger('online')
    expect(await streakFindings(db)).toHaveLength(1)
    expect(knowledge.get('mem_ins_cycle_ok')).toBeDefined()

    // Cycles 6–7: rebuilding, no finding yet
    await scheduler.trigger('online')
    await scheduler.trigger('online')
    expect(await streakFindings(db)).toHaveLength(1)

    // Cycle 8: third consecutive empty cycle of the new streak → second finding
    await scheduler.trigger('online')
    findings = await streakFindings(db)
    expect(findings).toHaveLength(2)
    expect(findings.every((f) => f.severity === 'major')).toBe(true)
  })
})
