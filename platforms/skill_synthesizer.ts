/**
 * Mira DCS Skill Synthesizer — TS port of `platforms/skill_synthesizer.py:38`
 *
 * Synthesizes skill skeletons marked UNVERIFIED-DO-NOT-USE until human review.
 * Pipeline: Research -> Implementation (scaffold) -> Documentation (SKILL.md + Human Review Required) -> Validation
 * Fail-closed: without a real implementation `tool.ts` raises and status is `unverified`, never `success`.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { spawnSync } from "node:child_process"

export const UNVERIFIED_MARKER = "UNVERIFIED-DO-NOT-USE"

// Synth output dir — repo-root `platforms/synthesized` (mirrors Python SYNTH_CAT = SKILLS_DIR / "synthesized")
function resolveSynthDir(): string {
  const cwd = process.cwd()
  const candidates = [
    join(cwd, "platforms", "synthesized"),
    join(cwd, "..", "..", "..", "platforms", "synthesized"),
    join(cwd, "packages", "..", "platforms", "synthesized"),
    join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "synthesized"),
  ]
  for (const p of candidates) {
    try {
      if (existsSync(dirname(p)) || existsSync(p)) return p
    } catch {}
  }
  return join(cwd, "platforms", "synthesized")
}

export interface SynthesizeOptions {
  capability_gap: string
  target_behavior?: string
  scaffold?: boolean
  implementation?: string | null
}

export interface SynthesizeResult {
  skill_name: string
  skillName: string
  status: "success" | "unverified" | "failed_validation"
  verified: boolean
  paths: { tool: string; md: string }
  research_summary: string
  scaffold: string
  skill_md: string
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "synthesized-skill"
}

function conductResearch(gap: string, behavior: string): string {
  return `No verified research was performed for '${gap}'. Target behavior: ${behavior}. A human must supply the real implementation and validation before this skill is usable.`
}

function generateImplementation(name: string, notes: string, implementation?: string | null): string {
  if (implementation) return implementation
  return `/** ${name} — ${UNVERIFIED_MARKER}

This tool has NO verified implementation. It is a scaffold produced by the
Mira SkillSynthesizer and MUST NOT be used until a human implements and
validates the real logic.

Research notes (unverified): ${notes}
*/

export function main(): never {
  throw new Error("${name} is an ${UNVERIFIED_MARKER} scaffold. Implement the real logic and remove this throw before use.");
}

if (import.meta.main) {
  main();
}
`
}

function generateSkillMd(name: string, gap: string, behavior: string, notes: string, scaffold = true): string {
  const statusLine = scaffold ? `status: ${UNVERIFIED_MARKER}` : `status: verified`
  const reviewSection = `## Human Review Required

This skill is an **${UNVERIFIED_MARKER}** scaffold. The tool has **no verified
implementation** — \`tool.ts\` throws \`NotImplementedError\` on purpose.

Before this skill may be used:

- [ ] A human must implement the real logic in \`tool.ts\`.
- [ ] The implementation must be validated against the target behavior.
- [ ] The \`status\` field in the frontmatter must be changed to \`verified\`.
- [ ] This section must be removed.
`
  return `---
name: ${name}
description: Use when ${gap}. ${behavior}.
version: 0.1.0
author: Mira-Synthesizer
license: MIT
${statusLine}
metadata:
  hermes:
    tags: [synthesized, mira, unverified]
    related_skills: []
---

# ${name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}

## Overview
This skill was scaffolded by Mira DCS to fill a capability gap.
Target behavior: ${behavior}

## When to Use
- Use when ${gap} is required.
- Do not use for tasks already covered by core platform tools.
- **Do not use this skill yet** — it is unverified.

## Implementation Details
The functionality is intended to live in \`tool.ts\`. Current state:
${notes}

${reviewSection}
`
}

function validateSkill(toolPath: string, _behavior: string): "success" | "unverified" | "failed_validation" {
  try {
    // Fast path: scaffold always contains UNVERIFIED marker → unverified (fail-closed)
    try {
      const content = readFileSync(toolPath, "utf-8")
      if (content.includes(UNVERIFIED_MARKER)) {
        // Try to run it — if it throws UNVERIFIED, confirm unverified; otherwise still unverified
        const res = spawnSync("bun", ["run", toolPath], { encoding: "utf-8", timeout: 10_000 })
        const combined = `${res.stdout ?? ""} ${res.stderr ?? ""}`
        if (res.status === 0) {
          // Even if exit 0, scaffold is unverified because it contains the marker
          return "unverified"
        }
        if (combined.includes(UNVERIFIED_MARKER) || combined.includes("NotImplementedError") || content.includes("NotImplementedError")) {
          return "unverified"
        }
        return "unverified"
      }
    } catch {}
    const res = spawnSync("bun", ["run", toolPath], { encoding: "utf-8", timeout: 10_000 })
    const combined = `${res.stdout ?? ""} ${res.stderr ?? ""}`
    if (res.status === 0) return "success"
    if (combined.includes("NotImplementedError") || combined.includes(UNVERIFIED_MARKER)) return "unverified"
    return "failed_validation"
  } catch {
    return "failed_validation"
  }
}

/**
 * Research -> scaffold -> SKILL.md (Human Review Required) -> validate
 * Port of `platforms/skill_synthesizer.py:38` SkillSynthesizer.synthesize_skill
 */
export async function synthesize_skill(
  gap: string | SynthesizeOptions | { gap: string; behavior?: string },
  targetBehavior?: string,
  scaffold = true,
  implementation: string | null = null,
): Promise<SynthesizeResult> {
  let capability_gap: string
  let target_behavior: string
  let optsScaffold = scaffold
  let optsImpl: string | null = implementation

  if (typeof gap === "string") {
    capability_gap = gap
    target_behavior = targetBehavior ?? gap
  } else if (gap && typeof gap === "object" && "capability_gap" in (gap as Record<string, unknown>)) {
    const o = gap as SynthesizeOptions
    capability_gap = o.capability_gap
    target_behavior = o.target_behavior ?? targetBehavior ?? capability_gap
    if (typeof o.scaffold === "boolean") optsScaffold = o.scaffold
    if (o.implementation !== undefined) optsImpl = o.implementation ?? null
  } else if (gap && typeof gap === "object" && "gap" in (gap as Record<string, unknown>)) {
    const o = gap as unknown as { gap: string; behavior?: string; target_behavior?: string }
    capability_gap = o.gap
    target_behavior = o.behavior ?? o.target_behavior ?? targetBehavior ?? capability_gap
  } else {
    capability_gap = String(gap)
    target_behavior = targetBehavior ?? capability_gap
  }

  const researchNotes = conductResearch(capability_gap, target_behavior)
  const skillName = slugify(capability_gap)
  const synthDir = resolveSynthDir()
  const skillDir = join(synthDir, skillName)
  mkdirSync(skillDir, { recursive: true })
  const toolPath = join(skillDir, "tool.ts")
  const mdPath = join(skillDir, "SKILL.md")

  const toolCode = generateImplementation(skillName, researchNotes, optsImpl)
  writeFileSync(toolPath, toolCode, "utf-8")

  const skillMd = generateSkillMd(skillName, capability_gap, target_behavior, researchNotes, optsScaffold)
  writeFileSync(mdPath, skillMd, "utf-8")

  const status = validateSkill(toolPath, target_behavior)

  return {
    skill_name: skillName,
    skillName,
    status,
    verified: status === "success",
    paths: { tool: toolPath, md: mdPath },
    research_summary: researchNotes,
    scaffold: skillMd,
    skill_md: skillMd,
  }
}

// camelCase aliases (ergonomics)
export const synthesizeSkill = synthesize_skill
export const synthesize_skill_alias = synthesize_skill

export default synthesize_skill
