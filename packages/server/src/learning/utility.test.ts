// Phase 4 utility feedback loop — multiple sessions of success/failure per
// insight, and the retrieval-ordering flip that follows from it.
// Mock DB mirrors knowledge.test.ts (in-memory SQLite via createDatabase).
import { describe, expect, test } from 'bun:test'
import { KnowledgeBase } from './knowledge.js'
import type { Insight } from './online.js'
import { createDatabase, migrate } from '../storage/db.js'

async function kbWithDb(): Promise<KnowledgeBase> {
  const db = createDatabase(':memory:')
  await migrate(db)
  const kb = new KnowledgeBase({ db })
  await kb.load()
  return kb
}

function insight(id: string, pattern: string, tags: string[]): Insight {
  return {
    id,
    source: `https://x.local/${id}`,
    sourceTitle: `src ${id}`,
    category: 'agent-technique',
    summary: pattern,
    pattern,
    relevance: 0.8,
    tags,
    rawExcerpt: '',
    createdAt: Date.now(),
  }
}

describe('utility feedback — multi-session success/failure correlation', () => {
  test('success/failure sessions accumulate per-insight utility (+1/-1 each)', async () => {
    const kb = await kbWithDb()
    const winner = await kb.storeInsight(
      insight('ins_win', 'agent memory retrieval winner pattern', ['agent']),
    )
    const loser = await kb.storeInsight(
      insight('ins_lose', 'agent memory retrieval loser pattern', ['agent']),
    )
    expect((winner.metadata.utility as number) ?? 0).toBe(0)
    expect((loser.metadata.utility as number) ?? 0).toBe(0)

    // 6 sessions where the winner was injected and the turn succeeded, and 6
    // sessions where the loser was injected and the turn failed (±1 per session,
    // exactly what SessionPrompt.settleInjectedMemories applies).
    for (let i = 0; i < 6; i++) {
      kb.bumpUtility(winner.id, 1)
      kb.bumpUtility(loser.id, -1)
    }
    expect(kb.get(winner.id)!.metadata.utility).toBe(6)
    expect(kb.get(loser.id)!.metadata.utility).toBe(-6)

    // Multiple rounds keep compounding (bounded later by the ±20 clamp)
    for (let i = 0; i < 4; i++) kb.bumpUtility(winner.id, 1)
    expect(kb.get(winner.id)!.metadata.utility).toBe(10)
  })

  test('retrieval ordering flips by success correlation', async () => {
    const kb = await kbWithDb()
    // B starts ahead: identical substance but 3 matching tags vs A's 1 →
    // tag-overlap bonus (+0.08/tag) puts B first on the baseline ranking.
    const a = await kb.storeInsight(
      insight('ins_a', 'agent memory retrieval technique for sessions', ['agent']),
    )
    const b = await kb.storeInsight(
      insight(
        'ins_b',
        'agent memory retrieval technique for sessions',
        ['agent', 'memory', 'retrieval'],
      ),
    )
    const query = 'agent memory retrieval'

    const before = await kb.retrieve({ query, limit: 5, hybrid: false })
    expect(before.map((e) => e.id)).toEqual([b.id, a.id])

    // 6 successful sessions correlated with A, 6 failed sessions with B
    for (let i = 0; i < 6; i++) {
      kb.bumpUtility(a.id, 1)
      kb.bumpUtility(b.id, -1)
    }

    const after = await kb.retrieve({ query, limit: 5, hybrid: false })
    expect(after.map((e) => e.id)).toEqual([a.id, b.id])
    expect(after[0]!.id).toBe(a.id)
  })
})
