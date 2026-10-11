import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mountCommunityRoutes } from './community.js'
import { resetRegistryCache } from '../community/registry.js'

// P3.4 community distribution routes — install/uninstall skills, agents and
// knowledge modules. Real fetch against a live Bun.serve socket; every install
// targets a temp cwd so the repo is never written to.

let server!: { stop: (closeActiveConnections?: boolean) => void; port: number | undefined }
let BASE!: string
let projectDir!: string
const stored: Array<Record<string, unknown>> = []

/** Minimal knowledge double — records StoreInput calls. */
const knowledge = {
  store: async (input: Record<string, unknown>) => {
    stored.push(input)
    return { id: `mem_${stored.length}` }
  },
}

beforeAll(async () => {
  resetRegistryCache()
  projectDir = mkdtempSync(join(tmpdir(), 'mira-community-test-'))
  const app = new Hono<{ Variables: { requestId: string } }>()
  mountCommunityRoutes(app, {
    knowledge: knowledge as never,
  })
  server = Bun.serve({ port: 0, fetch: app.fetch })
  BASE = `http://127.0.0.1:${server.port}`
})

afterAll(() => {
  try {
    server.stop(true)
  } catch {}
  try {
    rmSync(projectDir, { recursive: true, force: true })
  } catch {}
})

const cwdQ = () => `?cwd=${encodeURIComponent(projectDir)}`
const post = (path: string) => fetch(`${BASE}${path}`, { method: 'POST' })
const del = (path: string) => fetch(`${BASE}${path}`, { method: 'DELETE' })
const get = (path: string) => fetch(`${BASE}${path}`)

describe('GET /community/registry', () => {
  test('browses all kinds when kind is omitted', async () => {
    const res = await get('/community/registry')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { count: number; entries: Array<{ kind: string }> }
    expect(body.count).toBeGreaterThan(0)
    expect(new Set(body.entries.map((e) => e.kind)).size).toBeGreaterThan(1)
  })

  test('filters by kind', async () => {
    const res = await get('/community/registry?kind=agent')
    const body = (await res.json()) as { entries: Array<{ kind: string }> }
    expect(body.entries.length).toBeGreaterThan(0)
    expect(body.entries.every((e) => e.kind === 'agent')).toBe(true)
  })

  test('searches by query', async () => {
    const res = await get('/community/registry?kind=skill&q=tdd')
    const body = (await res.json()) as { entries: Array<{ name: string }> }
    expect(body.entries[0]?.name).toBe('tdd-workflow')
  })

  test('400s on unknown kind', async () => {
    expect((await get('/community/registry?kind=bogus')).status).toBe(400)
  })

  test('400s on out-of-range limit', async () => {
    expect((await get('/community/registry?limit=0')).status).toBe(400)
    expect((await get('/community/registry?limit=999')).status).toBe(400)
  })

  test('400s on an over-long query', async () => {
    expect((await get(`/community/registry?q=${'x'.repeat(101)}`)).status).toBe(400)
  })
})

describe('skill install lifecycle', () => {
  test('installs a packaged pack into the project skills dir', async () => {
    const res = await post(`/community/skills/tdd-workflow${cwdQ()}`)
    expect(res.status).toBe(201)
    const body = (await res.json()) as { installed: string; path: string }
    expect(body.installed).toBe('tdd-workflow')
    expect(body.path.startsWith(projectDir)).toBe(true)

    const content = await readFile(body.path, 'utf-8')
    expect(content.startsWith('---')).toBe(true)
    expect(content).toContain('name: tdd-workflow')
    expect(content).toContain('# TDD Workflow')
  })

  test('installed pack is listed and discoverable', async () => {
    const res = await get(`/community/skills${cwdQ()}`)
    const body = (await res.json()) as { installed: string[] }
    expect(body.installed).toContain('tdd-workflow')
  })

  test('reinstall overwrites idempotently', async () => {
    const res = await post(`/community/skills/tdd-workflow${cwdQ()}`)
    expect(res.status).toBe(201)
  })

  test('404 for a name not in the registry', async () => {
    expect((await post(`/community/skills/not-a-real-pack${cwdQ()}`)).status).toBe(404)
  })

  test('400 for an invalid name (traversal attempt)', async () => {
    const res = await post(`/community/skills/${encodeURIComponent('../evil')}${cwdQ()}`)
    expect(res.status).toBe(400)
  })

  test('400 for traversal in the cwd parameter', async () => {
    const res = await post('/community/skills/tdd-workflow?cwd=..%2F..%2Fetc')
    expect(res.status).toBe(400)
  })

  test('uninstall removes only the project-local file', async () => {
    const res = await del(`/community/skills/tdd-workflow${cwdQ()}`)
    expect(res.status).toBe(200)
    const list = (await (await get(`/community/skills${cwdQ()}`)).json()) as { installed: string[] }
    expect(list.installed).not.toContain('tdd-workflow')
    // the packaged copy is untouched — uninstall never deletes shipped packs
    const { SKILLS_DIR } = await import('../skills/loader.js')
    const packaged = await readFile(join(SKILLS_DIR, 'tdd-workflow', 'SKILL.md'), 'utf-8')
    expect(packaged.length).toBeGreaterThan(0)
  })
})

describe('knowledge module install', () => {
  test('seeds every entry of the module', async () => {
    stored.length = 0
    const res = await post('/community/knowledge/api-security-basics')
    expect(res.status).toBe(201)
    const body = (await res.json()) as { entries: number; ids: string[] }
    expect(body.entries).toBeGreaterThan(0)
    expect(body.ids.length).toBe(body.entries)
    expect(stored.length).toBe(body.entries)
    expect(stored[0].tier).toBeTruthy()
    expect(JSON.stringify(stored[0].metadata)).toContain('api-security-basics')
  })

  test('404 for an unknown module', async () => {
    expect((await post('/community/knowledge/nope')).status).toBe(404)
  })

  test('404 for a name that exists in another kind (skills are not modules)', async () => {
    expect((await post('/community/knowledge/tdd-workflow')).status).toBe(404)
  })
})

describe('agent install lifecycle', () => {
  test('installs a catalog agent into project mira.json', async () => {
    const res = await post(`/community/agents/api-designer${cwdQ()}`)
    expect(res.status).toBe(201)
    const raw = JSON.parse(await readFile(join(projectDir, 'mira.json'), 'utf-8')) as {
      agents: Record<string, { system: string; permissions: string }>
    }
    expect(raw.agents['api-designer']).toBeDefined()
    expect(raw.agents['api-designer'].permissions).toBe('readonly')
    expect(raw.agents['api-designer'].system.length).toBeGreaterThan(10)
  })

  test('installed agent is visible to the config read path the loader uses', async () => {
    // getAgentTemplates() merges getConfig().agents — same read path, so a
    // cwd-scoped getConfig proves the write is live-loadable.
    const { getConfig } = await import('../config/index.js')
    const def = getConfig(projectDir).agents?.['api-designer']
    expect(def).toBeDefined()
    expect(def!.permissions).toBe('readonly')
    // name satisfies the templates.ts key rule so materialize() accepts it
    expect(/^[a-z][a-z0-9_-]{1,40}$/.test('api-designer')).toBe(true)
  })

  test('404 for an agent not in the catalog', async () => {
    expect((await post(`/community/agents/no-such-agent${cwdQ()}`)).status).toBe(404)
  })

  test('400 for an invalid agent name', async () => {
    expect(
      (await post(`/community/agents/${encodeURIComponent('Bad Name')}${cwdQ()}`)).status,
    ).toBe(400)
  })

  test('uninstall removes the agent, 404 when already gone', async () => {
    expect((await del(`/community/agents/api-designer${cwdQ()}`)).status).toBe(200)
    expect((await del(`/community/agents/api-designer${cwdQ()}`)).status).toBe(404)
    const raw = JSON.parse(await readFile(join(projectDir, 'mira.json'), 'utf-8')) as {
      agents: Record<string, unknown>
    }
    expect(raw.agents['api-designer']).toBeUndefined()
  })

  test('skill name installed as agent → 404 (kind mismatch)', async () => {
    expect((await post(`/community/agents/tdd-workflow${cwdQ()}`)).status).toBe(404)
  })
})
