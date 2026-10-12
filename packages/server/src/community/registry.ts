/**
 * Community Registry (P3.4) — distribution catalog for shareable artifacts.
 *
 * One generic catalog over three artifact kinds, reusing the proven MCP
 * marketplace shape (committed JSON + embedded fallback + module cache +
 * substring/popularity scoring):
 *
 *   kind 'skill'     → installs to <cwd>/.mira/skills/<name>.md  (skills loader reads it, no restart)
 *   kind 'agent'     → installs to mira.json `agents`             (agent registry reads it, no restart)
 *   kind 'knowledge' → seeds KnowledgeBase entries                (retrieval reads them immediately)
 *   kind 'vertical'  → a BUNDLE composing the three above (P3.6) — one install applies
 *                      an agent + its skills + a knowledge module, atomically
 *
 * Catalog entries are metadata only; content resolution is per-kind:
 *   source.kind 'packaged' → copy the shipped artifact (the bundled skill pack)
 *   source.kind 'inline'   → catalog carries the body itself
 *
 * Like the MCP marketplace this is offline-curated: no remote fetch yet.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type CommunityKind = 'skill' | 'agent' | 'knowledge' | 'vertical'

/** Knowledge module entry — seeds KnowledgeBase (respects store caps: title ≤200, content ≤4000, tags ≤8). */
export interface KnowledgeSeedEntry {
  tier: 'episodic' | 'semantic' | 'procedural'
  title: string
  content: string
  tags?: string[]
}

export interface CommunityEntry {
  name: string
  description: string
  category: string
  /** Curated popularity proxy (MCP marketplace uses the same `stars` convention) */
  stars?: number
  version?: string
  author?: string
  /** What to write on install */
  source:
    | { kind: 'packaged' }
    | { kind: 'inline'; content: string }
    /** agent-only: the definition written to mira.json */
    | { kind: 'agent-def'; definition: AgentDefPayload }
    /** knowledge-only: the entries seeded into the KnowledgeBase */
    | { kind: 'knowledge'; entries: KnowledgeSeedEntry[] }
    /** vertical-only (P3.6): a bundle of the kinds above */
    | { kind: 'vertical'; vertical: VerticalSpec }
}

/**
 * A vertical (P3.6) — a domain agent shipped as one installable bundle.
 *
 * Either carries its own persona (`agent.definition`) or references an existing
 * agent-registry entry (`agent.agent`), plus the skills it should always carry
 * and the knowledge module that gives it domain grounding. Components are
 * resolved against the same catalogs, so a vertical can never reference
 * something that does not exist.
 */
export interface VerticalSpec {
  /** Self-contained persona (wins over `agent`) or a reference to a catalog agent. */
  agent?: { definition: AgentDefPayload } | { agent: string }
  /** Community skill names to install with it */
  skills?: string[]
  /** Community knowledge module names to seed with it */
  knowledge?: string[]
  /** Short usage note shown after install */
  guidance?: string
}

export interface AgentDefPayload {
  system: string
  description?: string
  tools?: string[]
  permissions?: 'readonly' | 'standard' | 'elevated'
  model?: string
}

/** Catalog entry plus the exact artifact that install will write (like toMarketplaceResult). */
export type CommunityResult = CommunityEntry & { kind: CommunityKind }

const CATALOG_FILES: Record<CommunityKind, string> = {
  skill: 'community-skill-registry.json',
  agent: 'community-agent-registry.json',
  knowledge: 'community-knowledge-registry.json',
  vertical: 'community-vertical-registry.json',
}

const FALLBACK: Record<CommunityKind, CommunityEntry[]> = {
  // Kept in sync with community-skill-registry.json; used when no catalog file
  // is present (bundling edge cases) so discovery never hard-fails.
  skill: [
    {
      name: 'tdd-workflow',
      description:
        'Red-green-refactor loop — failing test first, then make it pass, then clean up.',
      category: 'testing',
      stars: 120,
      version: '1.0.0',
      source: { kind: 'packaged' },
    },
    {
      name: 'security-audit',
      description: 'Systematic security review: OWASP top 10, secrets, injection, authz gaps.',
      category: 'security',
      stars: 95,
      version: '1.0.0',
      source: { kind: 'packaged' },
    },
    {
      name: 'code-review',
      description: 'Structured review pass — correctness, tests, readability, blast radius.',
      category: 'quality',
      stars: 88,
      version: '1.0.0',
      source: { kind: 'packaged' },
    },
  ],
  agent: [],
  knowledge: [],
  vertical: [],
}

const cache: Partial<Record<CommunityKind, CommunityEntry[]>> = {}

function hereCandidates(file: string): string[] {
  const here = dirname(fileURLToPath(import.meta.url))
  return [
    join(here, file),
    join(here, '..', '..', 'data', file),
    join(process.cwd(), 'packages', 'server', 'data', file),
    join(process.cwd(), 'data', file),
  ]
}

const KINDS: CommunityKind[] = ['skill', 'agent', 'knowledge', 'vertical']

function isKind(kind: string): kind is CommunityKind {
  return (KINDS as string[]).includes(kind)
}

/**
 * Load a kind's catalog: curated JSON (committed), then embedded fallback.
 *
 * `cwd` (optional, P3.7) overlays this project's own published entries
 * (`<cwd>/.mira/community/<kind>.json`, read fresh — never module-cached, so a
 * publish is installable immediately). Curated entries win a name collision, so
 * publishing can never shadow a shipped artifact. When `cwd` is omitted the
 * curated catalog is returned unchanged, which is what every curated-only caller
 * wants.
 */
export function loadRegistry(kind: CommunityKind, cwd?: string): CommunityEntry[] {
  if (!isKind(kind)) return []
  const base = curatedRegistry(kind)
  if (!cwd) return base
  return mergePublished(base, cwd, kind)
}

/** Curated-only catalog (cached), with the embedded fallback. */
function curatedRegistry(kind: CommunityKind): CommunityEntry[] {
  const cached = cache[kind]
  if (cached) return cached
  let entries: CommunityEntry[] | null = null
  try {
    for (const p of hereCandidates(CATALOG_FILES[kind])) {
      if (!p || !existsSync(p)) continue
      const raw = JSON.parse(readFileSync(p, 'utf-8')) as unknown
      if (Array.isArray(raw) && raw.length > 0) {
        entries = raw.filter(isCommunityEntry)
        if (entries.length > 0) break
      }
    }
  } catch {
    /* fall through to embedded fallback */
  }
  cache[kind] = entries && entries.length ? entries : FALLBACK[kind]
  return cache[kind]
}

/**
 * Append this project's published entries, skipping names a curated entry
 * already claims. Re-read per call on purpose (publish must take effect without
 * a restart).
 */
function mergePublished(
  base: CommunityEntry[],
  cwd: string,
  kind: CommunityKind,
): CommunityEntry[] {
  let published: CommunityEntry[]
  try {
    // Imported lazily: publish.ts imports this module, so a static import here
    // would be a cycle at module-eval time.
    published = readPublishedSync(cwd, kind)
  } catch {
    return base
  }
  if (published.length === 0) return base
  const taken = new Set(base.map((e) => e.name.toLowerCase()))
  const extra = published.filter((e) => !taken.has(e.name.toLowerCase()))
  return extra.length ? [...base, ...extra] : base
}

/**
 * Direct JSON read of a published catalog. Lives here (rather than in
 * publish.ts) so the registry's load path stays a leaf module with no cycle.
 */
function readPublishedSync(cwd: string, kind: CommunityKind): CommunityEntry[] {
  const file = join(cwd, '.mira', 'community', `${kind}.json`)
  if (!existsSync(file)) return []
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as unknown
    if (!Array.isArray(raw)) return []
    return raw.filter(isCommunityEntry)
  } catch {
    return []
  }
}

function isCommunityEntry(e: unknown): e is CommunityEntry {
  if (!e || typeof e !== 'object') return false
  const x = e as Partial<CommunityEntry>
  if (typeof x.name !== 'string' || !x.name) return false
  if (typeof x.description !== 'string' || !x.description) return false
  if (typeof x.category !== 'string' || !x.category) return false
  return !!x.source && typeof x.source === 'object'
}

/** Clear the registry cache (tests, runtime refresh). */
export function resetRegistryCache(kind?: CommunityKind): void {
  if (kind) delete cache[kind]
  else for (const k of Object.keys(cache) as CommunityKind[]) delete cache[k]
}

/**
 * Relevance: a real text hit (name/description/category) is required; the
 * popularity term only ranks among entries that matched. (Note: the MCP
 * marketplace adds popularity unconditionally, so every entry scores > 0 —
 * we require the hit so a nonsense query returns nothing instead of the
 * most-starred pack.)
 */
function matchScore(entry: CommunityEntry, q: string): number {
  const qq = q.toLowerCase()
  let s = 0
  if (entry.name.toLowerCase().includes(qq)) s += 10
  if (entry.description.toLowerCase().includes(qq)) s += 5
  if (entry.category.toLowerCase().includes(qq)) s += 7
  return s
}

function score(entry: CommunityEntry, q: string): number {
  return matchScore(entry, q) + Math.log10((entry.stars ?? 100) + 1)
}

/**
 * Search a kind's catalog. Empty query returns the whole catalog by stars
 * (browse). Pass `cwd` to include this project's published entries (P3.7).
 */
export function searchRegistry(
  kind: CommunityKind,
  query = '',
  limit = 20,
  cwd?: string,
): CommunityResult[] {
  const q = query.trim()
  const all = loadRegistry(kind, cwd).map((e) => ({ ...e, kind }))
  if (!q) return all.sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0)).slice(0, limit)
  return all
    .map((e) => ({ e, s: score(e, q) }))
    .filter(({ e }) => matchScore(e, q) > 0)
    .sort((a, b) => b.s - a.s || a.e.name.localeCompare(b.e.name))
    .slice(0, limit)
    .map(({ e }) => e)
}

/**
 * Exact lookup by name (case-insensitive) for one-click install. Pass `cwd` to
 * resolve against published entries too (P3.7); curated wins a collision.
 */
export function getRegistryEntry(
  kind: CommunityKind,
  name: string,
  cwd?: string,
): CommunityResult | null {
  const target = name.toLowerCase()
  const hit = loadRegistry(kind, cwd).find((e) => e.name.toLowerCase() === target)
  return hit ? { ...hit, kind } : null
}

/** Validate an install-target name (slug): lowercase letters/digits/dash/underscore. */
export function isValidArtifactName(name: string): boolean {
  return /^[a-z][a-z0-9_-]{1,63}$/.test(name)
}
