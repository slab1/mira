/**
 * Mira Shared — AGENTS.md + Skills
 *
 * Spec-compatible with OpenCode/Claude Code AGENTS.md loader:
 *  - Searches cwd upward for AGENTS.md / CLAUDE.md / .mira/instructions.md
 *  - Frontmatter-aware (YAML between ---), but plain markdown also works
 *  - Skills: SKILL.md packs under .mira/skills/<name>/SKILL.md or <project>/skills/<name>/SKILL.md
 *
 * Results are injected into system prompt (see buildSystemPrompt / loadAgentsContext).
 */
import { z } from "zod"

// ── Constants ──────────────────────────────────────────────────────
export const AGENTS_FILES = ["AGENTS.md", "CLAUDE.md", ".mira/instructions.md"] as const
export type AgentsFileName = typeof AGENTS_FILES[number]

/** Directories searched for skills (in order). */
export const SKILL_DIRS = [".mira/skills", "skills", ".opencode/skills"] as const

/** Max chars to inject per AGENTS.md / skill to avoid context blowup. */
export const MAX_AGENTS_CHARS = 8000
export const MAX_SKILL_CHARS = 6000

// ── Skill schema ───────────────────────────────────────────────────
export const skillFrontmatterSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  version: z.string().optional(),
  tags: z.array(z.string()).optional(),
}).passthrough()

export const skillSchema = z.object({
  name: z.string().min(1).describe("Skill name (directory name, e.g. tdd-workflow)"),
  path: z.string().min(1).describe("Absolute path to SKILL.md"),
  frontmatter: skillFrontmatterSchema.optional(),
  content: z.string().min(1).describe("Markdown body (without frontmatter)"),
})
export type Skill = z.infer<typeof skillSchema>

export const agentsContextSchema = z.object({
  cwd: z.string(),
  agentsMd: z.array(z.object({
    file: z.string(),
    path: z.string(),
    content: z.string(),
  })),
  skills: z.array(skillSchema).optional(),
})
export type AgentsContext = z.infer<typeof agentsContextSchema>

// ── Frontmatter strip ──────────────────────────────────────────────
export function stripFrontmatter(md: string): { frontmatter: Record<string, unknown> | null; content: string } {
  if (!md.startsWith("---")) return { frontmatter: null, content: md }
  const end = md.indexOf("\n---", 3)
  if (end === -1) return { frontmatter: null, content: md }
  const raw = md.slice(3, end).trim()
  const content = md.slice(end + 4).replace(/^\n/, "")
  // Minimal YAML parse: key: value + array via "- " — keep simple, avoid js-yaml dep in shared
  const fm: Record<string, unknown> = {}
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([\w-]+)\s*:\s*(.+)\s*$/)
    if (m) fm[m[1]] = m[2].replace(/^["']|["']$/g, "")
  }
  return { frontmatter: Object.keys(fm).length ? fm : null, content }
}

export function parseSkillMarkdown(raw: string, fallbackName: string): { frontmatter: Record<string, unknown> | null; content: string; name: string } {
  const { frontmatter, content } = stripFrontmatter(raw)
  const name = (frontmatter?.name as string) ?? fallbackName
  return { frontmatter, content, name }
}

// ── AgentsMd discovery (pure helper, no FS) ────────────────────────
/**
 * Given file map (path → content), pick the first AGENTS file found.
 * Pure function for testing; see `loadAgentsContext` for filesystem version.
 */
export function selectAgentsMd(
  files: Map<string, string>,
  cwd: string
): Array<{ file: string; path: string; content: string }> {
  const found: Array<{ file: string; path: string; content: string }> = []
  for (const name of AGENTS_FILES) {
    const p = `${cwd}/${name}`
    const content = files.get(p) ?? files.get(name)
    if (content) found.push({ file: name, path: p, content: content.slice(0, MAX_AGENTS_CHARS) })
  }
  return found
}

// ── Filesystem loader (Bun/Node agnostic) ──────────────────────────
function getDefaultCwd(): string {
  try { return (globalThis as unknown as { process?: { cwd(): string } }).process?.cwd?.() ?? "." } catch { return "." }
}

export async function loadAgentsContext(
  cwd = getDefaultCwd(),
  opts: { loadSkills?: boolean } = {}
): Promise<AgentsContext> {
  const agentsMd: AgentsContext["agentsMd"] = []

  // Use Bun.file if available, fallback to node:fs
  const tryRead = async (path: string): Promise<string | null> => {
    try {
      // Prefer Bun.file (works in Bun, no-op in Node with polyfill)
      const hasBun = typeof (globalThis as unknown as { Bun?: { file: (p: string) => { exists(): Promise<boolean>; text(): Promise<string> } } }).Bun !== "undefined"
      if (hasBun) {
        const BunAny = (globalThis as unknown as { Bun: { file: (p: string) => { exists(): Promise<boolean>; text(): Promise<string> } } }).Bun
        const f = BunAny.file(path)
        if (await f.exists()) return await f.text()
      }
    } catch {}
    try {
      // @ts-ignore — node:fs/promises is Node/Bun only, not needed for type-check in browser
      const { readFile } = await import("node:fs/promises")
      return await readFile(path, "utf8")
    } catch { return null }
  }

  for (const name of AGENTS_FILES) {
    const abs = `${cwd}/${name}`
    const text = await tryRead(abs)
    if (text) agentsMd.push({ file: name, path: abs, content: text.slice(0, MAX_AGENTS_CHARS) })
  }

  let skills: Skill[] | undefined
  if (opts.loadSkills) skills = await loadSkills(cwd, tryRead)

  return { cwd, agentsMd, skills }
}

async function loadSkills(
  cwd: string,
  tryRead: (p: string) => Promise<string | null>
): Promise<Skill[]> {
  const out: Skill[] = []
  for (const dir of SKILL_DIRS) {
    const base = `${cwd}/${dir}`
    // List skill dirs — best-effort via fs.readdir
    try {
      // @ts-ignore — node:fs/promises is Node/Bun only
      const { readdir } = await import("node:fs/promises")
      const entries = await readdir(base, { withFileTypes: true })
      for (const ent of entries) {
        if (!ent.isDirectory()) continue
        const skillPath = `${base}/${ent.name}/SKILL.md`
        const raw = await tryRead(skillPath)
        if (!raw) continue
        const { frontmatter, content, name } = parseSkillMarkdown(raw, ent.name)
        out.push({ name, path: skillPath, frontmatter: frontmatter ?? undefined, content: content.slice(0, MAX_SKILL_CHARS) })
      }
    } catch { /* dir missing → skip */ }
  }
  return out
}

// ── System prompt builder ──────────────────────────────────────────
export function buildAgentsPromptPart(ctx: AgentsContext): string {
  const parts: string[] = []
  for (const a of ctx.agentsMd) {
    parts.push(`# Project Instructions (${a.file})\n${a.content}`)
  }
  if (ctx.skills?.length) {
    for (const s of ctx.skills) {
      parts.push(`# Skill: ${s.name}\n${s.content}`)
    }
  }
  return parts.join("\n\n")
}

export async function buildSystemPrompt(
  cwd = getDefaultCwd(),
  extra: string[] = []
): Promise<string> {
  const base = [
    "You are Mira — a senior AI agent. Be concise, pragmatic, and thorough.",
    "Follow plan-first workflow: Explore → Plan → Implement → Verify.",
  ]
  const ctx = await loadAgentsContext(cwd)
  const injected = buildAgentsPromptPart(ctx)
  return [...base, ...extra, injected].filter(Boolean).join("\n\n")
}
