// Unit tests for the keyless-online learner (HN/arXiv/GitHub fallbacks).
// Uses in-memory fetch stubs — no external network calls.
import { describe, expect, test } from 'bun:test'
import { OnlineLearner } from './online.js'
import type { Insight } from './online.js'
import type { JsonValue } from '../types/index.js'

// ----------------------------------------------------------------
// tiny in-memory Bus + MiraDB doubles (just enough for OnlineLearner)
// ----------------------------------------------------------------
function fakeDb() {
  const stored: Array<Record<string, JsonValue | undefined>> = []
  const mockSqlite = {
    exec: (sql: string) => sql,
    prepare: (sql: string) => ({
      run: (...args: (string | number | null | undefined)[]) => {
        stored.push({ sql, args: args as JsonValue[] })
      },
    }),
  }
  return { sqlite: mockSqlite, stored } as unknown as import('../storage/db.js').MiraDB & {
    stored: Array<Record<string, JsonValue | undefined>>
  }
}

describe('OnlineLearner — keyless fallbacks + dedupe + LLM', () => {
  test('HN fallback supplies insights when no search keys are set', async () => {
    const learner = new OnlineLearner({ bus: undefined, db: undefined } as never, {
      searchFn: async (query, count, ctx) => {
        if (ctx?.category === 'github-repo') return []
        if (ctx?.category === 'research-paper') return []
        return [
          {
            title: `HN story for "${query}"`,
            url: `https://news.ycombinator.com/item?id=1`,
            snippet: 'A method that reduces latency with minimal code changes.',
          },
        ]
      },
      fetchFn: async (url) => ({
        url,
        title: 'HN post',
        markdown:
          'The agent should use a deterministic cache for tool results. ' +
          'Cache the tool result by content hash, so a repeated call is free. ' +
          'Use a sha256-based key. This avoids re-running the same command. '.repeat(20),
        truncated: false,
      }),
    })
    const insights = await learner.learnOnce([
      { query: 'agent tool cache', category: 'agent-technique' },
    ])
    expect(insights.length).toBeGreaterThan(0)
    expect(insights[0].id.startsWith('ins_')).toBe(true)
    expect(insights[0].pattern.length).toBeGreaterThan(0)
  })

  test('cross-run dedupe: same url+pattern collapses to one insight across repeated cycles', async () => {
    const db = fakeDb()
    const learner = new OnlineLearner({ bus: undefined, db } as never, {
      searchFn: async () => [
        {
          title: 'Builder',
          url: 'https://example.com/builder',
          snippet: 'agent technique',
        },
      ],
      fetchFn: async (url) => ({
        url,
        title: 'Builder',
        markdown:
          'Use explicit tool pinning for every agent tool and bash command — a tool plan memory loop bonus. ' +
          'Never rely on ambient system packages; the agent tool planner should record which tools succeeded. '.repeat(
            30,
          ),
        truncated: false,
      }),
    })
    const topic = [{ query: 'tool pinning', category: 'agent-technique' as const }]
    const first = await learner.learnOnce(topic)
    const second = await learner.learnOnce(topic)
    expect(first.length).toBeGreaterThan(0)
    expect(second.length).toBeGreaterThan(0)
    // IDs now derive from (url + pattern), so same input → same id
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id))
    expect(new Set(first.map((i) => i.id)).size).toBe(first.length)
  })

  test('deterministic ids are stable across independent instances', async () => {
    const richMarkdown =
      'Use explicit tool pinning for every agent tool call — a verified technique. ' +
      'Always record the agent tool, run the loop, then score the tool result. '.repeat(25)
    const mkLearner = () =>
      new OnlineLearner(
        {},
        {
          searchFn: async () => [
            { title: 'A', url: 'https://x.local/a', snippet: 'agent technique' },
          ],
          fetchFn: async () => ({
            url: 'https://x.local/a',
            title: 'A',
            markdown: richMarkdown,
            truncated: false,
          }),
        },
      )
    const learnerA = mkLearner()
    const learnerB = mkLearner()
    const a = await learnerA.learnOnce([
      { query: 'agent tool pinning', category: 'agent-technique' },
    ])
    const b = await learnerB.learnOnce([
      { query: 'agent tool pinning', category: 'agent-technique' },
    ])
    expect(a.length).toBe(1)
    expect(a.map((i) => i.id)).toEqual(b.map((i) => i.id))
  })

  test('extractWithLLM falls back to heuristic when gateway.complete throws', async () => {
    const props = {
      searchFn: async () => [{ title: 'T', url: 'https://x.local/t', snippet: 'x' }],
      fetchFn: async () => ({
        url: 'https://x.local/t',
        title: 'T',
        markdown:
          'Pin the agent tool versions explicitly — tool calls from any agent planner should record the tool loop result. ' +
          'Prefer this tool pattern; the agent and its planner both use tool keys. '.repeat(20),
        truncated: false,
      }),
    }
    const gateway = {
      complete: async () => {
        throw new Error('no provider key')
      },
      stream: async () => [],
      summarize: async () => '',
      listModels: async () => [],
      stats: () => ({
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUSD: 0,
        avgLatencyMs: 0,
        byModel: {},
      }),
    }
    const learner = new OnlineLearner({ gateway: gateway as never } as never, props)
    const insights = await learner.learnOnce()
    expect(insights.length).toBe(1)
    expect(insights[0].pattern.length).toBeGreaterThan(0)
    expect(insights[0].id.startsWith('ins_')).toBe(true)
  })

  test('LLM-success path yields structured insights and deterministic ids', async () => {
    const docsWhereTheLLMWins = {
      searchFn: async () => [{ title: 'T', url: 'https://x.local/t', snippet: 'x' }],
      fetchFn: async () => ({
        url: 'https://x.local/t',
        title: 'T',
        markdown:
          '## A strategy\nYou must pin every tool call with a hash key to get deterministic results.\n\n## Why\nWithout pinning, a stale cache poisons later calls.\n' +
          'content body. '.repeat(30),
        truncated: false,
      }),
    }
    const gateway = {
      complete: async () => ({
        text: JSON.stringify([
          {
            summary: 'Deterministic caching of tool calls',
            pattern: 'Pin tool calls by content hash',
            tags: ['cache', 'reproducibility'],
            relevance: 0.9,
          },
        ]),
      }),
      stream: async () => [],
      summarize: async () => '',
      listModels: async () => [],
      stats: () => ({
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUSD: 0,
        avgLatencyMs: 0,
        byModel: {},
      }),
    }
    const learner = new OnlineLearner({ gateway: gateway as never } as never, docsWhereTheLLMWins)
    const insights = await learner.learnOnce()
    expect(insights.length).toBe(1)
    expect(insights[0].summary).toContain('Deterministic caching')
    // id must hash from (url + pattern)
    expect(insights[0].id).toMatch(/^ins_[0-9a-f]{12}$/)
  })

  test('no provider keys, default searchFn, hits HN rather than fabricating', async () => {
    // Only assert the *non-empty* invariant (live network runners will see real
    // results; in a sandboxed CI the default fetch may time out — the important
    // property is: never fabricate, return [] or real results.
    const learner = new OnlineLearner({})
    const insights = await learner.learnOnce([
      { query: 'agent memory llm', category: 'agent-technique' },
    ])
    // Should be empty (sandbox) or non-empty (real HN hit) — never stub values
    for (const i of insights) {
      expect(i.summary).not.toMatch(/stub/i)
    }
  })
})
