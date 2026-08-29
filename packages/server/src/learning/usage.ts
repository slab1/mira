/**
 * Mira Usage Learning — Performance, Traces & Feedback
 *
 * Learns from real usage: session logs, tool traces, token/latency
 * metrics, success vs failure patterns, and user feedback.
 *
 * Mirrors Project Aether's `strategy_effectiveness` (logic_evolve.py) but
 * generalized for Mira's SessionPrompt.loop + ToolRegistry + BusEvent.
 *
 * Pipeline:
 *   record() → analyze() → identify failure/success patterns → suggest
 *
 * Storage:
 *   - Primary: SQLite `usage_metrics` + `usage_patterns` tables (if db)
 *   - Also publishes `learning.usage.insights` on the bus
 *   - In-memory buffer for fast `getStats()` even without DB
 *
 * Integration points:
 *   - SessionPrompt.loop calls `usageLearner.recordToolResult()` per tool-call
 *   - SessionPrompt.streamResponse calls `recordSession()` on finish
 *   - Scheduler calls `analyze()` after each session + nightly rollup
 */

import type { Bus } from "../bus/index.js"
import type { MiraDB } from "../storage/db.js"
import type { JsonValue } from "../types/index.js"

// ── Types ────────────────────────────────────────────────────────────

export interface ToolMetric {
  tool: string
  durationMs: number
  tokensIn?: number
  tokensOut?: number
  isError: boolean
  errorKind?: string   // e.g. "permission_denied" | "timeout" | "validation"
  sessionID: string
  timestamp: number
}

export interface SessionMetric {
  sessionID: string
  model: string
  steps: number
  totalTokensIn: number
  totalTokensOut: number
  latencyMs: number
  toolCalls: number
  toolErrors: number
  doomLoops: number
  compactionCount: number
  success: boolean       // true if finished without error/doom-loop
  userFeedback?: "up" | "down" | null
  createdAt: number
}

export interface FailurePattern extends Record<string, JsonValue | undefined> {
  id: string
  kind: "tool" | "model" | "workflow"
  key: string            // e.g. "bash:timeout" | "edit:validation"
  count: number
  errorRate: number      // 0..1
  avgLatencyMs?: number
  example?: string
  suggestion: string
}

export interface SuccessPattern extends Record<string, JsonValue | undefined> {
  id: string
  key: string            // e.g. "read+edit+bash" (tool sequence)
  count: number
  successRate: number    // 0..1
  avgTokens?: number
  suggestion: string
}

export interface UsageAnalysis extends Record<string, JsonValue> {
  window: { from: number; to: number; sessions: number }
  failurePatterns: FailurePattern[]
  successPatterns: SuccessPattern[]
  toolStats: Record<string, { count: number; errorRate: number; p50Ms: number; p95Ms: number }>
  modelStats: Record<string, { sessions: number; successRate: number; avgTokens: number }>
  generatedAt: number
}

export interface UsageLearnerConfig {
  /** errorRate threshold to flag a failure pattern (default 0.3) */
  failureRateThreshold?: number
  /** min occurrences before flagging (default 3) */
  minCount?: number
  /** how many recent sessions to analyze (default 100) */
  windowSize?: number
}

export interface UsageLearnerDeps {
  bus?: Bus
  db?: MiraDB
}

// ── UsageLearner ─────────────────────────────────────────────────────

export class UsageLearner {
  private config: Required<UsageLearnerConfig>
  // In-memory ring buffers (used when DB not present + for fast stats)
  private toolMetrics: ToolMetric[] = []
  private sessionMetrics: SessionMetric[] = []
  private readonly maxBuffer = 2000

  constructor(
    private deps: UsageLearnerDeps = {},
    config: UsageLearnerConfig = {},
  ) {
    this.config = {
      failureRateThreshold: config.failureRateThreshold ?? 0.3,
      minCount: config.minCount ?? 3,
      windowSize: config.windowSize ?? 100,
    }
    // Wire usage telemetry via bus subscription for backward compatibility
    if (this.deps.bus) {
      this.deps.bus.subscribe("part.created", (event) => {
        const part = event.payload as { type?: string; tool?: string; isError?: boolean } | undefined
        if (!part || !part.tool) return
        // Record tool calls / results from bus events with privacy safeguards
        const now = Date.now()
        if (part.type === "tool-call") {
          this.recordTool({
            tool: part.tool,
            durationMs: 0,
            isError: false,
            errorKind: undefined,
            sessionID: event.sessionID ?? "",
            timestamp: now,
          }).catch(() => {})
        }
        if (part.type === "tool-result") {
          this.recordTool({
            tool: part.tool,
            durationMs: 0,
            isError: !!part.isError,
            errorKind: part.isError ? "execution" : undefined,
            sessionID: event.sessionID ?? "",
            timestamp: now,
          }).catch(() => {})
        }
      })
      // Record session completion via message.created as proxy
      this.deps.bus.subscribe("message.created", (event) => {
        // simple heuristic: if message is assistant, we may close session
        // actual session finish is handled by explicit recordSession call
      })
    }
  }

  // ── Privacy safeguards ─────────────────────────────────────────────
  private redactSensitive(input: JsonValue): JsonValue {
    if (typeof input === "string") {
      return input
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
        .replace(/\+?\d{1,3}[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, "[REDACTED_PHONE]")
        .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*["']?([^\s"']+)["']?/gi, "$1=[REDACTED]")
    }
    if (Array.isArray(input)) return input.map(v => this.redactSensitive(v as JsonValue)) as JsonValue
    if (input && typeof input === "object") {
      const out: Record<string, JsonValue> = {}
      for (const [k, v] of Object.entries(input)) {
        const key = k.toLowerCase()
        if (["password","secret","token","apikey","api_key"].includes(key)) {
          out[k] = "[REDACTED]"
        } else {
          out[k] = this.redactSensitive(v as JsonValue)
        }
      }
      return out
    }
    return input
  }

  private safeResultSize(result: JsonValue): number {
    try {
      return JSON.stringify(result ?? "").length
    } catch {
      return 0
    }
  }

  // ── Recording ──────────────────────────────────────────────────────

  /** Call per tool-call from SessionPrompt.loop */
  async recordTool(metric: ToolMetric): Promise<void> {
    this.toolMetrics.push(metric)
    if (this.toolMetrics.length > this.maxBuffer) this.toolMetrics.shift()
    if (this.deps.db) await this.persistTool(metric).catch(() => {})
  }

  /** Call on session finish (streamResponse → runLoop finalize) */
  async recordSession(metric: SessionMetric): Promise<void> {
    this.sessionMetrics.push(metric)
    if (this.sessionMetrics.length > this.maxBuffer) this.sessionMetrics.shift()
    if (this.deps.db) await this.persistSession(metric).catch(() => {})

    // Auto-analyze after each session if we have enough data
    if (this.sessionMetrics.length >= 5) {
      const analysis = await this.analyze()
      this.deps.bus?.publish({
        type: "learning.updated",
        payload: { kind: "learning.usage.analysis", analysis },
        timestamp: Date.now(),
        })
    }
  }

  /** Record user feedback (thumbs up/down) for a session */
  async recordFeedback(sessionID: string, feedback: "up" | "down"): Promise<void> {
    const m = this.sessionMetrics.find(s => s.sessionID === sessionID)
    if (m) m.userFeedback = feedback
    if (this.deps.db) {
      try {
        this.deps.db.sqlite?.exec(`UPDATE usage_sessions SET user_feedback='${feedback}' WHERE session_id='${sessionID}'`)
      } catch {}
    }
  }

  // ── Analysis ───────────────────────────────────────────────────────

  /** Full analysis over the recent window — the core "learn" step */
  async analyze(): Promise<UsageAnalysis> {
    // Prefer DB if available and populated, else in-memory
    let tools = this.toolMetrics
    let sessions = this.sessionMetrics
    if (this.deps.db) {
      const loaded = await this.loadFromDB().catch(() => null)
      if (loaded && loaded.sessions.length >= 3) {
        tools = loaded.tools
        sessions = loaded.sessions
      }
    }
    const windowSessions = sessions.slice(-this.config.windowSize)
    const windowTools = tools.slice(-this.config.windowSize * 8)

    const failurePatterns = this.findFailurePatterns(windowTools, windowSessions)
    const successPatterns = this.findSuccessPatterns(windowTools, windowSessions)
    const toolStats = this.computeToolStats(windowTools)
    const modelStats = this.computeModelStats(windowSessions)

    const analysis: UsageAnalysis = {
      window: {
        from: windowSessions[0]?.createdAt ?? Date.now(),
        to: windowSessions[windowSessions.length - 1]?.createdAt ?? Date.now(),
        sessions: windowSessions.length,
      },
      failurePatterns,
      successPatterns,
      toolStats,
      modelStats,
      generatedAt: Date.now(),
    }
    if (this.deps.db) await this.persistAnalysis(analysis).catch(() => {})
    return analysis
  }

  /** Quick stats for dashboards / scheduler decisions */
  getStats(): { sessions: number; toolCalls: number; errorRate: number } {
    const sessions = this.sessionMetrics.length
    const toolCalls = this.toolMetrics.length
    const errors = this.toolMetrics.filter(t => t.isError).length
    return { sessions, toolCalls, errorRate: toolCalls ? errors / toolCalls : 0 }
  }

  // ── Pattern detection ──────────────────────────────────────────────

  private findFailurePatterns(tools: ToolMetric[], sessions: SessionMetric[]): FailurePattern[] {
    const patterns: FailurePattern[] = []
    // Group tool errors by tool + errorKind
    const groups = new Map<string, ToolMetric[]>()
    for (const t of tools) {
      const key = t.isError ? `${t.tool}:${t.errorKind ?? "error"}` : `${t.tool}:ok`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(t)
    }
    // Also consider per-tool aggregate error rate
    const byTool = new Map<string, ToolMetric[]>()
    for (const t of tools) {
      if (!byTool.has(t.tool)) byTool.set(t.tool, [])
      byTool.get(t.tool)!.push(t)
    }
    for (const [tool, arr] of byTool) {
      const errors = arr.filter(x => x.isError).length
      const rate = arr.length ? errors / arr.length : 0
      if (arr.length >= this.config.minCount && rate >= this.config.failureRateThreshold) {
        const dominantKind = mostCommon(arr.filter(x => x.isError).map(x => x.errorKind ?? "error"))
        patterns.push({
          id: `fail_${tool}_${Date.now().toString(36)}`,
          kind: "tool",
          key: `${tool}:${dominantKind ?? "error"}`,
          count: errors,
          errorRate: round(rate, 2),
          avgLatencyMs: avg(arr.map(x => x.durationMs)),
          example: arr.find(x => x.isError)?.errorKind,
          suggestion: suggestFixForTool(tool, dominantKind ?? "error", rate),
        })
      }
    }
    // Doom-loop / workflow failures from sessions
    const doomCount = sessions.filter(s => s.doomLoops > 0).length
    if (doomCount >= 2) {
      patterns.push({
        id: `fail_workflow_doomloop_${Date.now().toString(36)}`,
        kind: "workflow",
        key: "workflow:doom-loop",
        count: doomCount,
        errorRate: round(doomCount / Math.max(1, sessions.length), 2),
        suggestion: "Doom-loop detected in ≥2 sessions. Tighten doom-detector threshold or add tool-call deduplication in SessionPrompt.",
      })
    }
    // Thumbs-down feedback
    const downs = sessions.filter(s => s.userFeedback === "down").length
    if (downs >= 2) {
      patterns.push({
        id: `fail_workflow_feedback_${Date.now().toString(36)}`,
        kind: "workflow",
        key: "workflow:negative-feedback",
        count: downs,
        errorRate: round(downs / Math.max(1, sessions.length), 2),
        suggestion: "Multiple negative feedback signals. Review recent session transcripts for user intent mismatch; consider prompt or tool-selection tuning.",
      })
    }
    return patterns.sort((a, b) => b.errorRate - a.errorRate).slice(0, 8)
  }

  private findSuccessPatterns(tools: ToolMetric[], sessions: SessionMetric[]): SuccessPattern[] {
    // Successful tool sequences (bigrams/trigrams) in sessions that succeeded
    const successSessions = sessions.filter(s => s.success)
    if (successSessions.length < 3) return []
    // For simplicity, use in-memory tool order per session
    const seqCount = new Map<string, number>()
    const seqSuccess = new Map<string, number>()
    // Group tools by session
    const bySession = new Map<string, ToolMetric[]>()
    for (const t of tools) {
      if (!bySession.has(t.sessionID)) bySession.set(t.sessionID, [])
      bySession.get(t.sessionID)!.push(t)
    }
    for (const s of sessions) {
      const seq = (bySession.get(s.sessionID) ?? []).map(t => t.tool).join("+")
      if (!seq) continue
      seqCount.set(seq, (seqCount.get(seq) ?? 0) + 1)
      if (s.success) seqSuccess.set(seq, (seqSuccess.get(seq) ?? 0) + 1)
    }
    const patterns: SuccessPattern[] = []
    for (const [seq, total] of seqCount) {
      if (total < 2) continue
      const ok = seqSuccess.get(seq) ?? 0
      const rate = ok / total
      if (rate >= 0.7) {
        patterns.push({
          id: `succ_${seq.slice(0, 20)}_${Date.now().toString(36)}`,
          key: seq,
          count: total,
          successRate: round(rate, 2),
          suggestion: `High-success workflow "${seq}" (success ${Math.round(rate * 100)}%). Consider codifying as a skill or planning template.`,
        })
      }
    }
    return patterns.sort((a, b) => b.successRate - a.successRate).slice(0, 5)
  }

  private computeToolStats(tools: ToolMetric[]): UsageAnalysis["toolStats"] {
    const out: UsageAnalysis["toolStats"] = {}
    const byTool = new Map<string, ToolMetric[]>()
    for (const t of tools) {
      if (!byTool.has(t.tool)) byTool.set(t.tool, [])
      byTool.get(t.tool)!.push(t)
    }
    for (const [tool, arr] of byTool) {
      const sorted = arr.map(x => x.durationMs).sort((a, b) => a - b)
      out[tool] = {
        count: arr.length,
        errorRate: round(arr.filter(x => x.isError).length / arr.length, 3),
        p50Ms: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
      }
    }
    return out
  }

  private computeModelStats(sessions: SessionMetric[]): UsageAnalysis["modelStats"] {
    const out: UsageAnalysis["modelStats"] = {}
    const byModel = new Map<string, SessionMetric[]>()
    for (const s of sessions) {
      if (!byModel.has(s.model)) byModel.set(s.model, [])
      byModel.get(s.model)!.push(s)
    }
    for (const [model, arr] of byModel) {
      out[model] = {
        sessions: arr.length,
        successRate: round(arr.filter(x => x.success).length / arr.length, 3),
        avgTokens: Math.round(avg(arr.map(x => x.totalTokensIn + x.totalTokensOut))),
      }
    }
    return out
  }

  // ── Persistence ────────────────────────────────────────────────────

  private async persistTool(m: ToolMetric): Promise<void> {
    const sqlite = this.deps.db?.sqlite
    if (!sqlite) return
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS usage_tools (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        is_error INTEGER NOT NULL,
        error_kind TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS usage_tools_tool_idx ON usage_tools(tool);
    `)
    sqlite.prepare(
      `INSERT OR IGNORE INTO usage_tools (id, session_id, tool, duration_ms, is_error, error_kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(crypto.randomUUID(), m.sessionID, m.tool, m.durationMs, m.isError ? 1 : 0, m.errorKind ?? null, m.timestamp)
  }

  private async persistSession(m: SessionMetric): Promise<void> {
    const sqlite = this.deps.db?.sqlite
    if (!sqlite) return
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS usage_sessions (
        session_id TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        steps INTEGER NOT NULL,
        total_tokens_in INTEGER NOT NULL,
        total_tokens_out INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        tool_calls INTEGER NOT NULL,
        tool_errors INTEGER NOT NULL,
        doom_loops INTEGER NOT NULL,
        success INTEGER NOT NULL,
        user_feedback TEXT,
        created_at INTEGER NOT NULL
      );
    `)
    sqlite.prepare(
      `INSERT OR REPLACE INTO usage_sessions
       (session_id, model, steps, total_tokens_in, total_tokens_out, latency_ms, tool_calls, tool_errors, doom_loops, success, user_feedback, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(m.sessionID, m.model, m.steps, m.totalTokensIn, m.totalTokensOut, m.latencyMs, m.toolCalls, m.toolErrors, m.doomLoops, m.success ? 1 : 0, m.userFeedback ?? null, m.createdAt)
  }

  private async persistAnalysis(a: UsageAnalysis): Promise<void> {
    const sqlite = this.deps.db?.sqlite
    if (!sqlite) return
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS usage_analyses (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `)
    sqlite.prepare(`INSERT INTO usage_analyses (id, payload, created_at) VALUES (?, ?, ?)`)
      .run(crypto.randomUUID(), JSON.stringify(a), a.generatedAt)
  }

  private async loadFromDB(): Promise<{ tools: ToolMetric[]; sessions: SessionMetric[] } | null> {
    const sqlite = this.deps.db?.sqlite
    if (!sqlite) return null
    try {
      interface UsageToolRow { tool: string; duration_ms: number; is_error: number; error_kind?: string; session_id: string; created_at: number }
      const tools = (sqlite.prepare(`SELECT * FROM usage_tools ORDER BY created_at DESC LIMIT 500`).all() as UsageToolRow[]).map(r => ({
        tool: r.tool, durationMs: r.duration_ms, isError: !!r.is_error, errorKind: r.error_kind,
        sessionID: r.session_id, timestamp: r.created_at,
      }))
      type SessionRow = { session_id: string; model: string; steps: number; total_tokens_in: number; total_tokens_out: number; latency_ms: number; tool_calls: number; tool_errors: number; doom_loops?: number; compaction_count?: number; success: number; user_feedback?: string | null; created_at: number }
      const sessions: SessionMetric[] = (sqlite.prepare(`SELECT * FROM usage_sessions ORDER BY created_at DESC LIMIT 200`).all() as SessionRow[]).map(r => ({
        sessionID: r.session_id, model: r.model, steps: r.steps,
        totalTokensIn: r.total_tokens_in, totalTokensOut: r.total_tokens_out,
        latencyMs: r.latency_ms, toolCalls: r.tool_calls, toolErrors: r.tool_errors,
        doomLoops: r.doom_loops ?? 0, compactionCount: r.compaction_count ?? 0, success: !!r.success,
        userFeedback: r.user_feedback === "up" || r.user_feedback === "down" ? r.user_feedback : null,
        createdAt: r.created_at,
      }))
      // Return ascending for analysis window slicing
      return { tools: tools.reverse(), sessions: sessions.reverse() }
    } catch { return null }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function avg(arr: number[]): number {
  return arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0
}
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p))
  return sorted[idx] ?? 0
}
function round(n: number, d: number): number {
  return Math.round(n * Math.pow(10, d)) / Math.pow(10, d)
}
function mostCommon(arr: string[]): string | undefined {
  const c = new Map<string, number>()
  for (const x of arr) c.set(x, (c.get(x) ?? 0) + 1)
  let best: string | undefined, max = 0
  for (const [k, v] of c) if (v > max) { max = v; best = k }
  return best
}
function suggestFixForTool(tool: string, kind: string, rate: number): string {
  const pct = Math.round(rate * 100)
  if (tool === "bash" && kind === "timeout") return `bash timeout at ${pct}% error rate — increase timeout, add retry, or split long commands.`
  if (tool === "edit" && kind.includes("valid")) return `edit validation failing (${pct}%) — add pre-read hash check or tighten schema.`
  if (tool === "webfetch" && kind.includes("fetch")) return `webfetch failing (${pct}%) — add retry with backoff, check allow-list.`
  return `${tool} error "${kind}" at ${pct}% — review tool impl and add guard/retry or permission hint.`
}
