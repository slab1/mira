/**
 * Mira Skills Loader v2
 *
 * Loads SKILL.md packs from packages/server/data/skills/ with YAML frontmatter:
 *
 *   ---
 *   name: tdd-workflow
 *   description: Red-green-refactor loop for every code change.
 *   triggers:
 *     - tdd
 *     - test-driven
 *   ---
 *   Body = concise actionable instructions.
 *
 * Supports both layouts: <dir>/<name>/SKILL.md and <dir>/<name>.md.
 * Frontmatter is parsed with a minimal hand-rolled reader (scalars +
 * string lists) — no external YAML dependency.
 */
import { readFile, readdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"

/** Content directory: packages/server/src/skills/../../data/skills */
export const SKILLS_DIR = fileURLToPath(new URL("../../data/skills/", import.meta.url))

export interface SkillPack {
  /** unique pack id (frontmatter `name`, falls back to directory/file name) */
  name: string
  description: string
  /** keywords matched against user input by recommendSkills() */
  triggers: string[]
  /** markdown body (instructions), frontmatter stripped */
  instructions: string
}

export interface SkillIndexEntry {
  name: string
  description: string
}

// ── Frontmatter parsing ────────────────────────────────────────────

interface ParsedDoc {
  data: Record<string, string | string[]>
  body: string
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

function unquote(value: string): string {
  const t = value.trim()
  if ((t.startsWith('"') && t.endsWith('"') && t.length >= 2) ||
      (t.startsWith("'") && t.endsWith("'") && t.length >= 2)) {
    return t.slice(1, -1)
  }
  return t
}

/** Minimal YAML subset: `key: scalar` and `key:` followed by `- item` lists. */
export function parseFrontmatter(raw: string): ParsedDoc {
  const match = FRONTMATTER_RE.exec(raw)
  if (!match) return { data: {}, body: raw }

  const data: Record<string, string | string[]> = {}
  let currentKey: string | null = null

  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue

    const listItem = /^\s+-\s?(.*)$/.exec(line)
    if (listItem && currentKey) {
      const arr = data[currentKey]
      if (Array.isArray(arr)) arr.push(unquote(listItem[1]))
      continue
    }

    const kv = /^([\w][\w-]*):\s?(.*)$/.exec(line)
    if (kv) {
      currentKey = kv[1]
      if (kv[2] === "") {
        data[currentKey] = []
      } else {
        data[currentKey] = unquote(kv[2])
        currentKey = null // inline scalar — following "- item" lines belong to no one
      }
    }
  }
  return { data, body: raw.slice(match[0].length) }
}

function toStringArray(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.filter(v => v !== "")
  if (typeof value === "string" && value !== "") return [value]
  return []
}

// ── Loading ────────────────────────────────────────────────────────

function toPack(id: string, raw: string): SkillPack {
  const { data, body } = parseFrontmatter(raw)
  return {
    name: typeof data.name === "string" && data.name ? data.name : id,
    description: typeof data.description === "string" ? data.description : "",
    triggers: toStringArray(data.triggers),
    instructions: body.trim(),
  }
}

/**
 * Load all skill packs from the content directory, keyed by pack name.
 * Malformed packs are skipped silently; a missing directory yields {}.
 */
export async function loadSkills(): Promise<Record<string, SkillPack>> {
  const skills: Record<string, SkillPack> = {}
  let entries: string[]
  try {
    entries = await readdir(SKILLS_DIR)
  } catch {
    return skills
  }

  await Promise.all(
    entries.map(async entry => {
      try {
        if (entry.endsWith(".md")) {
          // flat layout: <name>.md
          const pack = toPack(entry.replace(/\.md$/, ""), await readFile(`${SKILLS_DIR}${entry}`, "utf-8"))
          skills[pack.name] = pack
          return
        }
        // directory layout: <name>/SKILL.md
        const pack = toPack(entry, await readFile(`${SKILLS_DIR}${entry}/SKILL.md`, "utf-8"))
        skills[pack.name] = pack
      } catch {
        // unreadable/malformed pack — skip
      }
    }),
  )
  return skills
}

// ── Recommendation ─────────────────────────────────────────────────

export interface RecommendedSkill extends SkillPack {
  /** number of distinct triggers hit in the input text */
  score: number
}

/**
 * Rank skill packs by trigger-keyword hits against the input text.
 * Only packs with at least one hit are returned, best first.
 * Ties break alphabetically for deterministic output.
 */
export async function recommendSkills(text: string): Promise<RecommendedSkill[]> {
  const haystack = text.toLowerCase()
  const packs = Object.values(await loadSkills())

  const scored: RecommendedSkill[] = []
  for (const pack of packs) {
    let score = 0
    for (const trigger of pack.triggers) {
      if (trigger && haystack.includes(trigger.toLowerCase())) score++
    }
    if (score > 0) scored.push({ ...pack, score })
  }

  return scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
}

// ── Index ──────────────────────────────────────────────────────────

/** Lightweight listing ({name, description}) without loading bodies into context. */
export async function listSkillIndex(): Promise<SkillIndexEntry[]> {
  const packs = Object.values(await loadSkills())
  return packs
    .map(({ name, description }) => ({ name, description }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
