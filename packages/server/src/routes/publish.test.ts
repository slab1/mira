import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mountCommunityRoutes } from './community.js'
import { getRegistryEntry, resetRegistryCache } from '../community/registry.js'
import { getConfig, resetConfigCache } from '../config/index.js'

// P3.7 publish — the write side of the community catalog. Every case here is a
// claim about the publish/install contract:
//
//   publish(validated) → install succeeds, no restart
//   publish(curated name) → 409 (curated entries are immutable)
//   publish(bad artifact) → 400 (refused before it can 409 on install)
//   unpublish → catalog entry only; installed artifacts survive

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
  projectDir = mkdtempSync(join(tmpdir(), 'mira-publish-'))
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

const cwdQ = () => `?cwd=${encodeURIComponent(projectDir)}`
/** Search term + cwd. Joins with `&` — appending cwdQ() directly would emit a
 *  second `?` and fold the whole tail into `q`. */
const searchQ = (q: string) => `?q=${encodeURIComponent(q)}&cwd=${encodeURIComponent(projectDir)}`
const publish = (body: unknown) =>
  fetch(`${BASE}/community/publish${cwdQ()}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const post = (path: string) => fetch(`${BASE}${path}`, { method: 'POST' })
const del = (path: string) => fetch(`${BASE}${path}`, { method: 'DELETE' })

const validSkill = {
  kind: 'skill',
  name: 'local-review',
  description: 'A locally published review skill.',
  category: 'quality',
  content: '# Local Review\n\nCheck the diff before you claim it works.\n',
}

describe('publish validation', () => {
  test('rejects an invalid slug (traversal, uppercase, too short)', async () => {
    for (const name of ['../evil', 'Bad-Name', 'a']) {
      const res = await publish({ ...validSkill, name })
      expect(res.status).toBe(400)
    }
  })

  test('rejects an unknown kind', async () => {
    expect((await publish({ ...validSkill, kind: 'plugin' })).status).toBe(400)
  })

  test('rejects a non-JSON / non-object body', async () => {
    const notJson = await fetch(`${BASE}/community/publish${cwdQ()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    })
    expect(notJson.status).toBe(400)
    const arr = await publish([validSkill])
    expect(arr.status).toBe(400)
  })

  test('rejects a skill with no content', async () => {
    expect((await publish({ ...validSkill, content: '   ' })).status).toBe(400)
  })

  test('rejects an agent whose system prompt is unusable', async () => {
    const res = await publish({
      kind: 'agent',
      name: 'thin-agent',
      description: 'too thin to be a persona',
      definition: { system: 'hi' },
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('system')
  })

  test('rejects knowledge entries outside the store caps', async () => {
    const bad = await publish({
      kind: 'knowledge',
      name: 'too-big',
      description: 'content exceeds the store cap',
      entries: [{ tier: 'semantic', title: 't', content: 'x'.repeat(4001) }],
    })
    expect(bad.status).toBe(400)
    const badTier = await publish({
      kind: 'knowledge',
      name: 'bad-tier',
      description: 'unknown tier',
      entries: [{ tier: 'working', title: 't', content: 'x' }],
    })
    expect(badTier.status).toBe(400)
    const empty = await publish({
      kind: 'knowledge',
      name: 'empty-mod',
      description: 'no entries',
      entries: [],
    })
    expect(empty.status).toBe(400)
  })

  test('refuses to shadow a curated entry', async () => {
    const res = await publish({ ...validSkill, name: 'tdd-workflow' })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toContain('curated')
  })

  test('refuses to shadow a component a curated vertical depends on', async () => {
    // tdd-workflow is curated AND referenced by the curated dev-workflow
    // vertical; republishing it would silently change what that bundle installs.
    const res = await publish({
      kind: 'knowledge',
      name: 'api-security-basics',
      description: 'redefining a curated module',
      entries: [{ tier: 'semantic', title: 't', content: 'x' }],
    })
    expect(res.status).toBe(409)
  })

  test('rejects a vertical referencing a component that does not exist', async () => {
    const res = await publish({
      kind: 'vertical',
      name: 'broken-bundle',
      description: 'references a typo',
      vertical: { skills: ['no-such-skill-anywhere'] },
    })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toContain('no-such-skill-anywhere')
  })
})

describe('publish → install', () => {
  test('a published skill is installable with no restart', async () => {
    const res = await publish(validSkill)
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      published: string
      replacing: boolean
      installPath: string
    }
    expect(body.published).toBe('local-review')
    expect(body.replacing).toBe(false)
    expect(body.installPath).toBe('/community/skills/local-review')

    const install = await post(`/community/skills/local-review${cwdQ()}`)
    expect(install.status).toBe(201)
    const file = join(projectDir, '.mira', 'skills', 'local-review.md')
    expect(existsSync(file)).toBe(true)
    // real content written, not a stub
    expect(readFileSync(file, 'utf-8')).toContain('Check the diff')
  })

  test('a published agent installs into mira.json', async () => {
    const res = await publish({
      kind: 'agent',
      name: 'local-reviewer',
      description: 'Reviews changes in this project.',
      definition: {
        system: 'You review changes in this project. Read the diff before commenting.',
        permissions: 'readonly',
        tools: ['read', 'grep'],
      },
    })
    expect(res.status).toBe(201)
    const install = await post(`/community/agents/local-reviewer${cwdQ()}`)
    expect(install.status).toBe(201)
    expect(getConfig(projectDir).agents?.['local-reviewer'].permissions).toBe('readonly')
  })

  test('a published knowledge module seeds the store', async () => {
    await publish({
      kind: 'knowledge',
      name: 'local-conventions',
      description: 'House conventions for this repo.',
      entries: [
        { tier: 'procedural', title: 'Commit style', content: 'Conventional commits.' },
        { tier: 'semantic', title: 'Branch naming', content: 'feature/<slug>.' },
      ],
    })
    const install = await post(`/community/knowledge/local-conventions${cwdQ()}`)
    expect(install.status).toBe(201)
    expect(stored.length).toBe(2)
    expect(stored[0].metadata).toMatchObject({ module: 'local-conventions', installed: true })
  })

  test('a published vertical installs its whole bundle atomically', async () => {
    await publish({
      kind: 'skill',
      name: 'bundle-skill',
      description: 'Skill shipped inside a locally published bundle.',
      content: '# Bundle Skill\n\nContent.\n',
    })
    const res = await publish({
      kind: 'vertical',
      name: 'local-bundle',
      description: 'A bundle assembled from local artifacts.',
      vertical: {
        guidance: 'Run with agent=local-bundle.',
        skills: ['bundle-skill'],
        knowledge: ['local-conventions'],
      },
    })
    expect(res.status).toBe(201)
    const install = await post(`/community/verticals/local-bundle${cwdQ()}`)
    expect(install.status).toBe(201)
    const body = (await install.json()) as {
      components: { skills: string[]; knowledge: string[] }
      failed?: string[]
    }
    expect(body.components.skills).toEqual(['bundle-skill'])
    expect(body.components.knowledge[0]).toContain('local-conventions')
    expect(body.failed).toBeUndefined()
    expect(existsSync(join(projectDir, '.mira', 'skills', 'bundle-skill.md'))).toBe(true)
  })

  test('a published vertical may reference a locally published agent', async () => {
    await publish({
      kind: 'agent',
      name: 'local-planner',
      description: 'Plans work in this project.',
      definition: { system: 'You plan work here. Break the task down before acting.' },
    })
    const res = await publish({
      kind: 'vertical',
      name: 'local-planned',
      description: 'Bundle that reuses a locally published persona.',
      vertical: { agent: { agent: 'local-planner' }, skills: ['bundle-skill'] },
    })
    expect(res.status).toBe(201)
    const install = await post(`/community/verticals/local-planned${cwdQ()}`)
    expect(install.status).toBe(201)
    expect(getConfig(projectDir).agents?.['local-planner']).toBeDefined()
  })

  test('republishing the same name replaces it (200) without a duplicate', async () => {
    const name = 'replaceable-skill'
    const first = await publish({ ...validSkill, name })
    expect(first.status).toBe(201)
    const second = await publish({ ...validSkill, name, description: 'Updated description.' })
    expect(second.status).toBe(200)
    expect(((await second.json()) as { replacing: boolean }).replacing).toBe(true)

    const list = (await (await fetch(`${BASE}/community/published${cwdQ()}`)).json()) as {
      entries: Array<{ name: string; description: string }>
    }
    const matches = list.entries.filter((e) => e.name === name)
    expect(matches.length).toBe(1)
    expect(matches[0].description).toBe('Updated description.')
  })

  test('published entries appear in registry search but only for that cwd', async () => {
    const res = await fetch(`${BASE}/community/registry${searchQ('local-bundle')}`)
    const body = (await res.json()) as { entries: Array<{ name: string; kind: string }> }
    expect(body.entries.some((e) => e.name === 'local-bundle' && e.kind === 'vertical')).toBe(true)

    // a different project cannot see it
    const other = await fetch(`${BASE}/community/registry?q=local-bundle`)
    const otherBody = (await other.json()) as { entries: Array<{ name: string }> }
    expect(otherBody.entries.some((e) => e.name === 'local-bundle')).toBe(false)
  })

  test('a published name never shadows the curated catalog entry', async () => {
    // 'security-audit' is both a curated skill and a curated vertical.
    const res = await publish({
      kind: 'skill',
      name: 'shadow-probe',
      description: 'A skill that tries to shadow.',
      content: '# probe\n',
    })
    expect(res.status).toBe(201)
    // Curated security-audit still resolves to the shipped entry, not a local one
    const curated = getRegistryEntry('skill', 'security-audit', projectDir)
    expect(curated?.source.kind).toBe('packaged')
  })

  test('a corrupt published catalog reads as empty rather than breaking search', async () => {
    const file = join(projectDir, '.mira', 'community', 'skill.json')
    await Bun.write(file, '{ not json')
    const res = await fetch(`${BASE}/community/registry${searchQ('tdd')}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { entries: Array<{ name: string }> }
    expect(body.entries.some((e) => e.name === 'tdd-workflow')).toBe(true)
    await Bun.write(file, '[]\n')
  })
})

describe('unpublish', () => {
  test('removes the catalog entry but keeps installed artifacts', async () => {
    await publish(validSkill)
    await post(`/community/skills/local-review${cwdQ()}`)
    const file = join(projectDir, '.mira', 'skills', 'local-review.md')
    expect(existsSync(file)).toBe(true)

    const res = await del(`/community/published/skill/local-review${cwdQ()}`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { installedArtifactsKept: boolean }).installedArtifactsKept).toBe(
      true,
    )
    // gone from the catalog…
    expect(getRegistryEntry('skill', 'local-review', projectDir)).toBeNull()
    // …but the installed pack is untouched (uninstall owns that)
    expect(existsSync(file)).toBe(true)
  })

  test('refuses to unpublish a curated entry (409)', async () => {
    const res = await del(`/community/published/skill/tdd-workflow${cwdQ()}`)
    expect(res.status).toBe(409)
    expect(getRegistryEntry('skill', 'tdd-workflow')).toBeTruthy()
  })

  test('404 for something never published', async () => {
    expect((await del(`/community/published/skill/never-published${cwdQ()}`)).status).toBe(404)
  })

  test('400 for an invalid kind', async () => {
    expect((await del(`/community/published/plugin/whatever${cwdQ()}`)).status).toBe(400)
  })
})

describe('publish path guardrails', () => {
  test('a relative cwd is rejected', async () => {
    const res = await fetch(`${BASE}/community/publish?cwd=relative/path`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validSkill),
    })
    expect(res.status).toBe(400)
  })

  test('nothing is written when the cwd is rejected', async () => {
    await fetch(`${BASE}/community/publish?cwd=../escape`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validSkill, name: 'escape-probe' }),
    })
    expect(existsSync(join(projectDir, '.mira', 'community', 'escape-probe.json'))).toBe(false)
  })
})
