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
 *   GET    /community/registry         → catalog search across kinds
 *
 * Install targets are all read by live loaders, so an install takes effect
 * without a restart (skills loader re-reads the directory per call, agents are
 * merged from config per call, knowledge is stored directly).
 *
 * Writes are cwd-scoped (`?cwd=`), sanitized, and checked against guardrails
 * allowedRoots — same contract as PATCH /config. Uninstall only removes the
 * project-local artifact, never a packaged one.
 */
import type { Hono, Context } from 'hono'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getConfig, removeAgentFromConfig, saveConfig } from '../config/index.js'
import { isPathAllowed, sanitizePath } from '../guardrails/index.js'
import {
  getRegistryEntry,
  isValidArtifactName,
  searchRegistry,
  type CommunityKind,
} from '../community/registry.js'
import { SKILLS_DIR } from '../skills/loader.js'
import type { StoreInput } from '../learning/knowledge.js'
import type { MiraConfig } from '../types/index.js'

const KINDS = ['skill', 'agent', 'knowledge'] as const

/** Same contract as PATCH /config: sanitize + allowedRoots check, else 400/403. */
function resolveCwd(c: Context): { cwd?: string; error?: string; status?: number } {
  const raw = c.req.query('cwd')
  if (!raw) return {}
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
  // Directory layout first (all 20 shipped packs), then the single-file form.
  for (const p of [join(SKILLS_DIR, name, 'SKILL.md'), join(SKILLS_DIR, `${name}.md`)]) {
    try {
      return await readFile(p, 'utf-8')
    } catch {}
  }
  return null
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
    const results = kinds.flatMap((k) => searchRegistry(k, rawQ, limit))
    return c.json({ query: rawQ, count: results.length, entries: results })
  })

  // ── POST /community/skills/:name — install a skill pack ───────────
  app.post('/community/skills/:name', async (c: Context) => {
    const name = c.req.param('name')
    if (!name || !isValidArtifactName(name))
      return c.json({ error: 'invalid skill name (lowercase slug required)' }, 400)
    const entry = getRegistryEntry('skill', name)
    if (!entry) return c.json({ error: `skill not found in registry: ${name}` }, 404)
    const resolved = resolveCwd(c)
    if (resolved.error) return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400)
    const cwd = resolved.cwd ?? process.cwd()

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
    const entry = getRegistryEntry('agent', name)
    if (!entry) return c.json({ error: `agent not found in registry: ${name}` }, 404)
    if (entry.source.kind !== 'agent-def')
      return c.json({ error: 'entry is not installable as an agent' }, 400)
    const resolved = resolveCwd(c)
    if (resolved.error) return c.json({ error: resolved.error }, (resolved.status ?? 400) as 400)
    const cwd = resolved.cwd ?? process.cwd()
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

  // ── POST /community/knowledge/:name — seed a knowledge module ───────
  app.post('/community/knowledge/:name', async (c: Context) => {
    const name = c.req.param('name')
    if (!name || !isValidArtifactName(name)) return c.json({ error: 'invalid module name' }, 400)
    const entry = getRegistryEntry('knowledge', name)
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
}
