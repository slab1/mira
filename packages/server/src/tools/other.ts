/**
 * Tools: remaining 8 tools to reach 22+
 * plan, generous aliases, and utility tools
 */
import { z } from 'zod'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { ToolDef } from './registry.js'
import type { JsonValue, MiraConfig } from '../types/index.js'
import { getConfig, saveConfig } from '../config/index.js'
import { loadSkills } from '../skills/loader.js'

const planSchema = z.object({
  topic: z.string().describe('Planning topic'),
  planFile: z.string().optional().describe('Output file (default .mira/plans/<topic>.md)'),
})

export const planTool = {
  name: 'plan',
  description:
    'Write a phased plan to .mira/plans/ for a topic. Plan mode is advisory (read-only exploration recommended before finalizing); the permission system governs all tool calls.',
  category: 'planning',
  schema: planSchema,
  async execute({ topic, planFile }, ctx) {
    const cwd = ctx.cwd ?? process.cwd()
    const file = planFile ?? `.mira/plans/${topic.replace(/\s+/g, '-').toLowerCase()}.md`
    const abs = resolve(cwd, file)
    let wrote = false
    if (!existsSync(abs)) {
      const content = [
        `# Plan: ${topic}`,
        '',
        `> Created ${new Date().toISOString()} — plan mode (read-only exploration, then execute after approval)`,
        '',
        '## Goal',
        '',
        `- ${topic}`,
        '',
        '## Exploration (read-only)',
        '',
        '- [ ] Scan relevant files, types, and existing patterns',
        '- [ ] Verify current behavior and tests',
        '- [ ] Note constraints and conventions',
        '',
        '## Phases',
        '',
        '1. **Explore** — locate all touch points (read-only).',
        '2. **Implement** — minimal diff following existing conventions.',
        '3. **Verify** — run typecheck + shadow tests.',
        '',
        '## Open questions',
        '',
        '- ',
        '',
      ].join('\n')
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, content, 'utf-8')
      wrote = true
    }
    return {
      ok: true,
      planFile: abs,
      topic,
      note: wrote
        ? `Wrote plan skeleton to ${abs}. Explore read-only, then refine the phases with concrete steps before exiting plan mode.`
        : `Plan file already exists at ${abs} — review it and refine rather than overwriting.`,
    }
  },
} satisfies ToolDef<typeof planSchema>

const exitPlanSchema = z.object({ reason: z.string().optional() })

export const exitPlanTool = {
  name: 'exit_plan',
  description: 'End the plan phase and resume normal execution once the plan is approved.',
  category: 'planning',
  schema: exitPlanSchema,
  async execute({ reason }, _ctx) {
    return {
      exited: true,
      reason: reason ?? 'plan approved',
      note: 'Plan mode ended — normal execution resumes. Plan mode is advisory: the permission system governs all tool calls.',
    }
  },
} satisfies ToolDef<typeof exitPlanSchema>

const skillSchema = z.object({ name: z.string().describe('Skill name, e.g. tdd-workflow') })

export const skillTool = {
  name: 'skill',
  description:
    'Load a skill (SKILL.md) by name and return its instructions to evaluate. Skills are reusable instruction packs (e.g., tdd-workflow, hash-anchored-edits).',
  category: 'other',
  schema: skillSchema,
  async execute({ name }, _ctx) {
    const skills = await loadSkills()
    const skill = skills[name]
    if (!skill) {
      return {
        skill: name,
        loaded: false,
        available: Object.keys(skills).sort(),
        error: `Unknown skill "${name}" — pass one of the available skill names.`,
      }
    }
    return {
      skill: name,
      loaded: true,
      description: skill.description,
      instructions: skill.instructions.slice(0, 8000),
      note: `Skill "${name}" instructions returned above — they are now part of this tool result context.`,
    }
  },
} satisfies ToolDef<typeof skillSchema>

const configSchema = z.object({
  action: z.enum(['get', 'set']).describe('get or set'),
  key: z.string().optional().describe('Config key (dot notation)'),
  /** Passthrough validator — accepts any JSON value (same behavior as before), typed as JsonValue. */
  value: z
    .custom<JsonValue>(() => true)
    .optional()
    .describe('Value for set'),
})

/** Resolve a dot-notation path against a JSON tree. */
function getByPath(root: JsonValue, key: string): JsonValue | undefined {
  let cur: JsonValue | undefined = root
  for (const part of key.split('.')) {
    if (typeof cur !== 'object' || cur === null || Array.isArray(cur)) return undefined
    cur = cur[part]
  }
  return cur
}

/** Serialize a typed value into JsonValue (plain JSON round-trip — the canonical widening in this codebase). */
function toJsonValue(v: object): JsonValue {
  return JSON.parse(JSON.stringify(v)) as JsonValue
}

export const configTool = {
  name: 'config',
  description:
    "Get or set Mira config (model, permissions, provider keys). Read-only unless action is 'set'.",
  category: 'other',
  schema: configSchema,
  async execute({ action, key, value }, ctx) {
    const cwd = ctx.cwd ?? process.cwd()
    if (action === 'get') {
      const cfg = toJsonValue(getConfig())
      if (!key) return { action, ok: true, config: cfg }
      const resolved = getByPath(cfg, key)
      return { action, ok: true, key, value: resolved === undefined ? null : resolved }
    }
    // set
    if (!key || key.trim() === '') {
      return {
        action,
        ok: false,
        error:
          "set requires a dot-notation key and a value, e.g. { action: 'set', key: 'model', value: 'openrouter/anthropic/claude-sonnet-4' }",
      }
    }
    const parts = key.trim().split('.')
    const root: Record<string, JsonValue | undefined> = {}
    let slot: Record<string, JsonValue | undefined> = root
    for (let i = 0; i < parts.length; i++) {
      if (i < parts.length - 1) {
        const next: Record<string, JsonValue | undefined> = {}
        slot[parts[i]] = next
        slot = next
      } else {
        slot[parts[i]] = value ?? null
      }
    }
    const updated = await saveConfig(root as Partial<MiraConfig>, 'project', cwd)
    return {
      action,
      ok: true,
      key,
      value,
      config: toJsonValue(updated),
      note: `Saved to ${cwd}/mira.json`,
    }
  },
} satisfies ToolDef<typeof configSchema>

const diagnoseSchema = z.object({
  checks: z
    .array(z.enum(['typecheck', 'test', 'build']))
    .optional()
    .describe('Checks to run (default: typecheck)'),
  cwd: z.string().optional().describe('Working directory (default: project cwd)'),
})

export const diagnoseTool = {
  name: 'diagnose',
  description: 'Run diagnostics: typecheck, test, build. Aggregates real errors for fix loops.',
  category: 'other',
  schema: diagnoseSchema,
  async execute({ checks = ['typecheck'], cwd }, _ctx) {
    const workdir = cwd ?? process.cwd()
    const commands: Record<string, string[]> = {
      typecheck: ['bunx', 'tsc', '--noEmit'],
      test: ['bun', 'test'],
      build: ['bun', 'run', 'build'],
    }
    const results: Array<{ check: string; ok: boolean; output?: string; error?: string }> = []
    for (const check of checks) {
      const cmd = commands[check]
      if (!cmd) {
        results.push({ check, ok: false, error: 'unknown check' })
        continue
      }
      try {
        const proc = Bun.spawn(cmd, { cwd: workdir, stdout: 'pipe', stderr: 'pipe' })
        const exit = await proc.exited
        const [out, err] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ])
        const combined = `${err}\n${out}`.trim()
        results.push({
          check,
          ok: exit === 0,
          output: combined ? combined.slice(0, 4000) : '(no output)',
        })
      } catch (e) {
        results.push({ check, ok: false, error: String(e) })
      }
    }
    return { ok: results.every((r) => r.ok), checks, results }
  },
} satisfies ToolDef<typeof diagnoseSchema>

const imageSchema = z.object({
  path: z.string().optional().describe('Image file path'),
  base64: z.string().optional().describe('Base64 image data (no data: prefix)'),
  prompt: z.string().optional().describe('What to analyze (default: describe the image)'),
})

export const imageTool = {
  name: 'analyze_image',
  description:
    'Analyze an image with a vision model. Pass image path or base64. Describe UI, read text in screenshots, compare designs.',
  category: 'other',
  schema: imageSchema,
  async execute({ path, base64, prompt }, _ctx) {
    // Load image bytes
    let data = base64
    let mime = 'image/png'
    if (!data && path) {
      const f = Bun.file(path)
      if (!(await f.exists())) return { ok: false, error: `Image not found: ${path}` }
      mime = f.type || 'image/png'
      data = Buffer.from(await f.arrayBuffer()).toString('base64')
    }
    if (!data) return { ok: false, error: 'Provide path or base64' }

    const model = process.env.MIRA_VISION_MODEL ?? 'nvidia/meta/llama-3.2-90b-vision-instruct'
    try {
      const { createGateway } = await import('../gateway/index.js')
      const { loadConfig } = await import('../config/index.js')
      const gw = createGateway(await loadConfig())
      const out = await gw.complete({
        model,
        prompt: [
          {
            type: 'text',
            text: prompt ?? 'Describe this image in detail. If it contains text, transcribe it.',
          },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } },
        ],
        maxTokens: 1024,
      })
      return { ok: true, model, analysis: out.text }
    } catch (e) {
      return {
        ok: false,
        model,
        error: String(e),
        note: 'Set MIRA_VISION_MODEL to a vision-capable model your provider serves.',
      }
    }
  },
} satisfies ToolDef<typeof imageSchema>

const documentSchema = z.object({
  path: z.string().describe('Document file path'),
  maxChars: z.number().optional().describe('Max chars returned (default 20000)'),
})

export const documentTool = {
  name: 'parse_document',
  description:
    'Extract text from a document. Native: txt/md/csv/json/html. PDF/DOCX need an MCP doc server (go-docs-mcp).',
  category: 'other',
  schema: documentSchema,
  async execute({ path, maxChars = 20_000 }, _ctx) {
    const f = Bun.file(path)
    if (!(await f.exists())) return { ok: false, error: `Not found: ${path}` }
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
    const raw = await f.text()
    let text = raw
    if (ext === 'html' || ext === 'htm') {
      text = raw
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    } else if (ext === 'json') {
      try {
        text = JSON.stringify(JSON.parse(raw), null, 2)
      } catch {}
    } else if (!['txt', 'md', 'csv', 'tsv', 'log', 'yml', 'yaml'].includes(ext)) {
      return {
        ok: false,
        ext,
        error: `No native parser for .${ext}. Wire an MCP doc server (e.g. go-docs-mcp, pdf-mcp) or use analyze_image for scanned pages.`,
      }
    }
    return {
      ok: true,
      ext,
      chars: Math.min(text.length, maxChars),
      truncated: text.length > maxChars,
      content: text.slice(0, maxChars),
    }
  },
} satisfies ToolDef<typeof documentSchema>

export default planTool
export const tools = [
  planTool,
  exitPlanTool,
  skillTool,
  configTool,
  diagnoseTool,
  imageTool,
  documentTool,
]
