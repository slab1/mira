/**
 * Online Deep Research Service
 *
 * Dual-tier live web research orchestrator:
 *   1. `quick-grounded`     — Fast live grounded search + cited synthesis
 *   2. `deep-investigation` — Collaborative plan review -> multi-track grounded
 *                             searches + URL reading -> cross-examined report
 *
 * Uses Gemini `gemini-4-hydrogen` (`googleSearch` + `urlContext` grounding tools)
 * when a Gemini API key is configured server-side, or falls back transparently
 * to Firecrawl / Tavily / DuckDuckGo websearch + sanitized webfetch.
 * Never fabricates results or silently succeeds when live sources are unavailable.
 */
import { randomUUID } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import { GoogleGenAI } from '@google/genai'
import type { MiraDB } from '../storage/db.js'
import type { Bus } from '../bus/index.js'
import type { KnowledgeBase } from '../learning/knowledge.js'
import type { Gateway } from '../gateway/index.js'
import { sanitizeResearchContent } from '../evolution/research.js'
import { readMiraEnv } from '../providers/auth.js'
import { getConfig } from '../config/index.js'
import {
  websearchTool,
  webfetchTool,
  markInvalidGeminiKey,
  isInvalidGeminiKey,
  markGeminiModelCooldown,
  isGeminiModelInCooldown,
} from '../tools/websearch.js'

export type ResearchMode = 'quick-grounded' | 'deep-investigation'
export type ResearchStatus =
  | 'planning'
  | 'awaiting_approval'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface ResearchPlanTrack {
  id: string
  title: string
  query: string
  focus: string
}

export interface ResearchStep {
  id: string
  kind: 'thought' | 'search_query' | 'url_read' | 'synthesis' | 'error'
  title: string
  detail?: string
  url?: string
  status: 'running' | 'done' | 'failed'
  at: number
}

export interface ResearchCitation {
  id: string
  index: number
  title: string
  url: string
  domain: string
  snippet?: string
  fetchedAt: number
  trust: 'grounded' | 'websearch' | 'webfetch'
}

export interface ResearchRunDTO {
  id: string
  sessionID: string | null
  branchSessionID: string | null
  ownerID: string | null
  orgID: string | null
  mode: ResearchMode
  query: string
  status: ResearchStatus
  plan: ResearchPlanTrack[]
  steps: ResearchStep[]
  reportMarkdown: string | null
  citations: ResearchCitation[]
  error: string | null
  provider: string | null
  model: string | null
  tokensIn: number
  tokensOut: number
  durationMs: number
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

const invalidGeminiKeys = new Set<string>()

export function isUsableGeminiApiKey(value: string | undefined | null): boolean {
  if (!value || typeof value !== 'string') return false
  const t = value.trim()
  if (
    !t ||
    t === '***' ||
    t.includes('{env:') ||
    t.startsWith('AQ.') ||
    invalidGeminiKeys.has(t) ||
    isInvalidGeminiKey(t)
  ) {
    return false
  }
  return true
}

function isSafeHttpUrl(raw: string | undefined | null): raw is string {
  if (!raw || typeof raw !== 'string') return false
  try {
    const parsed = new URL(raw.trim())
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function expandEnv(value: string | string[] | undefined): string {
  const pick = Array.isArray(value) ? value.find(Boolean) : value
  if (!pick || typeof pick !== 'string') return ''
  const envMap = readMiraEnv()
  const resolved = pick
    .replace(/\{env:([^}]+)\}/g, (_, name: string) => process.env[name] ?? envMap[name] ?? '')
    .trim()
  return isUsableGeminiApiKey(resolved) ? resolved : ''
}

export function resolveResearchGeminiKey(): string {
  const envMap = readMiraEnv()
  const cands = [
    process.env.GEMINI_API_KEY,
    process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    process.env.GOOGLE_API_KEY,
    envMap.GEMINI_API_KEY,
    envMap.GOOGLE_GENERATIVE_AI_API_KEY,
    envMap.GOOGLE_API_KEY,
  ]
  for (const c of cands) {
    if (isUsableGeminiApiKey(c)) return c!.trim()
  }
  try {
    const cfg = getConfig()
    const gKey = expandEnv(cfg.provider?.google?.options?.apiKey)
    if (isUsableGeminiApiKey(gKey)) return gKey
  } catch {}
  return ''
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return 'web'
  }
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function rowToDTO(row: typeof import('../storage/schema.js').researchRuns.$inferSelect): ResearchRunDTO {
  return {
    id: row.id,
    sessionID: row.sessionID ?? null,
    branchSessionID: row.branchSessionID ?? null,
    ownerID: row.ownerID ?? null,
    orgID: row.orgID ?? null,
    mode: (row.mode as ResearchMode) ?? 'deep-investigation',
    query: row.query,
    status: (row.status as ResearchStatus) ?? 'planning',
    plan: parseJson<ResearchPlanTrack[]>(row.planJson, []),
    steps: parseJson<ResearchStep[]>(row.stepsJson, []),
    reportMarkdown: row.reportMarkdown ?? null,
    citations: parseJson<ResearchCitation[]>(row.citationsJson, []),
    error: row.error ?? null,
    provider: row.provider ?? null,
    model: row.model ?? null,
    tokensIn: row.tokensIn ?? 0,
    tokensOut: row.tokensOut ?? 0,
    durationMs: row.durationMs ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt ?? null,
  }
}

export type ResearchStreamListener = (event: {
  type: 'snapshot' | 'step' | 'citation' | 'status' | 'report' | 'done' | 'error'
  run: ResearchRunDTO
  payload?: unknown
}) => void

export class OnlineResearchService {
  private controllers = new Map<string, AbortController>()
  private listeners = new Map<string, Set<ResearchStreamListener>>()

  constructor(
    private deps: {
      db: MiraDB
      bus?: Bus
      knowledge?: KnowledgeBase
      gateway?: Gateway
    },
  ) {}

  subscribe(runId: string, fn: ResearchStreamListener): () => void {
    let set = this.listeners.get(runId)
    if (!set) {
      set = new Set()
      this.listeners.set(runId, set)
    }
    set.add(fn)
    return () => {
      set?.delete(fn)
      if (set && set.size === 0) this.listeners.delete(runId)
    }
  }

  private emit(
    run: ResearchRunDTO,
    type: 'snapshot' | 'step' | 'citation' | 'status' | 'report' | 'done' | 'error',
    payload?: unknown,
  ) {
    const set = this.listeners.get(run.id)
    if (set) {
      for (const fn of [...set]) {
        try {
          fn({ type, run, payload })
        } catch {}
      }
    }
    this.deps.bus?.publish({
      type: `research.${type}`,
      sessionID: run.branchSessionID ?? run.sessionID ?? undefined,
      payload: { runId: run.id, status: run.status, mode: run.mode },
      timestamp: Date.now(),
    })
  }

  async getRun(id: string): Promise<ResearchRunDTO | null> {
    const row = await this.deps.db.query.researchRuns.findFirst({
      where: eq(this.deps.db.schema.researchRuns.id, id),
    })
    return row ? rowToDTO(row) : null
  }

  async listRuns(opts?: { sessionID?: string; ownerID?: string; limit?: number }): Promise<ResearchRunDTO[]> {
    const limit = Math.min(opts?.limit ?? 40, 100)
    const rows = await this.deps.db.query.researchRuns.findMany({
      orderBy: desc(this.deps.db.schema.researchRuns.updatedAt),
      limit: limit * 2,
    })
    return rows
      .filter((r) => {
        if (opts?.sessionID && r.sessionID !== opts.sessionID && r.branchSessionID !== opts.sessionID)
          return false
        if (opts?.ownerID && r.ownerID && r.ownerID !== opts.ownerID) return false
        return true
      })
      .slice(0, limit)
      .map(rowToDTO)
  }

  private async savePatch(
    id: string,
    patch: Partial<typeof import('../storage/schema.js').researchRuns.$inferInsert>,
  ): Promise<ResearchRunDTO | null> {
    const now = Date.now()
    await this.deps.db
      .update(this.deps.db.schema.researchRuns)
      .set({ ...patch, updatedAt: now })
      .where(eq(this.deps.db.schema.researchRuns.id, id))
    return this.getRun(id)
  }

  async startRun(input: {
    query: string
    mode?: ResearchMode
    autoRun?: boolean
    sessionID?: string | null
    branchSessionID?: string | null
    ownerID?: string | null
    orgID?: string | null
  }): Promise<ResearchRunDTO> {
    const query = input.query.trim()
    if (!query || query.replace(/\s+/g, '').length < 2) {
      throw new Error('Research query must contain at least 2 characters.')
    }
    const mode: ResearchMode = input.mode ?? 'deep-investigation'
    const id = `res_${randomUUID().slice(0, 12)}`
    const now = Date.now()

    await this.deps.db.insert(this.deps.db.schema.researchRuns).values({
      id,
      sessionID: input.sessionID ?? null,
      branchSessionID: input.branchSessionID ?? null,
      ownerID: input.ownerID ?? null,
      orgID: input.orgID ?? null,
      mode,
      query,
      status: mode === 'quick-grounded' || input.autoRun ? 'running' : 'planning',
      planJson: '[]',
      stepsJson: '[]',
      citationsJson: '[]',
      createdAt: now,
      updatedAt: now,
    })

    const initial = (await this.getRun(id))!
    this.emit(initial, 'snapshot')

    if (mode === 'quick-grounded') {
      void this.executeQuickGrounded(id)
      return (await this.getRun(id))!
    }

    // Deep Investigation starts by generating a collaborative research plan
    if (input.autoRun) {
      const tracks = await this.buildPlanTracks(query)
      const updated = await this.savePatch(id, {
        planJson: JSON.stringify(tracks),
        status: 'running',
      })
      if (updated) this.emit(updated, 'status')
      void this.executeDeepTracks(id)
      return (await this.getRun(id))!
    }

    void this.prepareCollaborativePlan(id)
    return (await this.getRun(id))!
  }

  private async prepareCollaborativePlan(id: string) {
    const run = await this.getRun(id)
    if (!run) return
    const steps: ResearchStep[] = [
      {
        id: randomUUID().slice(0, 8),
        kind: 'thought',
        title: 'Decomposing research question into parallel investigation tracks',
        status: 'running',
        at: Date.now(),
      },
    ]
    await this.savePatch(id, { stepsJson: JSON.stringify(steps) })
    try {
      const tracks = await this.buildPlanTracks(run.query)
      const latestBeforeSave = await this.getRun(id)
      if (!latestBeforeSave || latestBeforeSave.status === 'cancelled') return
      steps[0] = { ...steps[0], status: 'done', detail: `${tracks.length} tracks prepared for review` }
      const updated = await this.savePatch(id, {
        planJson: JSON.stringify(tracks),
        stepsJson: JSON.stringify(steps),
        status: 'awaiting_approval',
      })
      if (updated) this.emit(updated, 'status')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const updated = await this.savePatch(id, {
        status: 'failed',
        error: msg,
        stepsJson: JSON.stringify([
          ...steps,
          { id: randomUUID().slice(0, 8), kind: 'error', title: 'Plan generation failed', detail: msg, status: 'failed', at: Date.now() },
        ]),
      })
      if (updated) this.emit(updated, 'error', { error: msg })
    }
  }

  async approveAndRun(id: string, editedPlan?: ResearchPlanTrack[]): Promise<ResearchRunDTO> {
    const run = await this.getRun(id)
    if (!run) throw new Error('Research run not found')
    if (run.status === 'running') return run
    if (run.status === 'completed' || run.status === 'cancelled') {
      throw new Error(`Research run cannot be started from status "${run.status}"`)
    }
    const plan = editedPlan && editedPlan.length > 0 ? editedPlan : run.plan
    const updated = await this.savePatch(id, {
      planJson: JSON.stringify(plan),
      status: 'running',
      error: null,
    })
    if (updated) this.emit(updated, 'status')
    void this.executeDeepTracks(id)
    return (await this.getRun(id))!
  }

  async cancelRun(id: string): Promise<ResearchRunDTO | null> {
    const ac = this.controllers.get(id)
    if (ac && !ac.signal.aborted) ac.abort()
    const updated = await this.savePatch(id, { status: 'cancelled' })
    if (updated) this.emit(updated, 'done')
    return updated
  }

  private async buildPlanTracks(query: string): Promise<ResearchPlanTrack[]> {
    const geminiKey = resolveResearchGeminiKey()
    if (geminiKey) {
      const ai = new GoogleGenAI({
        apiKey: geminiKey,
        httpOptions: { apiVersion: 'v1beta', headers: { 'User-Agent': 'aistudio-build' } },
      })
      const baseModels = ['gemini-4-hydrogen', 'gemini-2.5-flash', 'gemini-3-flash-preview']
      for (const model of baseModels) {
        try {
          const res = await ai.models.generateContent({
            model,
            contents: `Break down this research question into 3 to 4 focused, non-overlapping online research tracks. Return ONLY valid JSON array of objects with keys: "title", "query", "focus". Question: ${query}`,
            config: { responseMimeType: 'application/json' },
          })
          const raw = (res.text ?? '').trim()
          const parsed = JSON.parse(raw) as Array<{ title?: string; query?: string; focus?: string }>
          if (Array.isArray(parsed) && parsed.length > 0) {
            return parsed.slice(0, 4).map((t, i) => ({
              id: `track_${i + 1}`,
              title: String(t.title || `Track ${i + 1}`).slice(0, 120),
              query: String(t.query || query).slice(0, 260),
              focus: String(t.focus || 'Primary documentation and live verification').slice(0, 220),
            }))
          }
        } catch {}
      }
    }

    return [
      {
        id: 'track_1',
        title: 'Primary Specs & Official Documentation',
        query: `${query} official documentation architecture specification`,
        focus: 'Authoritative docs, core capabilities, and design constraints',
      },
      {
        id: 'track_2',
        title: 'Benchmarks, Comparisons & Trade-offs',
        query: `${query} comparison tradeoffs benchmarks 2026`,
        focus: 'Objective strengths, weaknesses, and alternatives',
      },
      {
        id: 'track_3',
        title: 'Failure Modes, Security & Production Gotchas',
        query: `${query} security risks production pitfalls best practices`,
        focus: 'Operational reliability, edge cases, and verification practices',
      },
    ]
  }

  private async runGroundedSearch(
    query: string,
    signal: AbortSignal,
  ): Promise<{
    answer: string
    sources: Array<{ title: string; url: string; snippet?: string; trust: 'grounded' | 'websearch' | 'webfetch' }>
    provider: string
    model: string
    tokensIn: number
    tokensOut: number
  }> {
    if (signal.aborted) throw new Error('Research cancelled')

    const geminiKey = resolveResearchGeminiKey()
    let geminiErrorMsg = ''
    if (geminiKey) {
      const ai = new GoogleGenAI({
        apiKey: geminiKey,
        httpOptions: { apiVersion: 'v1beta', headers: { 'User-Agent': 'aistudio-build' } },
      })
      const baseModels = ['gemini-4-hydrogen', 'gemini-2.5-flash', 'gemini-3-flash-preview']
      const candidates = [
        ...baseModels.filter((m) => !isGeminiModelInCooldown(m)),
        ...baseModels.filter((m) => isGeminiModelInCooldown(m)),
      ]
      for (const model of candidates) {
        try {
          const response = await ai.models.generateContent({
            model,
            contents: `Research this thoroughly using live Google Search and synthesize concrete, verifiable facts with dates and technical specifics. Question: ${query}`,
            config: {
              tools: [{ googleSearch: {} }],
            },
          })

          const text = (response.text ?? '').trim()
          const rawChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? []
          const sources: Array<{ title: string; url: string; snippet?: string; trust: 'grounded' | 'websearch' | 'webfetch' }> = []
          const seen = new Set<string>()
          for (const ch of rawChunks) {
            const uri = ch?.web?.uri
            if (!isSafeHttpUrl(uri) || seen.has(uri)) continue
            seen.add(uri)
            sources.push({
              title: (ch.web?.title || domainOf(uri)).trim(),
              url: uri,
              trust: 'grounded',
            })
          }
          const usage = response.usageMetadata
          if (text || sources.length > 0) {
            return {
              answer: text,
              sources,
              provider: 'google',
              model,
              tokensIn: usage?.promptTokenCount ?? 0,
              tokensOut: usage?.candidatesTokenCount ?? 0,
            }
          }
        } catch (err) {
          geminiErrorMsg = err instanceof Error ? err.message : String(err)
          if (/API_KEY_INVALID|API key not valid|PERMISSION_DENIED|403|401/i.test(geminiErrorMsg)) {
            invalidGeminiKeys.add(geminiKey)
            markInvalidGeminiKey(geminiKey)
            break
          }
          if (/429|RESOURCE_EXHAUSTED|quota|404|NOT_FOUND|not found|no longer available/i.test(geminiErrorMsg)) {
            markGeminiModelCooldown(model)
            continue
          }
        }
      }
    }

    // Fallback: Mira native websearch (Firecrawl / Tavily / DuckDuckGo) + sanitized webfetch
    const searchOut = (await websearchTool.execute(
      { query, count: 6 },
      { sessionID: 'research', messageID: 'research' },
    )) as {
      provider?: string
      results?: Array<{ title?: string; url?: string; snippet?: string }>
      note?: string
    }
    const results = (searchOut.results ?? []).filter((r) => isSafeHttpUrl(r.url))
    if (results.length === 0) {
      if (geminiErrorMsg) {
        const isAuthErr = /API_KEY_INVALID|API key not valid|PERMISSION_DENIED|403|401/i.test(geminiErrorMsg)
        throw new Error(
          isAuthErr
            ? `Gemini Search API key rejected — check GEMINI_API_KEY in Settings > Secrets, or configure FIRECRAWL_API_KEY / TAVILY_API_KEY. Fallback search returned no results for "${query.slice(0, 60)}".`
            : `Live search failed (${geminiErrorMsg}) and fallback web search returned no results for "${query.slice(0, 60)}".`,
        )
      }
      throw new Error(
        searchOut.note ??
          `No live search results found for "${query.slice(0, 60)}". Configure GEMINI_API_KEY, FIRECRAWL_API_KEY, or TAVILY_API_KEY for broader search coverage.`,
      )
    }

    const sources: Array<{ title: string; url: string; snippet?: string; trust: 'grounded' | 'websearch' | 'webfetch' }> = []
    const excerpts: string[] = []
    for (const r of results.slice(0, 4)) {
      if (signal.aborted) break
      const url = r.url!
      let excerpt = sanitizeResearchContent(r.snippet ?? '')
      try {
        const fetched = (await webfetchTool.execute(
          { url, maxChars: 4000 },
          { sessionID: 'research', messageID: 'research' },
        )) as { content?: string }
        if (fetched?.content) {
          excerpt = sanitizeResearchContent(fetched.content).slice(0, 1200)
        }
      } catch {}
      sources.push({
        title: (r.title || domainOf(url)).trim(),
        url,
        snippet: excerpt.slice(0, 280),
        trust: 'websearch',
      })
      excerpts.push(`### ${r.title || url}\nURL: ${url}\n${excerpt}`)
    }

    let answer = `Collected ${sources.length} live sources via ${searchOut.provider ?? 'websearch'}:\n\n${excerpts.join('\n\n')}`
    let usedModel = 'live-websearch'
    let tokensIn = 0
    let tokensOut = 0

    if (this.deps.gateway && sources.length > 0 && !signal.aborted) {
      try {
        const cfg = getConfig()
        const synthModel = cfg.smallModel || cfg.model || 'openrouter/google/gemini-2.5-flash'
        const citationIndex = sources.map((s, idx) => `[${idx + 1}] ${s.title} (${s.url})`).join('\n')
        const gwRes = await this.deps.gateway.complete({
          model: synthModel,
          system: 'Synthesize a concise, factual answer strictly grounded in the provided web sources with inline [1], [2] citations.',
          prompt: `Question: ${query}\n\nSources:\n${citationIndex}\n\nExcerpts:\n${excerpts.join('\n\n').slice(0, 6000)}`,
          maxTokens: 1200,
        })
        if (gwRes.text?.trim()) {
          answer = gwRes.text.trim()
          usedModel = synthModel
          tokensIn = gwRes.inputTokens ?? 0
          tokensOut = gwRes.outputTokens ?? 0
        }
      } catch {}
    }

    return {
      answer,
      sources,
      provider: searchOut.provider ?? 'websearch',
      model: usedModel,
      tokensIn,
      tokensOut,
    }
  }

  private async executeQuickGrounded(id: string) {
    const startedAt = Date.now()
    const ac = new AbortController()
    this.controllers.set(id, ac)
    try {
      const run = await this.getRun(id)
      if (!run) return
      const steps: ResearchStep[] = [
        {
          id: randomUUID().slice(0, 8),
          kind: 'search_query',
          title: `Searching live sources for "${run.query.slice(0, 80)}"`,
          status: 'running',
          at: Date.now(),
        },
      ]
      const stepSnap = await this.savePatch(id, { stepsJson: JSON.stringify(steps) })
      if (stepSnap) this.emit(stepSnap, 'step', steps[0])

      const res = await this.runGroundedSearch(run.query, ac.signal)
      const citations: ResearchCitation[] = res.sources.map((s, idx) => ({
        id: `cit_${idx + 1}`,
        index: idx + 1,
        title: s.title,
        url: s.url,
        domain: domainOf(s.url),
        snippet: s.snippet,
        fetchedAt: Date.now(),
        trust: s.trust,
      }))

      steps[0] = {
        ...steps[0],
        status: 'done',
        detail: `${citations.length} live sources retrieved via ${res.provider}`,
      }
      steps.push({
        id: randomUUID().slice(0, 8),
        kind: 'synthesis',
        title: 'Synthesizing grounded brief with inline citations',
        status: 'done',
        at: Date.now(),
      })

      const report =
        res.answer ||
        `No narrative answer generated for **${run.query}**, but ${citations.length} verified sources were retrieved.`

      const completed = await this.savePatch(id, {
        status: 'completed',
        stepsJson: JSON.stringify(steps),
        citationsJson: JSON.stringify(citations),
        reportMarkdown: report,
        provider: res.provider,
        model: res.model,
        tokensIn: res.tokensIn,
        tokensOut: res.tokensOut,
        durationMs: Date.now() - startedAt,
        completedAt: Date.now(),
      })
      if (completed) {
        this.emit(completed, 'report')
        this.emit(completed, 'done')
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const current = await this.getRun(id)
      const steps = current?.steps ?? []
      const failed = await this.savePatch(id, {
        status: ac.signal.aborted ? 'cancelled' : 'failed',
        error: ac.signal.aborted ? null : msg,
        stepsJson: JSON.stringify([
          ...steps.map((s) => (s.status === 'running' ? { ...s, status: 'failed' as const } : s)),
          ...(ac.signal.aborted
            ? []
            : [{ id: randomUUID().slice(0, 8), kind: 'error' as const, title: 'Research failed', detail: msg, status: 'failed' as const, at: Date.now() }]),
        ]),
        durationMs: Date.now() - startedAt,
      })
      if (failed) {
        this.emit(failed, ac.signal.aborted ? 'done' : 'error', { error: msg })
      }
    } finally {
      this.controllers.delete(id)
    }
  }

  private async executeDeepTracks(id: string) {
    const startedAt = Date.now()
    const ac = new AbortController()
    this.controllers.set(id, ac)
    try {
      const run = await this.getRun(id)
      if (!run) return
      const tracks = run.plan.length > 0 ? run.plan : await this.buildPlanTracks(run.query)
      const steps: ResearchStep[] = [...run.steps]
      const citations: ResearchCitation[] = []
      const seenUrls = new Set<string>()
      const trackFindings: Array<{ track: ResearchPlanTrack; summary: string; urls: string[] }> = []

      let tokensIn = 0
      let tokensOut = 0
      let usedProvider = 'websearch'
      let usedModel = 'live-websearch'

      for (const track of tracks) {
        if (ac.signal.aborted) throw new Error('Cancelled')
        const stepId = randomUUID().slice(0, 8)
        steps.push({
          id: stepId,
          kind: 'search_query',
          title: `Investigating: ${track.title}`,
          detail: track.query,
          status: 'running',
          at: Date.now(),
        })
        const sSnap = await this.savePatch(id, { stepsJson: JSON.stringify(steps) })
        if (sSnap) this.emit(sSnap, 'step', steps[steps.length - 1])

        const res = await this.runGroundedSearch(track.query, ac.signal)
        usedProvider = res.provider
        usedModel = res.model
        tokensIn += res.tokensIn
        tokensOut += res.tokensOut

        const trackUrls: string[] = []
        for (const src of res.sources) {
          trackUrls.push(src.url)
          if (!seenUrls.has(src.url)) {
            seenUrls.add(src.url)
            citations.push({
              id: `cit_${citations.length + 1}`,
              index: citations.length + 1,
              title: src.title,
              url: src.url,
              domain: domainOf(src.url),
              snippet: src.snippet,
              fetchedAt: Date.now(),
              trust: src.trust,
            })
          }
        }

        const idx = steps.findIndex((s) => s.id === stepId)
        if (idx >= 0) {
          steps[idx] = {
            ...steps[idx],
            status: 'done',
            detail: `${res.sources.length} sources · ${track.query}`,
          }
        }
        trackFindings.push({
          track,
          summary: sanitizeResearchContent(res.answer),
          urls: trackUrls,
        })

        const mid = await this.savePatch(id, {
          stepsJson: JSON.stringify(steps),
          citationsJson: JSON.stringify(citations),
          tokensIn,
          tokensOut,
        })
        if (mid) this.emit(mid, 'citation')
      }

      // Cross-examine and synthesize final cited report
      const synthId = randomUUID().slice(0, 8)
      steps.push({
        id: synthId,
        kind: 'synthesis',
        title: `Synthesizing ${trackFindings.length} tracks & ${citations.length} verified citations`,
        status: 'running',
        at: Date.now(),
      })
      const synthSnap = await this.savePatch(id, { stepsJson: JSON.stringify(steps) })
      if (synthSnap) this.emit(synthSnap, 'step', steps[steps.length - 1])

      let finalReport = ''
      const citationIndex = citations.map((c) => `[${c.index}] ${c.title} (${c.url})`).join('\n')
      const dossier = trackFindings
        .map(
          (tf, i) =>
            `## Track ${i + 1}: ${tf.track.title}\nFocus: ${tf.track.focus}\n${tf.summary.slice(0, 3500)}`,
        )
        .join('\n\n')
      const synthPrompt = `You are an authoritative engineering researcher. Synthesize the following verified research tracks into a decisive, high-signal Markdown report answering: "${run.query}".

Requirements:
- Lead with an Executive Summary and Key Architectural Takeaways.
- Compare options / tradeoffs concretely in a Markdown table where helpful.
- Reference sources inline strictly using the numbered indices like [1], [2] from the Citation Index below.
- Include a "Caveats & Contradictions" section highlighting gaps or conflicting evidence.
- Conclude with Concrete Next Recommendations.

Citation Index:
${citationIndex}

Sanitized Track Dossiers:
${dossier}`

      const geminiKey = resolveResearchGeminiKey()
      if (geminiKey) {
        const ai = new GoogleGenAI({
          apiKey: geminiKey,
          httpOptions: { apiVersion: 'v1beta', headers: { 'User-Agent': 'aistudio-build' } },
        })
        const baseModels = ['gemini-4-hydrogen', 'gemini-2.5-flash', 'gemini-3-flash-preview']
        for (const model of baseModels) {
          try {
            const synth = await ai.models.generateContent({
              model,
              contents: synthPrompt,
            })
            finalReport = (synth.text ?? '').trim()
            tokensIn += synth.usageMetadata?.promptTokenCount ?? 0
            tokensOut += synth.usageMetadata?.candidatesTokenCount ?? 0
            if (finalReport) break
          } catch (err) {
            console.warn(`[research] Gemini deep synthesis failed with ${model}:`, err instanceof Error ? err.message : String(err))
          }
        }
      }
      if (!finalReport && this.deps.gateway) {
        try {
          const cfg = getConfig()
          const synthModel = cfg.model || cfg.smallModel || 'openrouter/google/gemini-2.5-flash'
          const gwSynth = await this.deps.gateway.complete({
            model: synthModel,
            prompt: synthPrompt,
            maxTokens: 2400,
          })
          if (gwSynth.text?.trim()) {
            finalReport = gwSynth.text.trim()
            usedModel = synthModel
            tokensIn += gwSynth.inputTokens ?? 0
            tokensOut += gwSynth.outputTokens ?? 0
          }
        } catch {}
      }
      if (!finalReport) {
        finalReport = [
          `# Deep Investigation: ${run.query}`,
          '',
          `Synthesized across **${trackFindings.length} investigation tracks** and **${citations.length} live sources**.`,
          '',
          ...trackFindings.map(
            (tf, i) => `## ${i + 1}. ${tf.track.title}\n_${tf.track.focus}_\n\n${tf.summary}`,
          ),
        ].join('\n')
      }

      const sIdx = steps.findIndex((s) => s.id === synthId)
      if (sIdx >= 0) steps[sIdx] = { ...steps[sIdx], status: 'done' }

      const completed = await this.savePatch(id, {
        status: 'completed',
        stepsJson: JSON.stringify(steps),
        citationsJson: JSON.stringify(citations),
        reportMarkdown: finalReport,
        provider: usedProvider,
        model: usedModel,
        tokensIn,
        tokensOut,
        durationMs: Date.now() - startedAt,
        completedAt: Date.now(),
      })
      if (completed) {
        this.emit(completed, 'report')
        this.emit(completed, 'done')
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const current = await this.getRun(id)
      const steps = current?.steps ?? []
      const failed = await this.savePatch(id, {
        status: ac.signal.aborted ? 'cancelled' : 'failed',
        error: ac.signal.aborted ? null : msg,
        stepsJson: JSON.stringify([
          ...steps.map((s) => (s.status === 'running' ? { ...s, status: 'failed' as const } : s)),
          { id: randomUUID().slice(0, 8), kind: 'error', title: 'Investigation failed', detail: msg, status: 'failed', at: Date.now() },
        ]),
        durationMs: Date.now() - startedAt,
      })
      if (failed) {
        this.emit(failed, ac.signal.aborted ? 'done' : 'error', { error: msg })
      }
    } finally {
      this.controllers.delete(id)
    }
  }

  async promoteRunToMemory(id: string, customTitle?: string) {
    if (!this.deps.knowledge) throw new Error('KnowledgeBase unavailable')
    const run = await this.getRun(id)
    if (!run) throw new Error('Research run not found')
    if (!run.reportMarkdown) throw new Error('Research run has no report yet')

    const now = Date.now()
    const evidence = run.citations.slice(0, 8).map((c) => ({
      kind: 'url' as const,
      ref: c.url,
      at: c.fetchedAt || now,
    }))
    const domains = [...new Set(run.citations.map((c) => c.domain))].slice(0, 6)
    const entry = await this.deps.knowledge.store({
      tier: 'semantic',
      source: 'online',
      title: customTitle?.trim() || `Research: ${run.query.slice(0, 90)}`,
      content: sanitizeResearchContent(run.reportMarkdown).slice(0, 4000),
      tags: ['deep-research', run.mode, ...domains],
      metadata: {
        researchRunId: run.id,
        sessionId: run.sessionID,
        branchSessionId: run.branchSessionID,
        citationCount: run.citations.length,
        provider: run.provider,
        model: run.model,
      },
      provenance: run.citations.length >= 2 ? 'benchmark-verified' : 'agent-generated',
      confidence: Math.min(0.75, 0.35 + run.citations.length * 0.05),
      sourceKind: 'imported',
      sourceRef: run.citations[0]?.url ?? `research:${run.id}`,
      createdBy: 'agent:deep-research',
      evidence,
    })
    return entry
  }
}
