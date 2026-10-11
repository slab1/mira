import { describe, test, expect, beforeEach } from 'bun:test'
import {
  getRegistryEntry,
  isValidArtifactName,
  loadRegistry,
  resetRegistryCache,
  searchRegistry,
} from './registry.js'

// P3.4 community registry — catalog loading, search scoring, entry lookup.
// Pure unit tests, no server/db. The catalog files are committed next to this
// module, so these run against the real shipped catalog.

beforeEach(() => {
  resetRegistryCache()
})

describe('community catalog loading', () => {
  test('skill catalog loads committed entries', () => {
    const skills = loadRegistry('skill')
    expect(skills.length).toBeGreaterThan(0)
    const tdd = skills.find((s) => s.name === 'tdd-workflow')
    expect(tdd).toBeDefined()
    expect(tdd!.description.length).toBeGreaterThan(10)
    expect(tdd!.source.kind).toBe('packaged')
  })

  test('every catalog entry has a name, description, category and source', () => {
    for (const kind of ['skill', 'agent', 'knowledge'] as const) {
      for (const e of loadRegistry(kind)) {
        expect(typeof e.name).toBe('string')
        expect(e.name.length).toBeGreaterThan(0)
        expect(e.description.length).toBeGreaterThan(0)
        expect(e.category.length).toBeGreaterThan(0)
        expect(e.source).toBeTruthy()
      }
    }
  })

  test('no duplicate names within a kind', () => {
    for (const kind of ['skill', 'agent', 'knowledge'] as const) {
      const names = loadRegistry(kind).map((e) => e.name)
      expect(new Set(names).size).toBe(names.length)
    }
  })

  test('agent entries carry installable definitions', () => {
    const agents = loadRegistry('agent')
    expect(agents.length).toBeGreaterThan(0)
    for (const a of agents) {
      expect(a.source.kind).toBe('agent-def')
      if (a.source.kind !== 'agent-def') continue
      // agent names must satisfy the templates.ts key rule
      expect(/^[a-z][a-z0-9_-]{1,40}$/.test(a.name)).toBe(true)
      // system prompts must be substantive (templates.ts rejects < 10 chars)
      expect(a.source.definition.system.trim().length).toBeGreaterThan(10)
    }
  })

  test('knowledge modules carry seedable entries within store caps', () => {
    const modules = loadRegistry('knowledge')
    expect(modules.length).toBeGreaterThan(0)
    for (const m of modules) {
      expect(m.source.kind).toBe('knowledge')
      if (m.source.kind !== 'knowledge') continue
      expect(m.source.entries.length).toBeGreaterThan(0)
      for (const e of m.source.entries) {
        expect(['episodic', 'semantic', 'procedural']).toContain(e.tier)
        expect(e.title.length).toBeLessThanOrEqual(200)
        expect(e.content.length).toBeLessThanOrEqual(4000)
        expect((e.tags ?? []).length).toBeLessThanOrEqual(8)
      }
    }
  })

  test('unknown kind returns empty catalog rather than throwing', () => {
    expect(loadRegistry('nope' as never)).toEqual([])
  })
})

describe('community search', () => {
  test('empty query browses the catalog by stars', () => {
    const results = searchRegistry('skill', '', 5)
    expect(results.length).toBeGreaterThan(0)
    expect(results.length).toBeLessThanOrEqual(5)
    // sorted by stars descending
    const stars = results.map((r) => r.stars ?? 0)
    expect([...stars].sort((a, b) => b - a)).toEqual(stars)
  })

  test('query matches by name', () => {
    const results = searchRegistry('skill', 'tdd', 5)
    expect(results[0]?.name).toBe('tdd-workflow')
    expect(results[0]?.kind).toBe('skill')
  })

  test('query matches by category', () => {
    const results = searchRegistry('skill', 'security', 10)
    expect(results.length).toBeGreaterThan(0)
  })

  test('limit is respected', () => {
    expect(searchRegistry('skill', '', 2).length).toBeLessThanOrEqual(2)
  })

  test('no match returns empty', () => {
    expect(searchRegistry('skill', 'zzz-nonexistent-xyzzy', 5)).toEqual([])
  })
})

describe('community entry lookup', () => {
  test('exact name lookup is case-insensitive', () => {
    expect(getRegistryEntry('skill', 'TDD-Workflow')?.name).toBe('tdd-workflow')
  })

  test('unknown name returns null', () => {
    expect(getRegistryEntry('skill', 'not-a-pack')).toBeNull()
  })
})

describe('install target name validation', () => {
  test('accepts lowercase slugs', () => {
    expect(isValidArtifactName('tdd-workflow')).toBe(true)
    expect(isValidArtifactName('my_pack')).toBe(true)
    expect(isValidArtifactName('a1')).toBe(true)
  })

  test('rejects path traversal, uppercase, spaces and leading digits', () => {
    expect(isValidArtifactName('../evil')).toBe(false)
    expect(isValidArtifactName('TDD')).toBe(false)
    expect(isValidArtifactName('has space')).toBe(false)
    expect(isValidArtifactName('1start')).toBe(false)
    expect(isValidArtifactName('a')).toBe(false)
    expect(isValidArtifactName('')).toBe(false)
    expect(isValidArtifactName('a/b')).toBe(false)
  })
})
