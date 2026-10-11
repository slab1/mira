import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { mkdtempSync, rmSync } from 'node:fs'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mountCommunityRoutes } from './community.js'
import { resetRegistryCache } from '../community/registry.js'
import { planVertical } from '../community/verticals.js'
import { getRegistryEntry, loadRegistry } from '../community/registry.js'
import { getConfig, resetConfigCache } from '../config/index.js'

// P3.6 verticals — a domain agent as one atomic bundle (agent + skills +
// knowledge), composed from the P3.4 community catalogs.

let server!: { stop: (closeActiveConnections?: boolean) => void; port: number | undefined }
let BASE!: string
let projectDir!: string
const stored: Array<Record<string, unknown>> = []

const knowledge = {
  store: async (input: Record<string, unknown>) => {
    stored.push(input)
    return { id: `mem_${stored.length}` }
  },
}

beforeAll(async () => {
  resetRegistryCache()
  projectDir = mkdtempSync(join(tmpdir(), 'mira-vertical-'))
  const app = new Hono<{ Variables: { requestId: string } }>()
  mountCommunityRoutes(app, { knowledge: knowledge as never })
  server = Bun.serve({ port: 0, fetch: app.fetch })
  BASE = `http://127.0.0.1:${server.port}`
})

afterAll(() => {
  try {
    server.stop(true)
  } catch {}
  resetConfigCache()
  try {
    rmSync(projectDir, { recursive: true, force: true })
  } catch {}
})

beforeEach(() => {
  stored.length = 0
})

/** Lazy: projectDir only exists after beforeAll — a module-load-time template
 *  encoded the literal string 'undefined' as the cwd. */
const cwdQ = () => `?cwd=${encodeURIComponent(projectDir)}`
const post = (path: string) => fetch(`${BASE}${path}`, { method: 'POST' })
const del = (path: string) => fetch(`${BASE}${path}`, { method: 'DELETE' })
const skillFile = (name: string) => join(projectDir, '.mira', 'skills', `${name}.md`)

describe('vertical catalog + planning', () => {
  test('catalog ships verticals', () => {
    const verticals = loadRegistry('vertical')
    expect(verticals.length).toBeGreaterThan(0)
    for (const v of verticals) expect(v.source.kind).toBe('vertical')
  })

  test('every shipped vertical resolves with no missing components', () => {
    for (const entry of loadRegistry('vertical')) {
      const plan = planVertical(entry)
      expect(plan).toBeTruthy()
      expect(plan!.missing).toEqual([])
      expect(!!(plan!.agent || plan!.skills.length > 0)).toBe(true)
    }
  })

  test('luxora carries its own inline persona', () => {
    const plan = planVertical(getRegistryEntry('vertical', 'luxora')!)
    expect(plan!.agent?.name).toBe('luxora')
    expect(plan!.agent!.definition.system.length).toBeGreaterThan(50)
    expect(plan!.agent!.definition.permissions).toBe('readonly')
  })

  test('dev-workflow references a catalog agent by name', () => {
    const plan = planVertical(getRegistryEntry('vertical', 'dev-workflow')!)
    expect(plan!.agent?.name).toBe('test-writer')
    expect(plan!.skills.map((s) => s.name).sort()).toEqual([
      'tdd-workflow',
      'verification-planning',
    ])
  })

  test('planVertical refuses a non-vertical entry', () => {
    expect(planVertical(getRegistryEntry('skill', 'tdd-workflow')!)).toBeNull()
  })
})

describe('vertical install', () => {
  test('installs agent + skills + knowledge in one call', async () => {
    const res = await post(`/community/verticals/security-audit${cwdQ()}`)
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      installed: string
      components: { skills: string[]; knowledge: string[] }
      guidance?: string
      failed?: string[]
    }
    expect(body.installed).toBe('security-audit')
    expect(body.components.skills.sort()).toEqual(['security-audit', 'security-threat-model'])
    expect(body.components.knowledge[0]).toContain('api-security-basics')
    expect(body.failed).toBeUndefined()
    // both skill files written with real content
    for (const s of ['security-audit', 'security-threat-model']) {
      expect(existsSync(skillFile(s))).toBe(true)
      expect(readFileSync(skillFile(s), 'utf-8')).toContain('---')
    }
    // knowledge seeded
    expect(stored.length).toBeGreaterThan(0)
  })

  test('inline-persona vertical writes to mira.json agents', async () => {
    const res = await post(`/community/verticals/luxora${cwdQ()}`)
    expect(res.status).toBe(201)
    const cfg = getConfig(projectDir)
    expect(cfg.agents?.['luxora']).toBeDefined()
    expect(cfg.agents!['luxora'].system).toContain('fashion')
    // readonly posture — a design assistant must not silently gain write access
    expect(cfg.agents!['luxora'].permissions).toBe('readonly')
  })

  test('guidance is returned so the agent knows how to use the bundle', async () => {
    const res = await post(`/community/verticals/luxora${cwdQ()}`)
    const body = (await res.json()) as { guidance?: string }
    expect(body.guidance).toContain('luxora')
  })

  test('re-install is idempotent', async () => {
    const first = await post(`/community/verticals/luxora${cwdQ()}`)
    const second = await post(`/community/verticals/luxora${cwdQ()}`)
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(getConfig(projectDir).agents?.['luxora']).toBeDefined()
  })

  test('404 for a vertical not in the catalog', async () => {
    expect((await post(`/community/verticals/not-real${cwdQ()}`)).status).toBe(404)
  })

  test('400 for an invalid vertical name', async () => {
    expect(
      (await post(`/community/verticals/${encodeURIComponent('Bad Name')}${cwdQ()}`)).status,
    ).toBe(400)
  })

  test('a missing component reference fails BEFORE anything is written', async () => {
    // Inject a vertical that references a nonexistent skill
    const { loadRegistry, resetRegistryCache } = await import('../community/registry.js')
    resetRegistryCache()
    const cat = loadRegistry('vertical')
    cat.push({
      name: 'broken-vertical',
      description: 'references a missing skill',
      category: 'test',
      source: {
        kind: 'vertical',
        vertical: { skills: ['does-not-exist-skill'] },
      },
    } as never)
    const res = await post(`/community/verticals/broken-vertical${cwdQ()}`)
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('does-not-exist-skill')
    // nothing written for that bundle
    expect(existsSync(skillFile('does-not-exist-skill'))).toBe(false)
    cat.pop()
  })

  test('registry search surfaces verticals alongside other kinds', async () => {
    const res = await fetch(`${BASE}/community/registry?q=luxora`)
    const body = (await res.json()) as { entries: Array<{ kind: string; name: string }> }
    expect(body.entries.some((e) => e.kind === 'vertical' && e.name === 'luxora')).toBe(true)
  })
})

describe('vertical uninstall', () => {
  test('removes the agent and skills, keeps seeded knowledge', async () => {
    await post(`/community/verticals/security-audit${cwdQ()}`)
    const res = await del(`/community/verticals/security-audit${cwdQ()}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      components: string[]
      knowledgeKept: string[]
    }
    expect(body.components.some((c) => c.startsWith('skill:'))).toBe(true)
    expect(body.knowledgeKept).toContain('api-security-basics')
    for (const s of ['security-audit', 'security-threat-model'])
      expect(existsSync(skillFile(s))).toBe(false)
  })

  test('removes the inline agent from mira.json', async () => {
    await post(`/community/verticals/luxora${cwdQ()}`)
    expect(getConfig(projectDir).agents?.['luxora']).toBeDefined()
    await del(`/community/verticals/luxora${cwdQ()}`)
    expect(getConfig(projectDir).agents?.['luxora']).toBeUndefined()
  })

  test('404 for an unknown vertical', async () => {
    expect((await del(`/community/verticals/not-real${cwdQ()}`)).status).toBe(404)
  })
})
