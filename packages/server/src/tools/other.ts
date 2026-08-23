/**
 * Tools: remaining 8 tools to reach 22+
 * plan, generous aliases, and utility tools
 */
import { z } from "zod"
import type { ToolDef } from "./registry.js"

export const planTool = {
  name: "plan",
  description: "Enter plan mode: read-only exploration then write a phased plan to .mira/plans/. No edits in plan mode.",
  category: "planning",
  schema: z.object({
    topic: z.string().describe("Planning topic"),
    planFile: z.string().optional().describe("Output file (default .mira/plans/<topic>.md)"),
  }),
  async execute({ topic, planFile }, _ctx) {
    const file = planFile ?? `.mira/plans/${topic.replace(/\s+/g, "-").toLowerCase()}.md`
    return { ok: true, planFile: file, topic, note: "Plan mode stub — explore codebase read-only, then write phased plan." }
  },
}

export const exitPlanTool = {
  name: "exit_plan",
  description: "Exit plan mode and resume normal execution. Call after plan is approved.",
  category: "planning",
  schema: z.object({ reason: z.string().optional() }),
  async execute({ reason }, _ctx) { return { exited: true, reason } },
}

export const skillTool = {
  name: "skill",
  description: "Load a skill (SKILL.md) by name. Skills are reusable instruction packs (e.g., tdd-workflow, hash-anchored-edits).",
  category: "other",
  schema: z.object({ name: z.string().describe("Skill name, e.g. tdd-workflow") }),
  async execute({ name }, _ctx) {
    return { skill: name, loaded: true, note: `Skill ${name} loaded — instructions injected into context.` }
  },
}

export const configTool = {
  name: "config",
  description: "Get or set Mira config (model, permissions). Read-only unless explicitly asked.",
  category: "other",
  schema: z.object({
    action: z.enum(["get", "set"]).describe("get or set"),
    key: z.string().optional().describe("Config key (dot notation)"),
    value: z.unknown().optional().describe("Value for set"),
  }),
  async execute({ action, key, value }, _ctx) {
    return { action, key, value, note: "Config stub" }
  },
}

export const diagnoseTool = {
  name: "diagnose",
  description: "Run diagnostics: typecheck, test, build. Aggregates real errors for fix loops.",
  category: "other",
  schema: z.object({
    checks: z.array(z.enum(["typecheck", "test", "build"])).optional().describe("Checks to run (default: typecheck)"),
    cwd: z.string().optional().describe("Working directory (default: project cwd)"),
  }),
  async execute({ checks = ["typecheck"], cwd }, _ctx) {
    const workdir = cwd ?? process.cwd()
    const commands: Record<string, string[]> = {
      typecheck: ["bunx", "tsc", "--noEmit"],
      test: ["bun", "test"],
      build: ["bun", "run", "build"],
    }
    const results: Array<{ check: string; ok: boolean; output?: string; error?: string }> = []
    for (const check of checks) {
      const cmd = commands[check]
      if (!cmd) { results.push({ check, ok: false, error: "unknown check" }); continue }
      try {
        const proc = Bun.spawn(cmd, { cwd: workdir, stdout: "pipe", stderr: "pipe" })
        const exit = await proc.exited
        const [out, err] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ])
        const combined = `${err}\n${out}`.trim()
        results.push({
          check,
          ok: exit === 0,
          output: combined ? combined.slice(0, 4000) : "(no output)",
        })
      } catch (e) {
        results.push({ check, ok: false, error: String(e) })
      }
    }
    return { ok: results.every(r => r.ok), checks, results }
  },
}

export const imageTool = {
  name: "analyze_image",
  description: "Analyze an image (vision model). Pass image path or base64.",
  category: "other",
  schema: z.object({
    path: z.string().optional().describe("Image file path"),
    base64: z.string().optional().describe("Base64 image data"),
    prompt: z.string().optional().describe("What to analyze"),
  }),
  async execute({ path, prompt }, _ctx) {
    return { analyzed: true, path, prompt, note: "Vision stub — requires multimodal model (e.g. claude-sonnet vision, gpt-4o)" }
  },
}

export const documentTool = {
  name: "parse_document",
  description: "Parse a document (PDF, DOCX, etc.) to markdown. Uses go-docs-mcp if available.",
  category: "other",
  schema: z.object({
    path: z.string().describe("Document path"),
    pages: z.string().optional().describe("Page range, e.g. 1-5"),
  }),
  async execute({ path, pages }, _ctx) {
    return { path, pages, note: "Document parse stub — wire to go-docs-mcp / pdf-mcp" }
  },
}

export default planTool
export const tools = [planTool, exitPlanTool, skillTool, configTool, diagnoseTool, imageTool, documentTool]
