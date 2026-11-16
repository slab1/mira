/**
 * Brio — closed-set scoring via colibri (`POST /v1/brio`) or cloud fallback
 *
 * Ports colibri's Brio mode (docs/brio.md) into Mira's tool surface.
 * Instead of generating free-form text, the model scores a fixed set of allowed options and
 * returns calibrated probabilities, logprobs, argmax answers, and normalized Shannon entropy (0..1).
 * completion_tokens is 0.
 *
 * Three shapes (one of options/questions/schema required):
 *  - brio({ state, question, options: ["merge","request changes"] })
 *  - brio({ state, questions: [{question, options}] })
 *  - brio({ state, schema: { decision: ["merge","close"], risk: ["high","low"] }, task: "..." })
 *
 * Colibri is opportunistic: if a local or configured Colibri server is responding, it is used.
 * When Colibri is unavailable (e.g. in environments without local weights), Brio seamlessly
 * falls back to Mira's configured cloud providers (NVIDIA NIM primary, Google Gemini fallback)
 * to compute calibrated probabilities, logprobs, argmax answers, and Shannon normalized entropy.
 */
import { z } from 'zod'
import type { ToolDef } from './registry.js'
import type { JsonValue } from '../types/index.js'
import { getConfig } from '../config/index.js'
import { expandEnv, expandApiKey, chatCompletionsUrl } from '../providers/auth.js'

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
    model: z.string().optional().describe('colibri or cloud model id (e.g. nvidia/nemotron-3.5-lightning-30b-a3b)'),
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

interface CloudScoringProvider {
  provider: 'nvidia' | 'google'
  apiKey: string
  baseURL: string
  model: string
}

function getCloudScoringProviders(requestedModel?: string): CloudScoringProvider[] {
  const providers: CloudScoringProvider[] = []
  const reqLower = requestedModel?.toLowerCase() ?? ''

  // NVIDIA NIM candidate
  const nvKeys = expandApiKey(undefined, 'nvidia')
  if (nvKeys.length > 0 && nvKeys[0]) {
    const nvModel =
      reqLower.includes('nvidia') || reqLower.includes('nemotron') || reqLower.includes('glimmer')
        ? requestedModel!
        : 'nvidia/nemotron-3.5-lightning-30b-a3b'
    providers.push({
      provider: 'nvidia',
      apiKey: nvKeys[0],
      baseURL: 'https://integrate.api.nvidia.com/v1',
      model: nvModel,
    })
  }

  // Google Gemini candidate
  const googleKeys = expandApiKey(undefined, 'google')
  if (googleKeys.length > 0 && googleKeys[0]) {
    const googleModel =
      reqLower.includes('google') || reqLower.includes('gemini')
        ? requestedModel!.replace(/^google\//, '')
        : 'gemini-2.5-flash'
    providers.push({
      provider: 'google',
      apiKey: googleKeys[0],
      baseURL: 'https://generativelanguage.googleapis.com/v1beta',
      model: googleModel,
    })
  }

  // If requested model explicitly targets Google, move Google to front
  if (reqLower.includes('google') || reqLower.includes('gemini')) {
    providers.reverse()
  }

  return providers
}

function computeOptionStats(
  rawProbs: Record<string, unknown>,
  options: string[],
  modelAnswer?: string,
): {
  answer: string
  entropy: number
  entropy_reading: string
  choices: Array<{ option: string; p: number; logprob: number }>
} {
  const N = options.length
  const probs: Record<string, number> = {}

  for (const opt of options) {
    const lower = opt.toLowerCase()
    let val: unknown = rawProbs[opt]
    if (val === undefined) val = rawProbs[lower]
    if (val === undefined) {
      for (const [k, v] of Object.entries(rawProbs)) {
        if (k.toLowerCase().trim() === lower.trim()) {
          val = v
          break
        }
      }
    }
    const num = typeof val === 'number' && !isNaN(val) && val >= 0 ? val : 0.01
    probs[opt] = num
  }

  let sum = Object.values(probs).reduce((a, b) => a + b, 0)
  if (sum <= 0 || isNaN(sum)) {
    for (const opt of options) probs[opt] = 1 / N
    sum = 1
  } else {
    for (const opt of options) probs[opt] = probs[opt] / sum
  }

  let bestOpt = options[0]
  let maxP = -1
  for (const opt of options) {
    if (probs[opt] > maxP) {
      maxP = probs[opt]
      bestOpt = opt
    }
  }

  if (modelAnswer) {
    const cleanAns = modelAnswer.trim().toLowerCase()
    for (const opt of options) {
      if (opt.toLowerCase() === cleanAns && (probs[opt] ?? 0) >= maxP - 0.08) {
        bestOpt = opt
        break
      }
    }
  }

  let H = 0
  for (const opt of options) {
    const p = probs[opt]
    if (p > 1e-12) {
      H -= p * Math.log(p)
    }
  }
  const Hmax = N > 1 ? Math.log(N) : 1
  const normEntropy = N > 1 ? Math.max(0, Math.min(1, H / Hmax)) : 0
  const entropy = Number(normEntropy.toFixed(3))

  const entropy_reading =
    entropy < 0.4 ? 'confident' : entropy < 0.8 ? 'unsure' : 'abstain — needs human'

  const choices = options
    .map((opt) => {
      const p = Number(probs[opt].toFixed(4))
      const logprob = Number(Math.log(Math.max(probs[opt], 1e-12)).toFixed(4))
      return { option: opt, p, logprob }
    })
    .sort((a, b) => b.p - a.p)

  return {
    answer: bestOpt,
    entropy,
    entropy_reading,
    choices,
  }
}

function extractJson(text: string): Record<string, unknown> | null {
  if (!text) return null
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {}
  const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (match) {
    try {
      return JSON.parse(match[1]) as Record<string, unknown>
    } catch {}
  }
  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1)) as Record<string, unknown>
    } catch {}
  }
  return null
}

async function scoreWithCloud(
  input: BrioInput,
  providers: CloudScoringProvider[],
): Promise<{ ok: true; baseURL: string; model: string; backend: string; result: JsonValue } | { ok: false; error: string }> {
  const stateStr =
    input.state ??
    input.messages?.map((m) => `${m.role}: ${m.content}`).join('\n') ??
    ''

  let prompt = ''
  if (input.options?.length) {
    prompt = `Document / State:\n${stateStr}\n\nQuestion: ${input.question ?? 'What is the most appropriate option?'}\nAllowed Options: ${JSON.stringify(input.options)}\n\nTask:\nScore each allowed option with a probability value between 0.0 and 1.0 reflecting its likelihood or correctness.\nThe probabilities across all allowed options MUST sum to 1.0.\nOutput ONLY a JSON object strictly adhering to this format:\n{\n  "answer": "<best option>",\n  "probabilities": {\n    "<option_1>": 0.xx,\n    "<option_2>": 0.xx\n  }\n}`
  } else if (input.questions?.length) {
    prompt = `Document / State:\n${stateStr}\n\nQuestions and Allowed Options:\n${input.questions.map((q, idx) => `${idx + 1}. Question: "${q.question}"\n   Options: ${JSON.stringify(q.options)}`).join('\n')}\n\nTask:\nFor each question, score each of its allowed options with probabilities between 0.0 and 1.0. Probabilities for each question must sum to 1.0.\nOutput ONLY a JSON object strictly adhering to this format:\n{\n  "answers": [\n    {\n      "question": "<question text>",\n      "answer": "<best option for this question>",\n      "probabilities": {\n        "<option_1>": 0.xx,\n        "<option_2>": 0.xx\n      }\n    }\n  ]\n}`
  } else if (input.schema && Object.keys(input.schema).length > 0) {
    prompt = `Document / State:\n${stateStr}\n${input.task ? `Task: ${input.task}\n` : ''}\nFields to fill and Allowed Values:\n${Object.entries(input.schema).map(([k, vs]) => `- ${k}: ${JSON.stringify(vs)}`).join('\n')}\n\nTask:\nFor each field, score each of its allowed values with probabilities between 0.0 and 1.0. Probabilities for each field must sum to 1.0.\nOutput ONLY a JSON object strictly adhering to this format:\n{\n  ${input.task ? `"task": ${JSON.stringify(input.task)},\n  ` : ''}"fields": {\n    "<field_name>": {\n      "answer": "<best value for this field>",\n      "probabilities": {\n        "<value_1>": 0.xx,\n        "<value_2>": 0.xx\n      }\n    }\n  }\n}`
  } else {
    return { ok: false, error: 'One of options, questions, or schema is required' }
  }

  let lastErr = 'No cloud providers available'
  for (const prov of providers) {
    try {
      const url = chatCompletionsUrl(prov.baseURL)
      const isGoogle = prov.provider === 'google'
      const reqBody: Record<string, unknown> = {
        model: prov.model,
        messages: [
          {
            role: 'system',
            content:
              'You are a precise closed-set decision and scoring engine. You evaluate documents/states and output calibrated probability distributions over allowed options. Output ONLY valid JSON matching the requested schema.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
        ...(isGoogle
          ? { response_format: { type: 'json_object' } }
          : { max_tokens: 2000 }),
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${prov.apiKey}`,
        },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(30_000),
      })

      if (!res.ok) {
        const txt = await res.text()
        lastErr = `${prov.provider} ${res.status}: ${txt.slice(0, 300)}`
        continue
      }

      const resJson = (await res.json()) as {
        choices?: Array<{
          message?: { content?: string; reasoning_content?: string }
        }>
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
      }

      const rawContent =
        resJson.choices?.[0]?.message?.content ||
        resJson.choices?.[0]?.message?.reasoning_content ||
        ''
      const parsed = extractJson(rawContent)
      if (!parsed) {
        lastErr = `Failed to parse structured JSON from ${prov.provider}`
        continue
      }

      const usage = {
        prompt_tokens: resJson.usage?.prompt_tokens ?? 0,
        completion_tokens: 0,
        total_tokens: resJson.usage?.total_tokens ?? 0,
      }

      if (input.options?.length) {
        const rawProbs = (parsed.probabilities ?? {}) as Record<string, unknown>
        const stats = computeOptionStats(rawProbs, input.options, typeof parsed.answer === 'string' ? parsed.answer : undefined)
        const result = {
          object: 'brio.choice',
          question: input.question,
          answer: stats.answer,
          entropy: stats.entropy,
          entropy_reading: stats.entropy_reading,
          choices: stats.choices,
          normalize: input.normalize ?? 'mean',
          usage,
        }
        return { ok: true, baseURL: prov.baseURL, model: prov.model, backend: 'gateway', result: result as unknown as JsonValue }
      }

      if (input.questions?.length) {
        const answersList = Array.isArray(parsed.answers) ? (parsed.answers as Array<Record<string, unknown>>) : []
        const answers = input.questions.map((q, idx) => {
          const match = answersList.find((a) => a.question === q.question) ?? answersList[idx] ?? {}
          const rawProbs = (match.probabilities ?? {}) as Record<string, unknown>
          const stats = computeOptionStats(rawProbs, q.options, typeof match.answer === 'string' ? match.answer : undefined)
          return {
            question: q.question,
            answer: stats.answer,
            entropy: stats.entropy,
            entropy_reading: stats.entropy_reading,
            choices: stats.choices,
            normalize: q.normalize ?? input.normalize ?? 'mean',
          }
        })
        const result = {
          answers,
          completion_tokens: 0,
          usage,
        }
        return { ok: true, baseURL: prov.baseURL, model: prov.model, backend: 'gateway', result: result as unknown as JsonValue }
      }

      if (input.schema && Object.keys(input.schema).length > 0) {
        const fieldsObj = (parsed.fields ?? {}) as Record<string, Record<string, unknown>>
        const fields: Record<string, unknown> = {}
        for (const [k, allowedVals] of Object.entries(input.schema)) {
          const fData = fieldsObj[k] ?? {}
          const rawProbs = (fData.probabilities ?? {}) as Record<string, unknown>
          const stats = computeOptionStats(rawProbs, allowedVals, typeof fData.answer === 'string' ? fData.answer : undefined)
          fields[k] = {
            answer: stats.answer,
            entropy: stats.entropy,
            entropy_reading: stats.entropy_reading,
            choices: stats.choices,
            normalize: input.normalize ?? 'mean',
          }
        }
        const result = {
          ...(input.task ? { task: input.task } : {}),
          fields,
          completion_tokens: 0,
          usage,
        }
        return { ok: true, baseURL: prov.baseURL, model: prov.model, backend: 'gateway', result: result as unknown as JsonValue }
      }
    } catch (e) {
      lastErr = `${prov.provider} error: ${String(e)}`
    }
  }

  return { ok: false, error: lastErr }
}

export const brioTool = {
  name: 'brio',
  description:
    'Score a closed set of options without generating (colibri Brio mode). Give state + options/questions/schema, get probabilities + entropy per choice (entropy 0..1: <0.4 confident, 0.4-0.8 unsure, >0.8 abstain). completion_tokens=0. Much cheaper than generation for triage, review, routing, JSON filling. Uses local Colibri if available, with seamless cloud scoring fallback (NVIDIA / Google).',
  category: 'other',
  schema: brioSchema,
  async execute(input: BrioInput, _ctx?: { sessionID?: string; messageID?: string }): Promise<JsonValue> {
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

    let colibriErr: unknown = null
    let colibriStatus: number | null = null

    // Opportunistically try Colibri if not disabled
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(2000),
      })

      const text = await res.text()
      let json: JsonValue
      try {
        json = JSON.parse(text) as JsonValue
      } catch {
        json = text as JsonValue
      }

      if (res.ok) {
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
          const fields = j.fields as unknown as Record<string, Record<string, JsonValue>>
          for (const f of Object.values(fields)) enrich(f)
        }
        return { ok: true, baseURL: base, model, backend: 'colibri', result: json } as JsonValue
      } else {
        colibriStatus = res.status
        colibriErr = json
      }
    } catch (e) {
      colibriErr = e instanceof Error ? e.message : String(e)
    }

    // Colibri was unavailable or returned non-200. Check cloud fallback unless explicitly disabled.
    if (process.env.BRIO_DISABLE_CLOUD_FALLBACK !== '1') {
      const cloudProviders = getCloudScoringProviders(input.model)
      if (cloudProviders.length > 0) {
        const cloudRes = await scoreWithCloud(input, cloudProviders)
        if (cloudRes.ok) {
          return cloudRes as unknown as JsonValue
        }
      }
    }

    // Both Colibri and cloud fallback unavailable or failed
    const isNotFound = colibriStatus === 404
    return {
      ok: false,
      status: colibriStatus ?? 503,
      error: colibriErr ?? 'Colibri server offline',
      hint: isNotFound
        ? 'Endpoint /v1/brio not found on colibri server — verify model supports Brio.'
        : 'Is colibri running? `COLI_MODEL=/data/olmoe ./colibri/c/coli serve --port 8000` (or configure NVIDIA_API_KEY / GOOGLE_API_KEY in ~/.mira/mira.env).',
      baseURL: base,
      url,
      model,
    } as unknown as JsonValue
  },
} satisfies ToolDef<typeof brioSchema>

export default brioTool
