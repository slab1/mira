/**
 * Brio — closed-set scoring via colibri (`POST /v1/brio`)
 *
 * Ports colibri's Brio mode (docs/brio.md) into Mira's tool surface.
 * Instead of generating, the model scores a fixed set of allowed options and
 * returns probabilities + normalized entropy (0..1). completion_tokens is 0.
 *
 * Three shapes (one of options/questions/schema required):
 *  - brio({ state, question, options: ["merge","request changes"] })
 *  - brio({ state, questions: [{question, options}] })
 *  - brio({ state, schema: { decision: ["merge","close"], risk: ["high","low"] }, task: "..." })
 *
 * Falls back to a helpful setup hint when colibri is not running.
 * Gateway: plain fetch to the colibri OpenAI-compatible baseURL (default http://127.0.0.1:8000/v1).
 */
import { z } from 'zod'
import type { ToolDef } from './registry.js'
import type { JsonValue } from '../types/index.js'
import { getConfig } from '../config/index.js'
import { expandEnv } from '../gateway/provider.js'

// ── Zod schema: one of options / questions / schema must be present ──
const questionItem = z.object({
  question: z.string().min(1).describe('Question about the state'),
  options: z.array(z.string().min(1)).min(2).max(64).describe('2-64 allowed answers for this question'),
  normalize: z.enum(['mean', 'sum']).optional().describe('Per-question length normalization (default mean)'),
})

const brioSchema = z
  .object({
    state: z.string().min(1).optional().describe('Document / PR description / ticket to decide on'),
    messages: z
      .array(z.object({ role: z.string(), content: z.string() }))
      .optional()
      .describe('Chat history used instead of state (for live-routing view)'),
    question: z.string().optional().describe('What to ask about the state (single-question mode)'),
    options: z
      .array(z.string().min(1))
      .min(2)
      .max(64)
      .optional()
      .describe('2-64 allowed answers (single-question mode)'),
    questions: z.array(questionItem).min(1).max(64).optional().describe('Many questions on one state'),
    schema: z
      .record(z.string(), z.array(z.string().min(1)).min(2).max(64))
      .optional()
      .describe('Fill a JSON object: field -> allowed values (2-64 per field)'),
    task: z.string().optional().describe('With schema, what the object is for'),
    model: z.string().optional().describe('colibri model id (default from config or qwen3.6)'),
    normalize: z.enum(['mean', 'sum']).optional().describe('Length normalization for options (default mean)'),
    cache_slot: z.number().int().min(0).max(15).optional().describe('KV slot 0-15 (default derived from state)'),
  })
  .superRefine((v, ctx) => {
    const hasOpts = !!v.options?.length
    const hasQs = !!v.questions?.length
    const hasSchema = !!v.schema && Object.keys(v.schema).length > 0
    const modeCount = [hasOpts, hasQs, hasSchema].filter(Boolean).length
    if (modeCount === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide one of: options (with question), questions[], or schema {}', path: ['options'] })
    }
    if (modeCount > 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Use only one of options / questions / schema per call', path: ['options'] })
    }
    if (hasOpts && !v.state && !v.messages?.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'state or messages required with options', path: ['state'] })
    }
    if (hasQs && !v.state && !v.messages?.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'state or messages required with questions', path: ['state'] })
    }
    if (hasSchema && !v.state && !v.messages?.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'state or messages required with schema', path: ['state'] })
    }
  })

type BrioInput = z.output<typeof brioSchema>

function colibriBaseURL(): { base: string; apiKey: string } {
  let base = 'http://127.0.0.1:8000/v1'
  let apiKey = 'local'
  try {
    const cfg = getConfig() as unknown as { provider?: Record<string, { options?: { baseURL?: string; apiKey?: string | string[] } }> }
    const p = cfg.provider?.colibri?.options
    if (p?.baseURL) base = expandEnv(p.baseURL)
    if (p?.apiKey) {
      const raw = Array.isArray(p.apiKey) ? p.apiKey[0] : p.apiKey
      if (raw) apiKey = expandEnv(raw)
    }
  } catch {}
  // normalize: strip trailing /v1 if user added, then ensure /v1
  base = base.replace(/\/$/, '')
  if (!base.endsWith('/v1')) base = `${base}/v1`
  // COLI_API_KEY env wins if set and apiKey is dummy
  if ((!apiKey || apiKey === 'local') && process.env.COLI_API_KEY) apiKey = process.env.COLI_API_KEY
  return { base, apiKey }
}

function colibriModel(fallback?: string): string {
  if (fallback) return fallback
  try {
    const cfg = getConfig() as unknown as { provider?: Record<string, { models?: Record<string, unknown> }> }
    const first = Object.keys(cfg.provider?.colibri?.models ?? {})[0]
    if (first) return first
  } catch {}
  return 'qwen3.6'
}

export const brioTool = {
  name: 'brio',
  description:
    'Score a closed set of options without generating (colibri Brio mode). Give state + options/questions/schema, get probabilities + entropy per choice (entropy 0..1: <0.4 confident, 0.4-0.8 unsure, >0.8 abstain). completion_tokens=0. Much cheaper than generation for triage, review, routing, JSON filling. Needs colibri server (COLI_MODEL=... ./coli serve --port 8000) or set provider.colibri.baseURL.',
  category: 'other',
  schema: brioSchema,
  async execute(input: BrioInput): Promise<JsonValue> {
    const { base, apiKey } = colibriBaseURL()
    const model = colibriModel(input.model)
    const body: Record<string, JsonValue> = {
      model,
      ...(input.state ? { state: input.state } : {}),
      ...(input.messages ? { messages: input.messages as JsonValue } : {}),
      ...(input.question ? { question: input.question } : {}),
      ...(input.options ? { options: input.options } : {}),
      ...(input.questions ? { questions: input.questions as unknown as JsonValue } : {}),
      ...(input.schema ? { schema: input.schema as unknown as JsonValue } : {}),
      ...(input.task ? { task: input.task } : {}),
      ...(input.normalize ? { normalize: input.normalize } : {}),
      ...(input.cache_slot !== undefined ? { cache_slot: input.cache_slot } : {}),
    }

    const url = `${base.replace(/\/v1$/, '')}/v1/brio`
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`

    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
    } catch (e) {
      return {
        ok: false,
        error: String(e),
        hint: 'Is colibri running? `COLI_MODEL=/data/olmoe ./colibri/c/coli serve --port 8000` (or set provider.colibri.baseURL). See https://github.com/JustVugg/colibri',
        baseURL: base,
        model,
      } as JsonValue
    }

    const text = await res.text()
    let json: JsonValue
    try {
      json = JSON.parse(text) as JsonValue
    } catch {
      json = text as JsonValue
    }

    if (!res.ok) {
      const isNotFound = res.status === 404
      return {
        ok: false,
        status: res.status,
        error: json,
        hint: isNotFound
          ? 'Endpoint /v1/brio not found — upgrade colibri (needs Brio-capable build) and ensure server was started with that model.'
          : `Colibri returned ${res.status}. Check model "${model}" is loaded and state/options are valid (see docs/brio.md).`,
        baseURL: base,
        url,
        model,
      } as JsonValue
    }

    // Enrich with entropy reading
    const entropyHint = (ent: number) => (ent < 0.4 ? 'confident' : ent < 0.8 ? 'unsure' : 'abstain — needs human')
    const j = json as Record<string, JsonValue>
    const enrich = (entry: Record<string, JsonValue>) => {
      const ent = typeof entry.entropy === 'number' ? (entry.entropy as number) : null
      if (ent !== null) (entry as Record<string, JsonValue>).entropy_reading = entropyHint(ent) as JsonValue
      return entry
    }
    if (Array.isArray(j.answers)) {
      j.answers = (j.answers as Array<Record<string, JsonValue>>).map(enrich) as JsonValue
    } else if (typeof j.entropy === 'number') {
      enrich(j as Record<string, JsonValue>)
    } else if (j.fields) {
      // schema mode
      const fields = j.fields as unknown as Record<string, Record<string, JsonValue>>
      for (const f of Object.values(fields)) enrich(f)
    }
    return { ok: true, baseURL: base, model, result: json } as JsonValue
  },
} satisfies ToolDef<typeof brioSchema>

export default brioTool
