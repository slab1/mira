/**
 * Mira Skills Loader
 * Loads SKILL.md packs from packages/server/data/skills/
 */
import { readFile } from "node:fs/promises"
import { join } from "node:path"

export interface Skill {
  name: string
  description: string
  whenToUse: string
  instructions: string
}

export async function loadSkills(): Promise<Record<string, Skill>> {
  const dir = join(process.cwd(), "packages/server/data/skills")
  const skills: Record<string, Skill> = {}
  try {
    const entries = Bun.readDirSync(dir)
    for (const entry of entries) {
      const skillDir = join(dir, entry)
      const mdPath = join(skillDir, "SKILL.md")
      try {
        const content = await readFile(mdPath, "utf-8")
        skills[entry] = {
          name: entry,
          description: content.slice(0, 200),
          whenToUse: "",
          instructions: content,
        }
      } catch {}
    }
  } catch {}
  return skills
}
