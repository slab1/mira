/**
 * Mira Commands Loader — discovers slash commands from markdown files.
 *
 * Mirrors Mira's `.mira/commands/<name>.md` convention:
 *   ---
 *   description: One-liner shown in palette
 *   agent: build | plan | ...
 *   model: provider/model-id
 *   ---
 *   Body = template with $ARGUMENTS, !`cmd`, @file references.
 *
 * Also merges built-ins and skills for a unified palette.
 */
import { readdir, readFile } from "node:fs/promises"
import { parseFrontmatter } from "../skills/loader.js"

export interface CommandEntry {
  name: string
  description: string
  content: string
  source: "built-in" | "command" | "skill"
  agent?: string
  model?: string
}

const BUILT_INS: CommandEntry[] = [
  { name: "/new", description: "Start a new session", content: "", source: "built-in" },
  { name: "/sessions", description: "List and switch sessions", content: "", source: "built-in" },
  { name: "/compact", description: "Compact session to free context", content: "", source: "built-in" },
  { name: "/share", description: "Generate public link", content: "", source: "built-in" },
  { name: "/unshare", description: "Revoke public link", content: "", source: "built-in" },
  { name: "/export", description: "Export conversation to Markdown", content: "", source: "built-in" },
  { name: "/models", description: "Browse and switch models", content: "", source: "built-in" },
  { name: "/connect", description: "Add a provider", content: "", source: "built-in" },
  { name: "/themes", description: "Switch theme", content: "", source: "built-in" },
  { name: "/undo", description: "Undo last message", content: "", source: "built-in" },
  { name: "/redo", description: "Redo undone message", content: "", source: "built-in" },
  { name: "/help", description: "Show help", content: "", source: "built-in" },
  { name: "/clear", description: "Clear current session", content: "", source: "built-in" },
]

const COMMAND_DIRS = [".mira/commands", "commands"]
// Also scan repo root when server runs from packages/server (common in dev)
const EXTRA_DIRS = ["../.mira/commands", "../../.mira/commands"]

async function loadFromDir(dir: string, source: "command"): Promise<CommandEntry[]> {
  const out: CommandEntry[] = []
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue
    const path = `${dir}/${entry}`
    try {
      const raw = await readFile(path, "utf-8")
      const { data, body } = parseFrontmatter(raw)
      const base = entry.replace(/\.md$/, "")
      const name = `/${base}`
      const desc = typeof data["description"] === "string" ? (data["description"] as string) : ""
      const agent = typeof data["agent"] === "string" ? (data["agent"] as string) : undefined
      const model = typeof data["model"] === "string" ? (data["model"] as string) : undefined
      out.push({ name, description: desc, content: body.trim(), source, agent, model })
    } catch {
      continue
    }
  }
  return out
}

export async function loadCommands(cwd = process.cwd()): Promise<CommandEntry[]> {
  const discovered: CommandEntry[] = []
  for (const dir of [...COMMAND_DIRS, ...EXTRA_DIRS]) {
    const full = `${cwd}/${dir}`
    const list = await loadFromDir(full, "command")
    discovered.push(...list)
  }
  // Deduplicate: discovered overrides built-ins on name collision (like Mira)
  const byName = new Map<string, CommandEntry>()
  for (const b of BUILT_INS) byName.set(b.name, b)
  for (const c of discovered) byName.set(c.name, c)
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function getBuiltIns(): CommandEntry[] {
  return [...BUILT_INS]
}
