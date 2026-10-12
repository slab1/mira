/**
 * Community publish (P3.7) — the write side of the distribution catalog.
 *
 * Install (routes/community.ts) can apply anything the catalog holds, but
 * nothing could put an artifact *into* the catalog: the four committed
 * `community-*-registry.json` files are curated by hand in-repo. This module is
 * the missing half — validate a proposed artifact and record it so it becomes
 * installable.
 *
 * Three rules shape the design, each mirroring an existing guarantee:
 *
 *   1. **Same validation as install.** `buildPublishEntry` enforces exactly the
 *      constraints the install path enforces later (skill slug + non-empty body,
 *      agent slug + `system.trim().length >= 10`, knowledge entries inside the
 *      KnowledgeBase store caps, vertical components resolvable). An entry that
 *      cannot install is refused at publish time rather than adding a catalog
 *      entry that 409s on first install.
 *   2. **Curated entries are immutable.** A publish that collides with a shipped
 *      catalog name is refused (409). Publishing may only create new names or
 *      replace an earlier *published* entry, so a project can never redefine
 *      `luxora` for itself.
 *   3. **Project-local scope.** Published catalogs live in
 *      `<cwd>/.mira/community/<kind>.json`, beside the `.mira/skills` installs
 *      they feed. They are not global, so a publish in one repo is invisible to
 *      another — sharing stays a human decision (commit the entry upstream).
 *
 * Unlike the curated files, published catalogs are NOT module-cached: they are
 * re-read per load so a publish is installable immediately, matching the
 * "install takes effect without a restart" contract of the install surface.
 */
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  isValidArtifactName,
  loadRegistry,
  type AgentDefPayload,
  type CommunityEntry,
  type CommunityKind,
  type KnowledgeSeedEntry,
  type VerticalSpec,
} from './registry.js'
import { planVertical } from './verticals.js'

/** Where a project's own published catalogs live. */
export function publishedDir(cwd: string): string {
  return join(cwd, '.mira', 'community')
}

export function publishedFile(cwd: string, kind: CommunityKind): string {
  return join(publishedDir(cwd), `${kind}.json`)
}

const KINDS: CommunityKind[] = ['skill', 'agent', 'knowledge', 'vertical']

export function isCommunityKind(kind: string): kind is CommunityKind {
  return (KINDS as string[]).includes(kind)
}

// Store caps, mirrored from the KnowledgeBase (learning/knowledge.ts). Named
// constants because catalog tests assert against the same bounds; a silent
// drift would let publishes the store later truncates or rejects.
export const TITLE_MAX = 200
export const CONTENT_MAX = 4000
export const TAGS_MAX = 8

const SKILL_MAX = 200_000
const DESCRIPTION_MAX = 300

/** Agent names use a tighter slug (config key rule) — mirrors install. */
const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{1,40}$/
const PERMISSIONS = ['readonly', 'standard', 'elevated'] as const

export type PublishRequest =
  | {
      kind: 'skill'
      name: string
      description: string
      category?: string
      content: string
      version?: string
      author?: string
    }
  | {
      kind: 'agent'
      name: string
      description: string
      category?: string
      definition: AgentDefPayload
      version?: string
      author?: string
    }
  | {
      kind: 'knowledge'
      name: string
      description: string
      category?: string
      entries: KnowledgeSeedEntry[]
      version?: string
      author?: string
    }
  | {
      kind: 'vertical'
      name: string
      description: string
      category?: string
      vertical: VerticalSpec
      version?: string
      author?: string
    }

/** Outcome of validating a request — `replacing` is decided by the write. */
export type BuildResult =
  { ok: true; entry: CommunityEntry } | { ok: false; status: 400 | 409; error: string }

export type PublishResult =
  | { ok: true; entry: CommunityEntry; replacing: boolean }
  | { ok: false; status: 400 | 409; error: string }

function fail(status: 400 | 409, error: string): { ok: false; status: 400 | 409; error: string } {
  return { ok: false, status, error }
}

function str(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

function isEntry(e: unknown): e is CommunityEntry {
  if (!e || typeof e !== 'object') return false
  const x = e as Partial<CommunityEntry>
  return str(x.name) && str(x.description) && str(x.category) && !!x.source
}

/**
 * Read a published catalog for one kind. Never throws: a missing or corrupt
 * file means "nothing published", not a failed install path.
 */
export function loadPublished(cwd: string, kind: CommunityKind): CommunityEntry[] {
  const file = publishedFile(cwd, kind)
  if (!existsSync(file)) return []
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as unknown
    return Array.isArray(raw) ? raw.filter(isEntry) : []
  } catch {
    return []
  }
}

/** Every published entry across all four kinds. */
export function listPublished(cwd: string): Array<CommunityEntry & { kind: CommunityKind }> {
  return KINDS.flatMap((k) => loadPublished(cwd, k).map((e) => ({ ...e, kind: k })))
}

function validateKnowledgeEntries(entries: unknown): string | null {
  if (!Array.isArray(entries) || entries.length === 0)
    return 'knowledge entries must be a non-empty array'
  if (entries.length > 50) return 'knowledge modules are capped at 50 entries'
  for (const [i, raw] of entries.entries()) {
    const e = raw as Partial<KnowledgeSeedEntry>
    if (!e || !['episodic', 'semantic', 'procedural'].includes(e.tier ?? ''))
      return `entries[${i}].tier must be episodic | semantic | procedural`
    if (!str(e.title)) return `entries[${i}].title required`
    if (e.title.length > TITLE_MAX) return `entries[${i}].title exceeds ${TITLE_MAX} chars`
    if (!str(e.content)) return `entries[${i}].content required`
    if (e.content.length > CONTENT_MAX) return `entries[${i}].content exceeds ${CONTENT_MAX} chars`
    if (e.tags !== undefined) {
      if (!Array.isArray(e.tags)) return `entries[${i}].tags must be an array`
      if (e.tags.length > TAGS_MAX) return `entries[${i}].tags exceeds ${TAGS_MAX}`
      if (!e.tags.every((t) => str(t))) return `entries[${i}].tags must be non-empty strings`
    }
  }
  return null
}

function validateAgentDefinition(def: unknown): string | null {
  if (!def || typeof def !== 'object') return 'agent definition required'
  const d = def as AgentDefPayload
  if (typeof d.system !== 'string' || d.system.trim().length < 10)
    return 'agent definition.system must be at least 10 characters'
  if (d.description !== undefined && typeof d.description !== 'string')
    return 'agent definition.description must be a string'
  if (d.tools !== undefined && (!Array.isArray(d.tools) || !d.tools.every((t) => str(t))))
    return 'agent definition.tools must be an array of tool names'
  if (d.permissions !== undefined && !PERMISSIONS.includes(d.permissions))
    return `agent definition.permissions must be one of ${PERMISSIONS.join(', ')}`
  if (d.model !== undefined && !str(d.model)) return 'agent definition.model must be a string'
  return null
}

/**
 * Validate a publish request and build the catalog entry it describes.
 *
 * `cwd` is needed for the vertical case: components resolve against the curated
 * catalogs *plus* what this project has already published, so a vertical built
 * from an earlier publish is allowed but one referencing a typo is not.
 */
export function buildPublishEntry(cwd: string, req: PublishRequest): BuildResult {
  if (!req || !isCommunityKind(req.kind))
    return fail(400, 'kind must be skill | agent | knowledge | vertical')
  if (!isValidArtifactName(req.name))
    return fail(
      400,
      `invalid ${req.kind} name: lowercase slug required (a-z, 0-9, - _, 2-64 chars)`,
    )
  if (!str(req.description)) return fail(400, 'description required')
  if (req.description.length > DESCRIPTION_MAX)
    return fail(400, `description exceeds ${DESCRIPTION_MAX} chars`)
  const category = req.category?.trim() || 'community'
  if (category.length > 64) return fail(400, 'category exceeds 64 chars')

  const base = {
    name: req.name,
    description: req.description.trim(),
    category,
    version: req.version?.trim() || '1.0.0',
    // `stars` is deliberately unset: a locally published entry starts at the
    // popularity floor instead of claiming curated traction.
    ...(req.author?.trim() ? { author: req.author.trim() } : {}),
  }

  switch (req.kind) {
    case 'skill': {
      if (!str(req.content)) return fail(400, 'skill content required')
      if (req.content.length > SKILL_MAX)
        return fail(400, `skill content exceeds ${SKILL_MAX} chars`)
      return { ok: true, entry: { ...base, source: { kind: 'inline', content: req.content } } }
    }
    case 'agent': {
      if (!AGENT_NAME_RE.test(req.name))
        return fail(400, 'invalid agent name (lowercase slug required)')
      const err = validateAgentDefinition(req.definition)
      if (err) return fail(400, err)
      return {
        ok: true,
        entry: { ...base, source: { kind: 'agent-def', definition: req.definition } },
      }
    }
    case 'knowledge': {
      const err = validateKnowledgeEntries(req.entries)
      if (err) return fail(400, err)
      return { ok: true, entry: { ...base, source: { kind: 'knowledge', entries: req.entries } } }
    }
    case 'vertical': {
      const spec = req.vertical
      if (!spec || typeof spec !== 'object') return fail(400, 'vertical spec required')
      if (spec.guidance !== undefined && typeof spec.guidance !== 'string')
        return fail(400, 'vertical.guidance must be a string')
      for (const key of ['skills', 'knowledge'] as const) {
        const list = spec[key]
        if (list === undefined) continue
        if (!Array.isArray(list) || !list.every((n) => str(n)))
          return fail(400, `vertical.${key} must be an array of catalog names`)
      }
      if (spec.agent) {
        if ('definition' in spec.agent && spec.agent.definition) {
          const err = validateAgentDefinition(spec.agent.definition)
          if (err) return fail(400, `vertical.agent: ${err}`)
        } else if (!str((spec.agent as { agent?: unknown }).agent)) {
          return fail(400, 'vertical.agent must carry a definition or an agent name')
        }
      }
      // Resolve against curated + already-published catalogs, so what we write
      // is exactly what install will later accept.
      const entry: CommunityEntry = { ...base, source: { kind: 'vertical', vertical: spec } }
      const plan = planVertical(entry, cwd)
      if (!plan) return fail(400, 'vertical spec is not resolvable')
      if (plan.missing.length > 0)
        return fail(409, `vertical references missing catalog entries: ${plan.missing.join(', ')}`)
      return { ok: true, entry }
    }
  }
}

/**
 * True when publishing `name` would redefine something already curated — either
 * a shipped entry of that kind, or a component a shipped vertical depends on
 * (redefining it would silently change what that curated bundle installs).
 */
export function shadowsCurated(kind: CommunityKind, name: string): boolean {
  const target = name.toLowerCase()
  if (loadRegistry(kind).some((e) => e.name.toLowerCase() === target)) return true
  if (kind === 'vertical') return false
  return loadRegistry('vertical').some((v) => {
    const plan = planVertical(v)
    if (!plan) return false
    if (kind === 'skill') return plan.skills.some((s) => s.name.toLowerCase() === target)
    if (kind === 'knowledge') return plan.knowledge.some((k) => k.name.toLowerCase() === target)
    return plan.agent?.name.toLowerCase() === target
  })
}

/**
 * Validate then write. Replaces an earlier published entry of the same name;
 * refuses to touch a curated one. The write is atomic (temp file + rename) so a
 * crash mid-write cannot leave a truncated catalog that `loadPublished` would
 * silently read as empty.
 */
export function publishEntry(cwd: string, req: PublishRequest): PublishResult {
  const built = buildPublishEntry(cwd, req)
  if (!built.ok) return built
  const { entry } = built

  if (shadowsCurated(req.kind, entry.name)) {
    return fail(409, `'${entry.name}' is curated — publishing cannot redefine a shipped entry`)
  }

  const existing = loadPublished(cwd, req.kind)
  const i = existing.findIndex((e) => e.name.toLowerCase() === entry.name.toLowerCase())
  const next = i >= 0 ? existing.map((e, idx) => (idx === i ? entry : e)) : [...existing, entry]

  const file = publishedFile(cwd, req.kind)
  mkdirSync(publishedDir(cwd), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf-8' })
    renameSync(tmp, file)
  } catch (e) {
    try {
      if (existsSync(tmp)) renameSync(tmp, `${tmp}.failed`)
    } catch {}
    return fail(400, `publish failed: ${String(e)}`)
  }
  return { ok: true, entry, replacing: i >= 0 }
}

/**
 * Remove a published entry. Refuses curated names (they are not ours to delete)
 * and returns whether anything was removed.
 */
export function unpublishEntry(
  cwd: string,
  kind: CommunityKind,
  name: string,
): {
  removed: boolean
  reason?: string
} {
  if (shadowsCurated(kind, name)) {
    return {
      removed: false,
      reason: `'${name}' is curated — curated entries cannot be unpublished`,
    }
  }
  const existing = loadPublished(cwd, kind)
  const i = existing.findIndex((e) => e.name.toLowerCase() === name.toLowerCase())
  if (i < 0) return { removed: false, reason: `not published: ${name}` }
  const next = existing.filter((_, idx) => idx !== i)
  const file = publishedFile(cwd, kind)
  const tmp = `${file}.${process.pid}.tmp`
  try {
    if (next.length === 0) {
      writeFileSync(tmp, '[]\n', { encoding: 'utf-8' })
    } else {
      writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf-8' })
    }
    renameSync(tmp, file)
  } catch (e) {
    return { removed: false, reason: `unpublish failed: ${String(e)}` }
  }
  return { removed: true }
}
