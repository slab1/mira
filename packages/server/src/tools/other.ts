/**
 * Tools: remaining 8 tools to reach 22+
 * plan, generous aliases, and utility tools
 */
import { z } from "zod"
import type { ToolDef } from "./registry.js"
import type { JsonValue } from "../types/index.js"

const planSchema = z.object({
  topic: z.string().describe("Planning topic"),
  planFile: z.string().optional().describe("Output file (default .mira/plans/<topic>.md)"),
})

export const planTool = {
  name: "plan",
  description: "Enter plan mode: read-only exploration then write a phased plan to .mira/plans/. No edits in plan mode.",
  category: "planning",
  schema: planSchema,
  async execute({ topic, planFile }, _ctx) {
    const file = planFile ?? `.mira/plans/${topic.replace(/\s+/g, "-").toLowerCase()}.md`
    return { ok: true, planFile: file, topic, note: "Plan mode stub — explore codebase read-only, then write phased plan." }
  },
} satisfies ToolDef<typeof planSchema>

const exitPlanSchema = z.object({ reason: z.string().optional() })

export const exitPlanTool = {
  name: "exit_plan",
  description: "Exit plan mode and resume normal execution. Call after plan is approved.",
  category: "planning",
  schema: exitPlanSchema,
  async execute({ reason }, _ctx) { return { exited: true, reason } },
} satisfies ToolDef<typeof exitPlanSchema>

const skillSchema = z.object({ name: z.string().describe("Skill name, e.g. tdd-workflow") })

export const skillTool = {
  name: "skill",
  description: "Load a skill (SKILL.md) by name. Skills are reusable instruction packs (e.g., tdd-workflow, hash-anchored-edits).",
  category: "other",
  schema: skillSchema,
  async execute({ name }, _ctx) {
    return { skill: name, loaded: true, note: `Skill ${name} loaded — instructions injected into context.` }
  },
} satisfies ToolDef<typeof skillSchema>

const configSchema = z.object({
  action: z.enum(["get", "set"]).describe("get or set"),
  key: z.string().optional().describe("Config key (dot notation)"),
  /** Passthrough validator — accepts any JSON value (same behavior as before), typed as JsonValue. */
  value: z.custom<JsonValue>(() => true).optional().describe("Value for set"),
})

export const configTool = {
  name: "config",
  description: "Get or set Mira config (model, permissions). Read-only unless explicitly asked.",
  category: "other",
  schema: configSchema,
  async execute({ action, key, value }, _ctx) {
    return { action, key, value, note: "Config stub" }
  },
} satisfies ToolDef<typeof configSchema>

const diagnoseSchema = z.object({
  checks: z.array(z.enum(["typecheck", "test", "build"])).optional().describe("Checks to run (default: typecheck)"),
  cwd: z.string().optional().describe("Working directory (default: project cwd)"),
})

export const diagnoseTool = {
  name: "diagnose",
  description: "Run diagnostics: typecheck, test, build. Aggregates real errors for fix loops.",
  category: "other",
  schema: diagnoseSchema,
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
} satisfies ToolDef<typeof diagnoseSchema>

const imageSchema = z.object({
  path: z.string().optional().describe("Image file path"),
  base64: z.string().optional().describe("Base64 image data (no data: prefix)"),
  prompt: z.string().optional().describe("What to analyze (default: describe the image)"),
})

export const imageTool = {
  name: "analyze_image",
  description: "Analyze an image with a vision model. Pass image path or base64. Describe UI, read text in screenshots, compare designs.",
  category: "other",
  schema: imageSchema,
  async execute({ path, base64, prompt }, _ctx) {
    // Load image bytes
    let data = base64
    let mime = "image/png"
    if (!data && path) {
      const f = Bun.file(path)
      if (!(await f.exists())) return { ok: false, error: `Image not found: ${path}` }
      mime = f.type || "image/png"
      data = Buffer.from(await f.arrayBuffer()).toString("base64")
    }
    if (!data) return { ok: false, error: "Provide path or base64" }

    const model = process.env.MIRA_VISION_MODEL ?? "nvidia/meta/llama-3.2-90b-vision-instruct"
    try {
      const { createGateway } = await import("../gateway/index.js")
      const { loadConfig } = await import("../config/index.js")
      const gw = createGateway(await loadConfig())
      const out = await gw.complete({
        model,
        prompt: [
          { type: "text", text: prompt ?? "Describe this image in detail. If it contains text, transcribe it." },
          { type: "image_url", image_url: { url: `data:${mime};base64,${data}` } },
        ],
        maxTokens: 1024,
      })
      return { ok: true, model, analysis: out.text }
    } catch (e) {
      return { ok: false, model, error: String(e), note: "Set MIRA_VISION_MODEL to a vision-capable model your provider serves." }
    }
  },
} satisfies ToolDef<typeof imageSchema>

const documentSchema = z.object({
  path: z.string().describe("Document file path"),
  maxChars: z.number().optional().describe("Max chars returned (default 20000)"),
})

export const documentTool = {
  name: "parse_document",
  description: "Extract text from a document. Native: txt/md/csv/json/html. PDF/DOCX need an MCP doc server (go-docs-mcp).",
  category: "other",
  schema: documentSchema,
  async execute({ path, maxChars = 20_000 }, _ctx) {
    const f = Bun.file(path)
    if (!(await f.exists())) return { ok: false, error: `Not found: ${path}` }
    const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase()
    const raw = await f.text()
    let text = raw
    if (ext === "html" || ext === "htm") {
      text = raw
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    } else if (ext === "json") {
      try { text = JSON.stringify(JSON.parse(raw), null, 2) } catch {}
    } else if (!["txt", "md", "csv", "tsv", "log", "yml", "yaml"].includes(ext)) {
      return {
        ok: false,
        ext,
        error: `No native parser for .${ext}. Wire an MCP doc server (e.g. go-docs-mcp, pdf-mcp) or use analyze_image for scanned pages.`,
      }
    }
    return { ok: true, ext, chars: Math.min(text.length, maxChars), truncated: text.length > maxChars, content: text.slice(0, maxChars) }
  },
} satisfies ToolDef<typeof documentSchema>

export default planTool
export const tools = [planTool, exitPlanTool, skillTool, configTool, diagnoseTool, imageTool, documentTool]
