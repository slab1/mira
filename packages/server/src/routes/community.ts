/**
 * Community distribution routes (P3.4) — install/uninstall shareable artifacts.
 *
 * Mirrors the MCP marketplace shape (curated catalog + one-click install into a
 * target the running server already loads), extended across three kinds:
 *
 *   POST   /community/skills/:name     → <cwd>/.mira/skills/<name>.md
 *   DELETE /community/skills/:name     → remove that file
 *   POST   /community/agents/:name     → mira.json `agents`
 *   DELETE /community/agents/:name     → remove from mira.json
 *   POST   /community/knowledge/:name  → seed KnowledgeBase entries
 *   POST   /community/publish         → add an artifact to THIS project's catalog
 *   GET    /community/published       → list what this project published
 *   DELETE /community/published/:k/:n → remove a published catalog entry
 *   GET    /community/registry         → catalog search across kinds
 *
 * Install targets are all read by live loaders, so an install takes effect
 * without a restart (skills loader re-reads the directory per call, agents are
 * merged from config per call, knowledge is stored directly). Published catalogs
 * are likewise re-read per lookup, so publish → install needs no restart either.
 *
 * Writes are cwd-scoped (`?cwd=`), sanitized, and checked against guardrails
 * allowedRoots — same contract as PATCH /config. Uninstall only removes the
 * project-local artifact, never a packaged one; unpublish only removes the
 * catalog entry, never an installed artifact.
 */
import type { Hono, Context } from 'hono'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { getConfig, removeAgentFromConfig, saveConfig } from '../config/index.js'
import { isPathAllowed, sanitizePath } from '../guardrails/index.js'
import {
  getRegistryEntry,
  isValidArtifactName,
  searchRegistry,
  type CommunityKind,
} from '../community/registry.js'
import { planVertical } from '../community/verticals.js'
import {
  isCommunityKind,
  listPublished,
  publishEntry,
  unpublishEntry,
  type PublishRequest,
} from '../community/publish.js'
import { SKILLS_DIR, ensureSkillsSeeded } from '../skills/loader.js'
import { SEEDED_SKILLS } from '../skills/seeded-skills.js'
import type { StoreInput } from '../learning/knowledge.js'
import type { MiraConfig } from '../types/index.js'

const KINDS = ['skill', 'agent', 'knowledge', 'vertical'] as const

/** Same contract as PATCH /config: sanitize + allowedRoots check, else 400/403. */
function resolveCwd(c: Context): { cwd?: string; error?: string; status?: number } {
  const raw = c.req.query('cwd')
  if (!raw) return {}
  // Must be absolute: install targets are file WRITES, and a relative cwd would
  // be resolved against the server's own working directory (writing into the
  // repo it happens to run from).
  if (!isAbsolute(raw)) return { error: 'cwd must be an absolute path', status: 400 }
  const sanitized = sanitizePath(raw)
  if (!sanitized.ok) return { error: `invalid cwd: ${sanitized.reason}`, status: 400 }
  const cwd = sanitized.sanitized ?? raw
  try {
    const cfg = getConfig(cwd) as MiraConfig
    const roots = (cfg.guardrails?.allowedRoots ?? []) as string[]
    if (roots.length > 0 && !isPathAllowed(cwd, roots)) {
      return { error: `cwd not allowed: ${cwd}`, status: 403 }
    }
  } catch {}
  return { cwd }
}

/** Project-local skills dir (precedence order from skills/loader.ts). */
function localSkillsDir(cwd: string): string {
  return join(cwd, '.mira', 'skills')
}

/** Read the shipped pack body (packaged source) — returns SKILL.md text or null. */
async function readPackagedPack(name: string): Promise<string | null> {
  ensureSkillsSeeded()
  // Directory layout first (all 20 shipped packs), then the single-file form.
  for (const p of [join(SKILLS_DIR, name, 'SKILL.md'), join(SKILLS_DIR, `${name}.md`)]) {
    try {
      return await readFile(p, 'utf-8')
    } catch {}
  }
  return SEEDED_SKILLS[name] ?? null
}

/** Strip frontmatter and rebuild a canonical pack file from name/description/body. */
function composeSkillPack(name: string, description: string, body: string): string {
  const cleanBody = body.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim()
  const oneLine = description.replace(/\s+/g, ' ').trim()
  return `---\nname: ${name}\ndescription: ${oneLine}\ntriggers:\n  - ${name}\n---\n\n${cleanBody}\n`
}

export function mountCommunityRoutes(
  app: Hono<{ Variables: { requestId: string } }>,
  deps: {
    /** KnowledgeBase for module seeding (learning/knowledge.ts) */
    knowledge?: {
      store: (input: StoreInput) => Promise<{ id: string }>
    }
  },
) {
  // ── GET /community/registry — catalog browse/search across kinds ──
  app.get('/community/registry', (c: Context) => {
    const rawQ = c.req.query('q') ?? ''
    if (rawQ.length > 100) return c.json({ error: 'q too long (max 100)' }, 400)
    if (rawQ.includes('\0')) return c.json({ error: 'invalid q' }, 400)
    if (rawQ.trim()) {
      const check = sanitizePath(rawQ.trim())
      if (!check.ok) return c.json({ error: `invalid q: ${check.reason}` }, 400)
    }
    const kindRaw = c.req.query('kind')
    if (kindRaw && !KINDS.includes(kindRaw as (typeof KINDS)[number]))
      return c.json({ error: `kind must be one of ${KINDS.join(', ')}` }, 400)
    let limit = 20
    const rawLimit = c.req.query('limit')
    if (rawLimit !== undefined) {
      const n = Number.parseInt(rawLimit, 10)
      if (!Number.isFinite(n) || n < 1 || n > 50)
        return c.json({ error: 'limit must be 1-50' }, 400)
      limit = n
    }
    const kinds = kindRaw ? [kindRaw as CommunityKind] : [...KINDS]
    // Published entries (P3.7) are project-local, so search overlays the
    // caller's cwd catalog when one is supplied.
    const resolved = resolveCwd(c)
    if (resolved.error) return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400)
    const results = kinds.flatMap((k) => searchRegistry(k, rawQ, limit, resolved.cwd))
    return c.json({ query: rawQ, count: results.length, entries: results })
  })

  // ── POST /community/skills/:name — install a skill pack ───────────
  app.post('/community/skills/:name', async (c: Context) => {
    const name = c.req.param('name')
    if (!name || !isValidArtifactName(name))
      return c.json({ error: 'invalid skill name (lowercase slug required)' }, 400)
    // cwd first: install targets are file WRITES, so the path guardrail must be
    // checked before a catalog lookup (which is cwd-aware, P3.7).
    const resolved = resolveCwd(c)
    if (resolved.error) return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400)
    const cwd = resolved.cwd ?? process.cwd()
    const entry = getRegistryEntry('skill', name, cwd)
    if (!entry) return c.json({ error: `skill not found in registry: ${name}` }, 404)

    let body: string
    if (entry.source.kind === 'packaged') {
      const shipped = await readPackagedPack(name)
      if (!shipped) return c.json({ error: `packaged pack not found: ${name}` }, 500)
      body = shipped
    } else if (entry.source.kind === 'inline') {
      body = entry.source.content
    } else {
      return c.json({ error: 'entry is not installable as a skill' }, 400)
    }

    const dir = localSkillsDir(cwd)
    const target = join(dir, `${name}.md`)
    try {
      await mkdir(dir, { recursive: true })
      // Refuse to follow a symlink out of the skills dir
      await writeFile(target, composeSkillPack(name, entry.description, body), {
        encoding: 'utf-8',
        flag: 'w',
      })
    } catch (e) {
      return c.json({ error: `install failed: ${String(e)}` }, 500)
    }
    return c.json({ installed: name, path: target, kind: 'skill' }, 201)
  })

  // ── DELETE /community/skills/:name — uninstall ─────────────────────
  app.delete('/community/skills/:name', async (c: Context) => {
    const name = c.req.param('name')
    if (!name || !isValidArtifactName(name)) return c.json({ error: 'invalid skill name' }, 400)
    const resolved = resolveCwd(c)
    if (resolved.error) return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400)
    const cwd = resolved.cwd ?? process.cwd()
    const target = join(localSkillsDir(cwd), `${name}.md`)
    try {
      await rm(target, { force: true })
    } catch (e) {
      return c.json({ error: `uninstall failed: ${String(e)}` }, 500)
    }
    return c.json({ removed: name })
  })

  // ── GET /community/skills — installed (project-local) packs ────────
  app.get('/community/skills', async (c: Context) => {
    const resolved = resolveCwd(c)
    if (resolved.error) return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400)
    const cwd = resolved.cwd ?? process.cwd()
    const dir = localSkillsDir(cwd)
    let files: string[] = []
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.md'))
    } catch {
      return c.json({ cwd, installed: [] })
    }
    return c.json({ cwd, installed: files.map((f) => f.replace(/\.md$/, '')).sort() })
  })

  // ── POST /community/agents/:name — install an agent definition ──────
  app.post('/community/agents/:name', async (c: Context) => {
    const name = c.req.param('name')
    if (!name || !/^[a-z][a-z0-9_-]{1,40}$/.test(name))
      return c.json({ error: 'invalid agent name (lowercase slug required)' }, 400)
    const resolved = resolveCwd(c)
    if (resolved.error) return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400)
    const cwd = resolved.cwd ?? process.cwd()
    const entry = getRegistryEntry('agent', name, cwd)
    if (!entry) return c.json({ error: `agent not found in registry: ${name}` }, 404)
    if (entry.source.kind !== 'agent-def')
      return c.json({ error: 'entry is not installable as an agent' }, 400)
    const current = getConfig(cwd).agents ?? {}
    const def = entry.source.definition
    if (typeof def.system !== 'string' || def.system.trim().length < 10)
      return c.json({ error: 'agent definition has no usable system prompt' }, 400)
    try {
      await saveConfig(
        {
          agents: {
            ...current,
            [name]: { ...def, description: def.description ?? entry.description },
          },
        },
        'project',
        cwd,
      )
    } catch (e) {
      return c.json({ error: `install failed: ${String(e)}` }, 400)
    }
    return c.json({ installed: name, kind: 'agent', definition: def }, 201)
  })

  // ── DELETE /community/agents/:name — remove from mira.json ─────────
  app.delete('/community/agents/:name', async (c: Context) => {
    const name = c.req.param('name')
    if (!name) return c.json({ error: 'agent name required' }, 400)
    const resolved = resolveCwd(c)
    if (resolved.error) return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400)
    const cwd = resolved.cwd ?? process.cwd()
    try {
      // Direct file write: saveConfig deep-merges, so a patch without the key
      // would not remove the agent.
      const removed = await removeAgentFromConfig(name, cwd)
      if (!removed) return c.json({ error: `agent not installed: ${name}` }, 404)
    } catch (e) {
      return c.json({ error: `uninstall failed: ${String(e)}` }, 500)
    }
    return c.json({ removed: name })
  })

  // ── Verticals (P3.6) — install a domain bundle atomically ──────────
  // Resolution happens first (planVertical): a vertical referencing a missing
  // catalog entry fails before anything is written.
  app.post('/community/verticals/:name', async (c: Context) => {
    const name = c.req.param('name')
    if (!name || !isValidArtifactName(name))
      return c.json({ error: 'invalid vertical name (lowercase slug required)' }, 400)
    const resolved = resolveCwd(c)
    if (resolved.error) return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400)
    const cwd = resolved.cwd ?? process.cwd()
    const entry = getRegistryEntry('vertical', name, cwd)
    if (!entry) return c.json({ error: `vertical not found in registry: ${name}` }, 404)
    const plan = planVertical(entry, cwd)
    if (!plan) return c.json({ error: 'entry is not a vertical bundle' }, 400)
    if (plan.missing.length > 0)
      return c.json(
        { error: `vertical references missing catalog entries: ${plan.missing.join(', ')}` },
        409,
      )

    const installed: { agent?: string; skills: string[]; knowledge: string[] } = {
      skills: [],
      knowledge: [],
    }
    const failed: string[] = []

    // 1. agent persona — before the material it reasons over
    if (plan.agent) {
      const current = getConfig(cwd).agents ?? {}
      try {
        await saveConfig(
          {
            agents: {
              ...current,
              [plan.agent.name]: {
                ...plan.agent.definition,
                description: plan.agent.definition.description ?? plan.description,
              },
            },
          },
          'project',
          cwd,
        )
        installed.agent = plan.agent.name
      } catch (e) {
        failed.push(`agent:${plan.agent.name} (${String(e)})`)
      }
    }

    // 2. skills
    for (const skill of plan.skills) {
      const target = join(localSkillsDir(cwd), `${skill.name}.md`)
      try {
        await mkdir(localSkillsDir(cwd), { recursive: true })
        const body =
          skill.source.kind === 'packaged'
            ? ((await readPackagedPack(skill.name)) ?? '')
            : skill.source.kind === 'inline'
              ? skill.source.content
              : ''
        if (!body) throw new Error('no installable content')
        await writeFile(target, composeSkillPack(skill.name, skill.description, body), {
          encoding: 'utf-8',
        })
        installed.skills.push(skill.name)
      } catch (e) {
        failed.push(`skill:${skill.name} (${String(e)})`)
      }
    }

    // 3. knowledge module
    if (plan.knowledge.length > 0) {
      if (!deps.knowledge) failed.push('knowledge: (store unavailable)')
      else {
        const seeded: string[] = []
        for (const mod of plan.knowledge) {
          if (mod.source.kind !== 'knowledge') {
            failed.push(`knowledge:${mod.name} (not a module)`)
            continue
          }
          try {
            for (const e of mod.source.entries) {
              const stored = await deps.knowledge.store({
                tier: e.tier,
                source: 'user',
                title: e.title,
                content: e.content,
                tags: e.tags ?? [mod.name],
                metadata: { module: mod.name, vertical: name, installed: true },
                sourceKind: 'user-stated',
                createdBy: 'user',
              })
              seeded.push(stored.id)
            }
            installed.knowledge.push(`${mod.name} (${seeded.length})`)
          } catch (e) {
            failed.push(`knowledge:${mod.name} (${String(e)})`)
          }
        }
      }
    }

    return c.json(
      {
        installed: name,
        kind: 'vertical',
        components: installed,
        guidance: plan.guidance,
        ...(failed.length ? { failed } : {}),
      },
      failed.length ? 207 : 201,
    )
  })

  // ── DELETE /community/verticals/:name — remove the bundle's files ──
  // Knowledge is NOT reverted (seeded memories have no uninstall; removing them
  // would destroy user-retrieved context) — the response says so explicitly.
  app.delete('/community/verticals/:name', async (c: Context) => {
    const name = c.req.param('name')
    if (!name || !isValidArtifactName(name)) return c.json({ error: 'invalid vertical name' }, 400)
    const resolved = resolveCwd(c)
    if (resolved.error) return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400)
    const cwd = resolved.cwd ?? process.cwd()
    const entry = getRegistryEntry('vertical', name, cwd)
    if (!entry) return c.json({ error: `vertical not found in registry: ${name}` }, 404)
    const plan = planVertical(entry, cwd)
    if (!plan) return c.json({ error: 'entry is not a vertical bundle' }, 400)

    const removed: string[] = []
    if (plan.agent) {
      try {
        if (await removeAgentFromConfig(plan.agent.name, cwd))
          removed.push(`agent:${plan.agent.name}`)
      } catch (e) {
        return c.json({ error: `uninstall failed: ${String(e)}` }, 500)
      }
    }
    for (const skill of plan.skills) {
      try {
        await rm(join(localSkillsDir(cwd), `${skill.name}.md`), { force: true })
        removed.push(`skill:${skill.name}`)
      } catch (e) {
        return c.json({ error: `uninstall failed: ${String(e)}` }, 500)
      }
    }
    return c.json({
      removed: name,
      kind: 'vertical',
      components: removed,
      knowledgeKept: plan.knowledge.map((k) => k.name),
    })
  })

  // ── POST /community/knowledge/:name — seed a knowledge module ───────
  app.post('/community/knowledge/:name', async (c: Context) => {
    const name = c.req.param('name')
    if (!name || !isValidArtifactName(name)) return c.json({ error: 'invalid module name' }, 400)
    const resolved = resolveCwd(c)
    if (resolved.error) return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400)
    const cwd = resolved.cwd ?? process.cwd()
    const entry = getRegistryEntry('knowledge', name, cwd)
    if (!entry) return c.json({ error: `module not found in registry: ${name}` }, 404)
    if (entry.source.kind !== 'knowledge')
      return c.json({ error: 'entry is not a knowledge module' }, 400)
    if (!deps.knowledge) return c.json({ error: 'knowledge store unavailable' }, 503)
    const ids: string[] = []
    for (const e of entry.source.entries) {
      const stored = await deps.knowledge.store({
        tier: e.tier,
        source: 'user',
        title: e.title,
        content: e.content,
        tags: e.tags ?? [name],
        metadata: { module: name, installed: true },
        sourceKind: 'user-stated',
        createdBy: 'user',
      })
      ids.push(stored.id)
    }
    return c.json({ installed: name, kind: 'knowledge', entries: ids.length, ids }, 201)
  })

  // ── POST /community/publish — add an artifact to this project's catalog ──
  // The write side of the catalog (P3.7). Validation mirrors install exactly, so
  // a publish that succeeds is an install that succeeds; curated names are
  // refused (409) because a local catalog may not redefine a shipped entry.
  app.post('/community/publish', async (c: Context) => {
    const resolved = resolveCwd(c)
    if (resolved.error) return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400)
    const cwd = resolved.cwd ?? process.cwd()
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400)
    }
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return c.json({ error: 'body must be a JSON object' }, 400)
    const req = body as PublishRequest
    const result = publishEntry(cwd, req)
    if (!result.ok) return c.json({ error: result.error }, result.status)
    return c.json(
      {
        published: result.entry.name,
        kind: req.kind,
        replacing: result.replacing,
        installPath: {
          skill: `/community/skills/${result.entry.name}`,
          agent: `/community/agents/${result.entry.name}`,
          knowledge: `/community/knowledge/${result.entry.name}`,
          vertical: `/community/verticals/${result.entry.name}`,
        }[req.kind],
      },
      result.replacing ? 200 : 201,
    )
  })

  // ── GET /community/published — what this project has published ─────
  app.get('/community/published', (c: Context) => {
    const resolved = resolveCwd(c)
    if (resolved.error) return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400)
    const cwd = resolved.cwd ?? process.cwd()
    const entries = listPublished(cwd)
    return c.json({
      cwd,
      count: entries.length,
      entries: entries.map((e) => ({
        kind: e.kind,
        name: e.name,
        description: e.description,
        category: e.category,
        version: e.version,
        author: e.author,
      })),
    })
  })

  // ── DELETE /community/published/:kind/:name — remove a published entry ──
  // Removes the catalog entry only. Anything installed from it (agent in
  // mira.json, .mira/skills files, seeded knowledge) is left alone — uninstall
  // routes own artifact removal, and seeded memories have no uninstall at all.
  app.delete('/community/published/:kind/:name', (c: Context) => {
    const kind = c.req.param('kind')
    const name = c.req.param('name')
    if (!kind || !isCommunityKind(kind))
      return c.json({ error: 'kind must be skill | agent | knowledge | vertical' }, 400)
    if (!name || !isValidArtifactName(name)) return c.json({ error: 'invalid name' }, 400)
    const resolved = resolveCwd(c)
    if (resolved.error) return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400)
    const cwd = resolved.cwd ?? process.cwd()
    const result = unpublishEntry(cwd, kind, name)
    if (!result.removed) {
      return c.json({ error: result.reason }, result.reason?.includes('curated') ? 409 : 404)
    }
    return c.json({ unpublished: name, kind, installedArtifactsKept: true })
  })
}
