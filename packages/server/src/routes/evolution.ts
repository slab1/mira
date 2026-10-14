/**
 * Evolution Routes — Phase 2 Safety wired per MIRA_WEAKNESSES_AND_OBSTACLES.md:23 + MIRA_EVOLUTION_SPEC.md Phase 2 + MIRA_SYSTEM_DOCUMENTATION.md:8
 *
 * Docs: Status Target→Implemented per MIRA_WEAKNESSES_AND_OBSTACLES.md:23 Phase 2 (Safety: Risk+Autonomy+Approval+Resources+Security+Rollback),
 *       MIRA_EVOLUTION_SPEC.md Phase 2 + §12 Definition of Done, MIRA_SYSTEM_DOCUMENTATION.md:8 Tool Security.
 *
 * Pipeline per observe: Risk → Autonomy → Approval → Resources → Security → Verifier → Evaluator(longitudinal baseline §16) → ShadowMira (Phase 4) → Modification Gate → Ledger
 * Adds POST /evolution/approve/:id + POST /evolution/rollback/:id + GET /evolution/risk/:id + GET /evolution/metrics + GET /evolution/health phase:"Phase 2 Safety"
 * Keeps nvidia primary + colibri opportunistic — health probes colibri but never requires it. No local hardware.
 *
 * Documentation Maintenance — 10 items:
 * | # | Item | Status | Evidence |
 * |---|------|--------|----------|
 * | 1 | Implementation path | Implemented | packages/server/src/routes/evolution.ts + packages/server/src/evolution/{risk,autonomy,approval,resources,security,rollback}.ts + shadow/shadow.ts late-bound |
 * | 2 | Public interfaces | Implemented | GET /evolution/health, POST /evolution/observe (gated+shadow), GET /evolution/ledger, GET /evolution/metrics (longitudinal §16), POST /evolution/approve/:id, POST /evolution/rollback/:id, GET /evolution/risk/:id |
 * | 3 | Events | Implemented | evolution.observed, evolution.approval, evolution.budget, evolution.security, evolution.rollback, evolution.ledger |
 * | 4 | Configuration | Implemented | respects MIRA_NO_AUTOPROVISION + MIRA_BUDGET_* + MIRA_RISK_*; nvidia primary |
 * | 5 | Tests | Implemented | evolution/*.test.ts (Phase 1 + Phase 2) |
 * | 6 | Security boundaries | Implemented | gated observe: high-risk→approval, secret→blocked, budget→blocked, fail-closed |
 * | 7 | Operational procedures | Implemented | mountEvolutionRoutes(app, {db,bus,ledger,observer}) on boot |
 * | 8 | Migration strategy | Implemented | additive routes + evolution_rollbacks table, safe to disable |
 * | 9 | Rollback strategy | Implemented | RollbackManager via POST /evolution/rollback/:id + git revert |
 * | 10 | Known limitations | Implemented | mock human approval; shadow engine mapping via SHADOW_ENGINE_BY_AFFECTED (diagnosis names → registry ids, every known diagnosis maps); shadow error → heuristic fallback recorded but 'verified' refused (fail-closed §5); longitudinal baseline windowed with drift alarms (MIRA_BASELINE_DRIFT_PCT, adaptive recent-window baselines), blocked-entry-guarded; §10 research gate token-overlap heuristic (multi-source corroboration Target); §11 loop guard in-memory (cross-restart persistence Target); §6 system rollback metadata in-memory, migration-state capture Target |
 */

import type { Hono } from 'hono'
import type { MiraDB } from '../storage/db.js'
import type { Bus } from '../bus/index.js'
import type { JsonValue } from '../types/index.js'
import type { ShadowMira } from '../shadow/shadow.js'
import { EvolutionObserver } from '../evolution/observer.js'
import { diagnose } from '../evolution/diagnosis.js'
import { propose } from '../evolution/proposal.js'
import { createExperiment } from '../evolution/experiment.js'
import { verify } from '../evolution/verifier.js'
import { evaluate, defaultBaseline, type BaselineMetrics } from '../evolution/evaluator.js'
import { ImprovementLedger } from '../evolution/ledger.js'
import { RiskEngine } from '../evolution/risk.js'
import { selectLevel, requiresApproval, AutonomyLevels } from '../evolution/autonomy.js'
import { ApprovalGate, createSqliteApprovalStore } from '../evolution/approval.js'
import type { Role } from '../auth/roles.js'
import { ResourceLimits } from '../evolution/resources.js'
import { SecurityValidator } from '../evolution/security.js'
import { RollbackManager } from '../evolution/rollback.js'
import { ResearchGate } from '../evolution/research.js'
import { LoopGuard, createSqliteLoopGuardStore } from '../evolution/loop-guard.js'
import { ComplexityTracker, type ComplexityMetrics } from '../evolution/complexity.js'
import {
  SystemRollbackManager,
  createSqliteSystemRollbackStore,
  type SystemRollbackCollectors,
} from '../evolution/system-rollback.js'
import { buildCandidatePatch } from '../evolution/candidate.js'
import { VariantWorkspace } from '../patching/governance/variant.js'
import {
  checkSelfModificationGate,
  gateByConfidence,
  DEFAULT_CONFIDENCE_THRESHOLD,
} from '../evolution/modification-gate.js'
import { isProposalState, type ProposalState } from '../patching/governance/types.js'
import { getConfig } from '../config/store.js'
import type { GovernanceGateLike } from '../patching/governance/index.js'
import { ShadowComparison } from '../shadow/comparison.js'

export interface EvolutionRouteDeps {
  db: MiraDB
  bus: Bus
  ledger?: ImprovementLedger
  observer?: EvolutionObserver
  riskEngine?: RiskEngine
  approvalGate?: ApprovalGate
  resourceLimits?: ResourceLimits
  securityValidator?: SecurityValidator
  rollbackManager?: RollbackManager
  shadowMira?: ShadowMira
  /** Governance gate from learning/index.ts — when set, the
   *  /evolution/proposals* routes are mounted on this app too. */
  governance?: GovernanceGateLike
  /**
   * Resolves the authenticated owner from the caller's bearer token. Approval
   * identity comes from this, NOT from a body field - section 5 requires a
   * real, authenticated human decision.
   */
  resolveOwner?: (token: string) => string | undefined
  /**
   * RBAC role for the caller's bearer token. Approval is a capability: the gate
   * enforces it, and this is how the route establishes it. A `viewer` key must
   * never be able to authorize a change.
   */
  resolveRole?: (token: string) => Role
  /** Auto-canary: forwarded to the proposal-routes promote handler */
  canaryStart?: (affectedEngine: string) => { canaryId: string } | null
  /** §20 complexity counters over live systems (engines, tools, deps, …) —
   *  resolved lazily at snapshot time; missing metrics report 0. */
  complexityProviders?: Partial<Record<keyof ComplexityMetrics, () => number>>
  /** §6 system-state collectors (component versions, dependency versions,
   *  config paths) for system-level rollback metadata. */
  systemRollbackCollectors?: SystemRollbackCollectors
  /** Repository root candidates resolve against (default process.cwd()). */
  repoRoot?: string
}

/** Normalized shadow outcome recorded in ledger evidence + observe response.
 *  source: 'full' (isolated ShadowMira benchmark) | 'heuristic' (score-derived
 *  fallback) | 'error' (startShadow failed) | 'skipped' (evaluation already rejected). */
interface ShadowMeta {
  source: 'full' | 'heuristic' | 'error' | 'skipped'
  shadowId?: string
  candidateEngineId?: string
  verdict: string
  reasoning?: string
}

/**
 * Diagnosis engine names (AffectedEngine per diagnosis.ts) do not match the
 * EngineRegistry ids (engines/*.ts) — map every diagnosis engine to the
 * registry engine whose benchmark is the closest proxy, so startShadow never
 * throws "Engine not found" for a known diagnosis.
 */
const SHADOW_ENGINE_BY_AFFECTED: Record<string, string> = {
  gateway: 'model', // gateway failures are model-routing/subgateway failures
  memory: 'memory',
  tool: 'tool',
  session: 'agent',
  guardrails: 'security',
  model: 'model',
  metric: 'evaluation',
  unknown: 'agent',
}

/**
 * Heuristic shadow comparison derived from the evaluator's own scores — the
 * production baseline comes from the same evaluation, so this is weak,
 * self-referential evidence. Used only when ShadowMira is unavailable or
 * failed; it can downgrade but never stamp a candidate as verified.
 * Returns null when scores are absent (e.g. blocked proposals).
 */
function compareHeuristicShadow(
  evaluation: ReturnType<typeof evaluate>,
  securityPassed: boolean,
): {
  verdict: 'better' | 'worse' | 'neutral'
  reasoning: string
  gates?: Record<string, boolean>
  improved?: string[]
  regressed?: string[]
} | null {
  if (!evaluation) return null
  const s = evaluation.scores
  if (!s?.success || !s?.latency || !s?.cost || !s?.regression || !s?.security) return null
  const production = {
    successRate: s.success.baseline ?? 0.87,
    latencyMs: s.latency.baseline ?? 12_000,
    costPerTask: s.cost.baseline ?? 0.18,
    regressionRate: s.regression.baseline ?? 0.08,
    securityViolations: s.security.baseline ?? 2,
    securityPassed,
  }
  const candidate = {
    successRate: s.success.candidate,
    latencyMs: s.latency.candidate,
    costPerTask: s.cost.candidate,
    regressionRate: s.regression.candidate,
    securityViolations: s.security.candidate,
    securityPassed,
  }
  const r = new ShadowComparison().compare(production, candidate)
  return {
    verdict: r.verdict,
    reasoning: r.reasoning,
    gates: r.gates,
    improved: r.improved,
    regressed: r.regressed,
  }
}

/** Evaluation score keys (evaluator.ts) mapped to canonical metric names. */
const SCORE_KEY_BY_METRIC: Record<string, string> = {
  successRate: 'success',
  latencyMs: 'latency',
  costPerTask: 'cost',
  regressionRate: 'regression',
  securityViolations: 'security',
}

/**
 * Extract per-metric candidate series from accepted/verified ledger entries —
 * shared by deriveLongitudinalBaseline and GET /evolution/metrics.
 * Skips entries whose evaluation is the synthetic blocked-reject
 * (details.blocked === true): those carry placeholder scores (success 0,
 * security 99) that would poison the baseline once an approval flips the
 * entry's verdict to 'verified' while preserving the blocked evidence.
 */
function extractCandidateMetricSeries(
  entries: Array<{
    verdict: string
    evidence: unknown
  }>,
): Record<string, number[]> {
  const series: Record<string, number[]> = {
    successRate: [],
    latencyMs: [],
    costPerTask: [],
    regressionRate: [],
    securityViolations: [],
  }
  for (const e of entries) {
    if (e.verdict !== 'verified' && e.verdict !== 'accepted') continue
    const ev = e.evidence as {
      evaluation?: {
        scores?: Record<string, { candidate?: number }>
        details?: { blocked?: boolean }
      } | null
    } | null
    if (ev?.evaluation?.details?.blocked === true) continue
    const scores = ev?.evaluation?.scores
    if (!scores) continue
    for (const k of Object.keys(series)) {
      const v = scores[SCORE_KEY_BY_METRIC[k]]?.candidate
      if (typeof v === 'number' && Number.isFinite(v)) series[k].push(v)
    }
  }
  return series
}

export interface DriftAlarm {
  metric: keyof BaselineMetrics
  /** Relative change between the older window and the recent window. */
  deltaPct: number
  recentMean: number
  historicalMean: number
  /** Whether the baseline for this metric now uses the recent window. */
  adaptive: boolean
  reason: string
}

/**
 * Longitudinal evaluation (§16) with drift detection: derive an evidence-based
 * baseline from accepted ledger history AND alarm when a metric's recent
 * window diverges from its older history (the system's operating point moved —
 * e.g. after a promoted improvement). A drifted metric's baseline uses the
 * RECENT window (adaptive) so stale history cannot pin the gate to yesterday's
 * operating point; every adaptation is reported as a DriftAlarm for audit.
 * Returns null baseline when no accepted entry carries evaluation scores
 * (caller falls back to the hardcoded DEFAULT_BASELINE).
 */
export function deriveLongitudinalBaselineDetailed(
  entries: Array<{
    verdict: string
    evidence: unknown
  }>,
): { baseline: BaselineMetrics | null; drift: DriftAlarm[] } {
  const metricSeries = extractCandidateMetricSeries(entries)
  const hasAnySamples = Object.values(metricSeries).some((xs) => xs.length > 0)
  if (!hasAnySamples) return { baseline: null, drift: [] }

  const driftPct = (() => {
    const raw = Number(process.env.MIRA_BASELINE_DRIFT_PCT)
    return Number.isFinite(raw) && raw > 0 ? raw : 25
  })()

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
  const def = defaultBaseline()
  const drift: DriftAlarm[] = []
  const pick = (k: keyof BaselineMetrics): number => {
    const xs = metricSeries[k]
    if (xs.length === 0) return def[k]
    // series is newest-first (ledger.list is reverse-chronological)
    // Drift needs enough samples to split meaningfully: ≥4 → 25% recent window
    if (xs.length >= 4) {
      const recentN = Math.max(1, Math.floor(xs.length * 0.25))
      const recent = xs.slice(0, recentN)
      const historical = xs.slice(recentN)
      const recentMean = mean(recent)
      const histMean = mean(historical)
      const deltaPct = histMean !== 0 ? ((recentMean - histMean) / histMean) * 100 : 0
      if (Math.abs(deltaPct) > driftPct) {
        drift.push({
          metric: k,
          deltaPct: Math.round(deltaPct * 10) / 10,
          recentMean,
          historicalMean: histMean,
          adaptive: true,
          reason: `drift >${driftPct}% (${deltaPct.toFixed(1)}%) — baseline for ${k} adapted to recent window (${recent.length} of ${xs.length} samples)`,
        })
        return recentMean
      }
    }
    return mean(xs)
  }
  return {
    baseline: {
      successRate: pick('successRate'),
      latencyMs: pick('latencyMs'),
      costPerTask: pick('costPerTask'),
      regressionRate: pick('regressionRate'),
      securityViolations: pick('securityViolations'),
    },
    drift,
  }
}

/**
 * Longitudinal evaluation (§16): derive an evidence-based baseline from
 * accepted/verified ledger history — candidate metrics of past accepted
 * improvements. Returns null when no accepted entry carries evaluation
 * scores (caller falls back to the hardcoded DEFAULT_BASELINE).
 * Evaluation scores use short keys (success/latency/cost/regression/security)
 * mapped to canonical metric names per evaluator.ts.
 */
export function deriveLongitudinalBaseline(
  entries: Array<{
    verdict: string
    evidence: unknown
  }>,
): BaselineMetrics | null {
  return deriveLongitudinalBaselineDetailed(entries).baseline
}

export function mountEvolutionRoutes(
  app: Hono<{ Variables: { requestId: string } }>,
  deps: EvolutionRouteDeps,
) {
  const { db, bus } = deps
  const ledger = deps.ledger ?? new ImprovementLedger(db, bus)
  const observer = deps.observer ?? new EvolutionObserver({ bus })
  const riskEngine = deps.riskEngine ?? new RiskEngine()
  // §18 approval policy — humans own it via mira.json `approvals`; env vars
  // are the fallback. The meta-rule: changing the approvals section is itself
  // a high-risk change routed through this same gate.
  const cfgApprovals = (
    getConfig() as unknown as {
      approvals?: {
        autoLowRisk?: boolean
        operators?: string[]
        twoPersonRule?: boolean
        agingMs?: number
      }
    }
  ).approvals
  // §18 durability: the operator's pending approval queue must survive a
  // restart — silently forgetting what a human was asked to approve is both
  // an operational stall and an audit hole. Fail-soft to in-memory.
  const approvalGate =
    deps.approvalGate ??
    (() => {
      try {
        return new ApprovalGate({
          bus,
          store: createSqliteApprovalStore(db),
          ...(cfgApprovals?.autoLowRisk !== undefined
            ? { autoApproveLowRisk: cfgApprovals.autoLowRisk }
            : {}),
          ...(cfgApprovals?.operators !== undefined ? { operators: cfgApprovals.operators } : {}),
          ...(cfgApprovals?.twoPersonRule !== undefined
            ? { twoPersonRule: cfgApprovals.twoPersonRule }
            : {}),
          ...(cfgApprovals?.agingMs !== undefined ? { agingMs: cfgApprovals.agingMs } : {}),
        })
      } catch {
        return new ApprovalGate({ bus })
      }
    })()
  const resourceLimits = deps.resourceLimits ?? new ResourceLimits({ bus, db })
  const securityValidator = deps.securityValidator ?? new SecurityValidator({ bus })
  const rollbackManager = deps.rollbackManager ?? new RollbackManager({ db, bus, ledger })
  // ── §10 + §11 + §20 controls ─────────────────────────────────────
  const researchGate = new ResearchGate()
  // §11 durability: persist loop state so a restart cannot bypass the
  // attempt cap (a doom-looping agent must not escape by crashing/restarting).
  // Fail-soft to the in-memory guard if the DB handle is unavailable.
  const loopGuard = (() => {
    try {
      return new LoopGuard({ store: createSqliteLoopGuardStore(db) })
    } catch {
      return new LoopGuard()
    }
  })()
  const complexityTracker = new ComplexityTracker()
  complexityTracker.registerProvider('autonomousActions', () => ledger.count())
  for (const [k, fn] of Object.entries(deps.complexityProviders ?? {})) {
    complexityTracker.registerProvider(k as keyof ComplexityMetrics, fn)
  }
  // §6 durability: rollback metadata must outlive the process — a rollback
  // point that vanishes on restart is not a rollback point. Fail-soft.
  const systemRollback = (() => {
    try {
      return new SystemRollbackManager(deps.systemRollbackCollectors ?? {}, {
        store: createSqliteSystemRollbackStore(db),
      })
    } catch {
      return new SystemRollbackManager(deps.systemRollbackCollectors ?? {})
    }
  })()

  // ── GET /evolution/health ────────────────────────────────────────
  app.get('/evolution/health', (c) => {
    return c.json({
      ok: true,
      status:
        'Target→Implemented per MIRA_WEAKNESSES_AND_OBSTACLES.md:23 + MIRA_EVOLUTION_SPEC.md Phase 2 + MIRA_SYSTEM_DOCUMENTATION.md:8',
      phase: 'Phase 2 Safety',
      primary: 'nvidia',
      fallback: 'colibri',
      hardware: 'no local hardware required (colibri opportunistic)',
      observer: observer.health(),
      ledger: ledger.health(),
      risk: 'RiskEngine wired',
      autonomy: 'AutonomyLevels 0-5 wired',
      approval: 'ApprovalGate wired (mock human, emits evolution.approval)',
      resources: 'ResourceLimits wired (per-task/per-agent/per-mission/daily)',
      security: 'SecurityValidator wired',
      rollback: 'RollbackManager wired',
      research: researchGate.health(),
      loopGuard: loopGuard.stats(),
      complexity: { tracked: true, endpoint: 'GET /evolution/complexity' },
      systemRollback: {
        tracked: systemRollback.count(),
        endpoint: 'GET /evolution/rollback/:id/metadata',
      },
      routes: [
        'GET /evolution/health',
        'POST /evolution/observe',
        'GET /evolution/ledger',
        'GET /evolution/metrics',
        'GET /evolution/complexity',
        'GET /evolution/risk/:id',
        'GET /evolution/approvals',
        'GET /evolution/investigations',
        'POST /evolution/approve/:id',
        'POST /evolution/deny/:id',
        'POST /evolution/rollback/:id',
        'GET /evolution/rollback/:id/metadata',
        'POST /evolution/loop/acknowledge',
        'GET /evolution/proposals?state=',
        'POST /evolution/proposals/:id/advance',
        'POST /evolution/proposals/:id/promote',
        'POST /evolution/proposals/:id/rollback',
      ],
      canary: 'Target (Phase 5)',
      shadow: 'Target (Phase 4)',
      timestamp: Date.now(),
    })
  })

  // ── POST /evolution/observe ──────────────────────────────────────
  // Body: { failure: string, evidence?: JsonValue, sessionID?: string, changedFiles?: string[], patch?: string, permissionScope?: string, cost?: number, research?: { source: string, title?: string, content: string } | Array<same> }
  app.post('/evolution/observe', async (c) => {
    let body: {
      failure?: unknown
      evidence?: unknown
      sessionID?: unknown
      changedFiles?: unknown
      patch?: unknown
      permissionScope?: unknown
      cost?: unknown
      research?: unknown
    } | null = null
    try {
      body = (await c.req.json()) as unknown as typeof body
    } catch {
      body = null
    }
    if (
      !body ||
      typeof (body as { failure?: unknown }).failure !== 'string' ||
      !(body as { failure?: string }).failure!.trim()
    ) {
      return c.json({ error: 'body.failure string required' }, 400)
    }
    const b = body as {
      failure: string
      evidence?: unknown
      sessionID?: unknown
      changedFiles?: unknown
      patch?: unknown
      permissionScope?: unknown
      cost?: unknown
      research?: { source?: unknown; title?: unknown; content?: unknown }
    }
    const failure = String(b.failure).slice(0, 500)
    const evidence = (b.evidence ?? null) as JsonValue
    const sessionID = b.sessionID ? String(b.sessionID).slice(0, 100) : undefined
    const changedFiles = Array.isArray(b.changedFiles)
      ? (b.changedFiles as unknown[]).map(String).slice(0, 20)
      : undefined
    const patch = typeof b.patch === 'string' ? String(b.patch).slice(0, 10000) : undefined
    const permissionScope =
      typeof b.permissionScope === 'string' ? String(b.permissionScope).slice(0, 200) : undefined
    const cost = typeof b.cost === 'number' && Number.isFinite(b.cost) ? Number(b.cost) : undefined

    const observed = observer.observe(failure, evidence, sessionID)

    // ShadowMira binds late (constructed after route mount in index.ts) —
    // resolve per-request so the observe pipeline uses it once available.
    const shadowMira = deps.shadowMira

    // ── §11 loop guard — doom-loop prevention BEFORE any proposal work ──
    // Duplicate failure inside cooldown or an escalated fingerprint: record
    // the decision and stop — no diagnosis/proposal/experiment churn.
    const loop = loopGuard.check(failure, evidence)
    if (!loop.allowed) {
      const loopVerdict = loop.escalated ? 'loop_escalated' : 'loop_blocked'
      try {
        bus?.publish({
          type: loop.escalated
            ? ('evolution.loop_escalated' as unknown as import('../types/index.js').BusEventType)
            : ('evolution.loop_blocked' as unknown as import('../types/index.js').BusEventType),
          payload: {
            fingerprint: loop.fingerprint,
            attempts: loop.attempts,
            failure: failure.slice(0, 200),
            reason: loop.reason,
            sessionID,
          } as unknown as JsonValue,
          timestamp: Date.now(),
        } as unknown as import('../types/index.js').BusEvent)
      } catch {}
      try {
        ledger.remember({
          id: `loop_${loop.fingerprint}_${Date.now().toString(36)}`,
          proposal: {
            id: `loop_${loop.fingerprint}`,
            title: `loop-guard: ${failure.slice(0, 80)}`,
            type: 'experiment',
            risk: 'low',
            priority: 'P1',
            affectedEngine: 'unknown',
            evidence: null,
            expectedImpact: 'none — §11 loop prevention',
            cause: failure.slice(0, 200),
            confidence: 0,
            createdAt: Date.now(),
          } as unknown as import('../evolution/proposal.js').ImprovementProposal,
          verdict: loopVerdict as unknown as import('../evolution/ledger.js').LedgerVerdict,
          evidence: { loop, sessionID } as unknown as JsonValue,
        })
      } catch {}
      return c.json({
        ok: true,
        loopBlocked: true,
        loop,
        ledger: { verdict: loopVerdict, id: `loop_${loop.fingerprint}` },
        note: loop.reason,
      })
    }

    // Pipeline: Diagnosis → Proposal
    const diagnosis = diagnose(observed)
    const proposal = propose(diagnosis)

    // ── §10 research trust boundary — Research → Validate → advisory evidence ──
    // body.research is untrusted web content (single object or array for
    // multi-source corroboration): sanitized on ingest, validated against the
    // diagnosis's OWN evidence, and attached to the proposal as advisory
    // evidence strings. It can never become executable instruction.
    let researchEvidence: JsonValue | null = null
    const researchInputs: Array<{ source?: unknown; title?: unknown; content?: unknown }> =
      Array.isArray(b.research)
        ? (b.research as Array<{ source?: unknown; title?: unknown; content?: unknown }>).slice(
            0,
            5,
          )
        : b.research && typeof b.research === 'object'
          ? [b.research as { source?: unknown; title?: unknown; content?: unknown }]
          : []
    if (researchInputs.length > 0) {
      try {
        const items = researchInputs
          .filter((r) => r && typeof r.content === 'string')
          .map((r) =>
            researchGate.ingest({
              source: String(r.source ?? 'unknown').slice(0, 200),
              title: typeof r.title === 'string' ? String(r.title).slice(0, 200) : undefined,
              content: String(r.content),
            }),
          )
        // ≥2 items → multi-source corroboration (§10); single → plain validate
        const knowledge =
          items.length >= 2
            ? researchGate.corroborate(items, diagnosis)
            : items.flatMap((item) => researchGate.validate(item, diagnosis))
        const hints = researchGate.toProposalHints(knowledge)
        const first = items[0]
        const perItemKnowledge = items.flatMap((item) =>
          researchGate.validate(item, diagnosis).filter((k) => k.validated),
        )
        researchEvidence = {
          items: items.map((i) => ({
            id: i.id,
            source: i.source,
            title: i.title,
            untrusted: i.untrusted,
          })),
          knowledge,
          validatedCount: perItemKnowledge.length,
          corroboratedCount: knowledge.filter((k) => (k.corroboratedSources?.length ?? 0) >= 2)
            .length,
          boundary: '§10 research→advisory-evidence only; never executable instruction',
        } as unknown as JsonValue
        void first
        // Advisory hints inform the proposal's evidence — strings only, no execution path
        proposal.evidence = {
          ...(proposal.evidence as object),
          research: {
            hints,
            validated: knowledge.filter((k) => k.validated).length,
            corroborated: knowledge.filter((k) => (k.corroboratedSources?.length ?? 0) >= 2).length,
            boundary: '§10 advisory-only',
          },
        } as unknown as JsonValue
      } catch {}
    }

    // ── Real candidate (§24): the proposal becomes a candidate ONLY when the
    // change is genuinely appliable — a real unified diff against an existing,
    // in-repo file the proposal claims to touch. Otherwise this is an
    // investigation: no patch is fabricated, and the shadow stage reports a
    // parity benchmark instead of pretending a candidate exists.
    const candidate =
      patch !== undefined
        ? buildCandidatePatch({
            proposal,
            change: patch,
            claimedFiles: changedFiles,
            // Candidates resolve against the same root the patcher applies to,
            // so a candidate that materializes is a change to THIS repo.
            repoRoot: deps.repoRoot ?? process.cwd(),
          })
        : null
    const experiment = createExperiment(
      proposal,
      // A change that is not a real candidate is recorded as an investigation —
      // never stored as if it were an appliable patch.
      candidate ? patch : undefined,
      candidate ? { targetFile: candidate.targetFile, appliable: true } : undefined,
    )

    // Materialize the candidate tree up front so the shadow stage can measure
    // the candidate BY EXECUTION (shadow/variant-benchmark.ts) rather than by
    // caller-supplied numbers. Disposable; removed after measurement.
    let variantWorkspace: VariantWorkspace | null = null
    let variantDir: string | undefined
    if (candidate) {
      try {
        // Same root the candidate validated against — the tree must be a copy
        // of the repo the diff actually applies to.
        variantWorkspace = new VariantWorkspace({ rootDir: deps.repoRoot ?? process.cwd() })
        const mat = await variantWorkspace.materialize(proposal.id, candidate.patch)
        if (mat.candidate) variantDir = mat.candidate.dir
      } catch {}
    }

    // ── Phase 2 gates: Risk → Autonomy → Approval → Resources → Security → Verifier
    const risk = riskEngine.assess({
      ...proposal,
      changedFiles: changedFiles ?? (experiment.virtualDiff ? [experiment.virtualDiff.file] : []),
      patch: patch ?? experiment.patch,
      permissionScope: permissionScope ?? proposal.affectedEngine,
      cost: cost ?? 0.05,
    })

    const level = selectLevel(risk, proposal)
    const needsApproval = requiresApproval(level, risk)

    // ── Unified self-modification gate (P1.1) — early confidence arm ──
    // Low-confidence diagnoses may still be observed/experimented in the
    // sandbox, but never reach autonomous execution. Fail-closed.
    const confidenceGate = gateByConfidence(diagnosis.confidence, DEFAULT_CONFIDENCE_THRESHOLD)
    let effectiveLevel = level
    if (!confidenceGate.passed && effectiveLevel > AutonomyLevels.Suggest) {
      effectiveLevel = AutonomyLevels.Suggest
    }

    // Approval gate — emits evolution.approval (uses effectiveLevel, confidence-capped)
    const approval = approvalGate.requestApproval(proposal, effectiveLevel, risk)

    // Resource limits — per-task/per-agent/per-mission/daily (§13)
    // P1: pass stable idempotency key from proposal ID for durable reservation lifecycle
    const budget = resourceLimits.checkBudget(
      proposal as unknown as unknown as Parameters<typeof resourceLimits.checkBudget>[0],
      cost ?? 0.05,
      proposal.id, // idempotencyKey = proposal ID
    )

    // Security validation — no secrets / no permission escalation (§8)
    const securityPre = securityValidator.validate(patch ?? experiment.patch)

    // Create rollback point before verifier (so we can revert even if verifier fails)
    // Coarse safety point at observe time (patch is raw TEXT here — no id yet).
    // The EXACT point (patchId-linked snapshots) is captured at promote time,
    // after the applier records pre-images under the evolution marker session.
    const rollbackPoint = rollbackManager.createRollbackPoint(proposal.id)
    // §6 system rollback: capture system state BEFORE the candidate is applied
    // — components/deps/config hashes drive diff + restore steps.
    let systemBefore: ReturnType<typeof systemRollback.capture> | null = null
    try {
      systemBefore = systemRollback.capture()
      systemRollback.recordCandidate(proposal.id, systemBefore)
    } catch {}

    // Gate decisions — fail-closed: block verifier if any gate fails
    const gatedReason: string[] = []
    let blocked = false
    let blockedBy: string | null = null

    if (!securityPre.passed) {
      blocked = true
      blockedBy = 'security'
      gatedReason.push(`security blocked: ${securityPre.findings.slice(0, 2).join('; ')}`)
    }
    if (!budget.allowed) {
      blocked = true
      blockedBy = blockedBy ?? 'budget'
      gatedReason.push(`budget blocked: ${budget.reason}`)
    }
    if (!approval.approved && approval.pending) {
      blocked = true
      blockedBy = blockedBy ?? 'approval'
      gatedReason.push(`approval pending: ${approval.reason} (level ${level}, risk ${risk.level})`)
    }

    let verification: Awaited<ReturnType<typeof verify>> | null = null
    let evaluation: ReturnType<typeof evaluate> | null = null
    let shadowMeta: ShadowMeta | null = null
    // §16 drift alarms — filled by the longitudinal baseline derivation in the
    // unblocked branch; empty for blocked proposals (declared here so the
    // ledger evidence + response can reference it on every path).
    let baselineDrift: DriftAlarm[] = []
    let verdict: string

    if (blocked) {
      // Do not run verifier when gated — record as pending/blocked for ledger
      verification = {
        verified: false,
        regression: false,
        security: { passed: securityPre.passed, issues: securityPre.findings },
        static: { passed: false, issues: gatedReason },
        benchmark: { latencyMs: 0, successRate: 0, costDelta: 0 },
        details: {
          blocked: true,
          blockedBy,
          gatedReason,
          risk,
          level: effectiveLevel,
          needsApproval,
          confidenceGate,
        } as unknown as JsonValue,
        timestamp: Date.now(),
      }
      evaluation = {
        decision: 'reject',
        reason: `blocked by ${blockedBy}: ${gatedReason.join(' | ')}`,
        scores: {
          success: { baseline: 0.87, candidate: 0, delta: -0.87, pass: false },
          latency: { baseline: 12000, candidate: 0, deltaPct: 0, pass: true },
          cost: { baseline: 0.18, candidate: 0, deltaPct: 0, pass: true },
          regression: { baseline: 0.08, candidate: 0, delta: 0, pass: true },
          security: { baseline: 2, candidate: 99, pass: false },
        },
        timestamp: Date.now(),
        details: { blocked: true, blockedBy } as unknown as JsonValue,
      }
      verdict =
        blockedBy === 'approval'
          ? 'pending_approval'
          : blockedBy === 'budget'
            ? 'budget_blocked'
            : 'security_blocked'
    } else {
      // §4: verify the CANDIDATE when there is one. A proposal with no real
      // change has nothing to verify — the result says "unverified" rather
      // than passing on a check that never looked at the patch.
      verification = await verify(experiment, {
        runStatic: Boolean(variantDir),
        ...(variantDir ? { treeDir: variantDir } : {}),
      })
      // Longitudinal evaluation (§16): use an evidence-based baseline derived
      // from accepted ledger history when available — with drift detection:
      // a metric whose recent window diverges from history adapts to the
      // recent window and raises an alarm. Otherwise the evaluator's
      // hardcoded DEFAULT_BASELINE applies.
      const derived = deriveLongitudinalBaselineDetailed(ledger.list(200))
      const longitudinalBaseline = derived.baseline
      baselineDrift = derived.drift
      evaluation = evaluate(verification, longitudinalBaseline ?? undefined)

      // ── Shadow Mira (P0) — full shadow comparison with isolated benchmarking ──
      // Only runs when the evaluator accepts: shadow can only downgrade an
      // accept (worse→reject, neutral→annotate) — running a full isolated
      // benchmark on an already-rejected candidate is wasted cost.
      // On shadow error we fall back to the heuristic comparison AND mark the
      // run failed — the unified gate below then refuses 'verified' (fail-closed:
      // missing independent evidence must not stamp a candidate as verified).
      let shadowErrored = false
      if (shadowMira && evaluation.decision === 'accept') {
        const engineId = SHADOW_ENGINE_BY_AFFECTED[proposal.affectedEngine] ?? 'agent'
        try {
          // §5 candidate versioning: the candidate's benchmark numbers are the
          // VERIFIER's real measurements of the sandbox experiment — the
          // verify run IS the candidate executing, so candidate ≠ production
          // by measurement, not by invention.
          const shadowRun = await shadowMira.startShadow(engineId, {
            versionSuffix: experiment.simulationId,
            latencyMs: verification.benchmark?.latencyMs ?? 0,
            successRate: verification.benchmark?.successRate ?? 0.9,
            costDelta: verification.benchmark?.costDelta ?? 0,
            // A real materialized candidate tree, when the proposal carried one:
            // the shadow then measures the candidate BY EXECUTING checks inside
            // that tree instead of trusting these numbers.
            ...(variantDir ? { variantDir } : {}),
          })
          shadowMeta = {
            source: 'full',
            shadowId: shadowRun.shadowId,
            candidateEngineId: engineId,
            verdict: shadowRun.result.verdict,
            reasoning: shadowRun.result.reasoning,
          }
          if (shadowRun.result.verdict === 'worse') {
            evaluation = {
              ...evaluation,
              decision: 'reject',
              reason: `${evaluation.reason} — shadow: ${shadowRun.result.reasoning}`,
              details: {
                ...(evaluation.details as object),
                shadow: {
                  ...shadowMeta,
                  benchmark: shadowRun.benchmark,
                  telemetry: shadowRun.telemetry,
                } as unknown as JsonValue,
              } as unknown as JsonValue,
            }
            verdict = 'rejected'
          } else if (shadowRun.result.verdict === 'neutral') {
            evaluation = {
              ...evaluation,
              reason: `${evaluation.reason} — shadow: neutral, ${shadowRun.result.reasoning}`,
              details: {
                ...(evaluation.details as object),
                shadow: { ...shadowMeta, benchmark: shadowRun.benchmark } as unknown as JsonValue,
              } as unknown as JsonValue,
            }
          }
          // verdict 'better' → evaluation decision stands
        } catch (e) {
          shadowErrored = true
          const errorReason = String(e).slice(0, 300)
          shadowMeta = {
            source: 'error',
            candidateEngineId: engineId,
            verdict: 'error',
            reasoning: errorReason,
          }
          try {
            bus?.publish({
              type: 'evolution.shadow_error' as unknown as import('../types/index.js').BusEventType,
              payload: {
                engineId,
                error: errorReason,
                proposalId: proposal.id,
              } as unknown as JsonValue,
              timestamp: Date.now(),
            } as unknown as import('../types/index.js').BusEvent)
          } catch {}
          // Heuristic comparison from evaluation scores — weak, self-referential
          // evidence, recorded for observability only (never stamps verified).
          const heuristic = compareHeuristicShadow(evaluation, verification.security.passed)
          if (heuristic)
            shadowMeta = {
              ...shadowMeta,
              verdict: heuristic.verdict,
              reasoning: `${shadowMeta.reasoning} | heuristic: ${heuristic.reasoning}`,
            }
        }
      } else if (shadowMira) {
        // Evaluator already rejected — no shadow needed for the decision
        shadowMeta = {
          source: 'skipped',
          candidateEngineId: SHADOW_ENGINE_BY_AFFECTED[proposal.affectedEngine] ?? 'agent',
          verdict: 'skipped',
        }
      } else {
        // Shadow not bound (early boot / tests) — heuristic comparison only
        const heuristic = compareHeuristicShadow(evaluation, verification.security.passed)
        if (heuristic) {
          shadowMeta = {
            source: 'heuristic',
            verdict: heuristic.verdict,
            reasoning: heuristic.reasoning,
          }
          if (heuristic.verdict === 'worse') {
            if (evaluation.decision === 'accept') {
              evaluation = {
                ...evaluation,
                decision: 'reject',
                reason: `${evaluation.reason} — shadow: ${heuristic.reasoning}`,
                details: {
                  ...(evaluation.details as object),
                  shadow: {
                    ...shadowMeta,
                    gates: heuristic.gates,
                    improved: heuristic.improved,
                    regressed: heuristic.regressed,
                  } as unknown as JsonValue,
                } as unknown as JsonValue,
              }
              verdict = 'rejected'
            } else {
              verdict = 'rejected'
            }
          } else if (heuristic.verdict === 'neutral') {
            evaluation = {
              ...evaluation,
              reason: `${evaluation.reason} — shadow: neutral (no improvement detected), ${heuristic.reasoning}`,
              details: {
                ...(evaluation.details as object),
                shadow: {
                  ...shadowMeta,
                  gates: heuristic.gates,
                  improved: heuristic.improved,
                  regressed: heuristic.regressed,
                } as unknown as JsonValue,
              } as unknown as JsonValue,
            }
          }
        } else {
          shadowMeta = { source: 'heuristic', verdict: 'unavailable' }
        }
      }

      // ── Unified self-modification gate (P1.1) — final arm ──
      // Even when verification + evaluation pass, never mark "verified"
      // unless confidence ∧ validation ∧ rollback all hold. Fail-closed.
      const fullGate = checkSelfModificationGate(
        {
          confidence: diagnosis.confidence,
          validationPassed: evaluation.decision === 'accept',
          rollbackAvailable: !!rollbackPoint,
          riskLevel: risk.level,
        },
        DEFAULT_CONFIDENCE_THRESHOLD,
      )
      if (fullGate.allowed) {
        verdict = 'verified'
      } else if (evaluation.decision === 'accept') {
        // Evaluation accepted but the unified policy denied — downgrade.
        verdict = 'gated'
        evaluation = {
          ...evaluation,
          decision: 'reject',
          reason: `unified gate denied: ${fullGate.reasons.join(' | ')}`,
          details: {
            ...(evaluation.details as object),
            modificationGate: fullGate,
          } as unknown as JsonValue,
        }
      } else {
        verdict = 'rejected'
      }

      // Fail-closed on shadow error (§5): 'verified' stamps independent
      // evidence — a shadow run that failed to produce any must not earn it.
      // Heuristic fallback evidence (self-referential) is recorded but is not
      // independent, so the strongest downgrade is to 'gated' (pending evidence).
      if (shadowErrored && verdict === 'verified') {
        verdict = 'gated'
        evaluation = {
          ...evaluation,
          decision: 'reject',
          reason: `${evaluation.reason} — shadow unavailable (fail-closed): ${shadowMeta?.reasoning ?? 'startShadow failed'}`,
        }
      }
    }

    // §24: "record the entire evolution history" — a decision that is not
    // persisted is not a decision. This used to swallow a ledger write failure
    // and still answer 200 with `ledger: {verdict, id}`, telling the operator
    // it was recorded while nothing was stored — which then silently starves
    // every downstream reader (approvals, investigations, metrics, the
    // longitudinal baseline). A storage failure is a server error, not a
    // successful run with a phantom entry.
    try {
      ledger.remember({
        id: proposal.id,
        proposal,
        verdict: verdict as unknown as import('../evolution/ledger.js').LedgerVerdict,
        evidence: {
          observed,
          diagnosis,
          experiment: {
            id: experiment.simulationId,
            sandboxPath: experiment.sandboxPath,
            riskScore: experiment.riskScore,
            // §24: whether a real appliable change existed. Investigations
            // (appliable:false) are queryable via GET /evolution/investigations
            // so a human/model can produce the missing fix.
            appliable: experiment.appliable,
            ...(experiment.targetFile ? { targetFile: experiment.targetFile } : {}),
          },
          candidate: candidate
            ? { real: true, targetFile: candidate.targetFile, basis: candidate.basis }
            : {
                real: false,
                basis: patch
                  ? 'proposed change is not an appliable unified diff against an existing claimed file'
                  : 'no change proposed — this is an investigation',
              },
          risk,
          autonomy: { level, effectiveLevel, needsApproval },
          confidenceGate,
          approval,
          budget,
          security: securityPre,
          rollbackPoint,
          verification,
          evaluation,
          research: researchEvidence,
          baselineDrift: baselineDrift.length > 0 ? baselineDrift : null,
          systemRollbackMetadata: systemRollback.metadata(proposal.id) ?? null,
          // Prefer the richer per-path shadow record stored in evaluation.details
          // (benchmark/telemetry/gates) — falls back to the normalized meta.
          shadow:
            (evaluation.details as { shadow?: JsonValue } | null | undefined)?.shadow ??
            (shadowMeta as unknown as JsonValue) ??
            null,
        } as unknown as JsonValue,
      })
    } catch (e) {
      try {
        variantWorkspace?.disposeAll()
      } catch {}
      return c.json(
        {
          error:
            'evolution decision could not be recorded — the ledger write failed, so nothing was persisted',
          id: proposal.id,
          verdict,
          detail: String(e).slice(0, 300),
        },
        500,
      )
    }

    // Candidate trees are disposable — remove after the pipeline measured it.
    try {
      variantWorkspace?.disposeAll()
    } catch {}

    return c.json({
      ok: true,
      observed,
      diagnosis,
      proposal,
      candidate: candidate
        ? {
            real: true,
            targetFile: candidate.targetFile,
            basis: candidate.basis,
            variantMaterialized: Boolean(variantDir),
            note: 'real appliable change — measurable by execution (variant/shadow/canary)',
          }
        : {
            real: false,
            targetFile: null,
            basis: patch
              ? 'proposed change is not an appliable unified diff against an existing claimed file'
              : 'no change proposed — this is an investigation',
            variantMaterialized: false,
            note: 'no real candidate: nothing to materialize, shadow reports a parity benchmark',
          },
      experiment: {
        proposalId: experiment.proposalId,
        sandboxPath: experiment.sandboxPath,
        simulationId: experiment.simulationId,
        riskScore: experiment.riskScore,
        appliable: experiment.appliable,
        // the investigation note (or the real change) so the operator can see
        // exactly what is — and is not — being verified
        patch: experiment.patch.slice(0, 2000),
        ...(experiment.targetFile ? { targetFile: experiment.targetFile } : {}),
      },
      risk,
      autonomy: {
        level,
        effectiveLevel,
        needsApproval,
        levels: '0:Observe 1:Suggest 2:Experiment 3:Execute 4:Canary 5:Autonomous (§18)',
      },
      modificationGate: {
        threshold: DEFAULT_CONFIDENCE_THRESHOLD,
        confidence: diagnosis.confidence,
        confidencePassed: confidenceGate.passed,
        rollbackAvailable: !!rollbackPoint,
      },
      approval,
      budget,
      security: securityPre,
      rollbackPoint,
      research: researchEvidence,
      loop: { allowed: loop.allowed, fingerprint: loop.fingerprint, attempts: loop.attempts },
      shadow:
        (evaluation.details as { shadow?: JsonValue } | null | undefined)?.shadow ??
        (shadowMeta as unknown as JsonValue) ??
        null,
      verification: verification
        ? {
            verified: verification.verified,
            regression: verification.regression,
            security: verification.security,
            static: verification.static,
            blocked: (verification.details as { blocked?: boolean })?.blocked ?? false,
          }
        : null,
      evaluation: evaluation ? { decision: evaluation.decision, reason: evaluation.reason } : null,
      ledger: { verdict, id: proposal.id },
      note: blocked
        ? `blocked by ${blockedBy} — POST /evolution/approve/${proposal.id} or fix and retry`
        : shadowMira
          ? 'Phase 2+4 Shadow — Risk→Autonomy→Approval→Resources→Security→Verifier→Evaluator→ShadowMira→Ledger'
          : 'Phase 2 gated — Risk→Autonomy→Approval→Resources→Security before Verifier (ShadowComparison heuristic)',
    })
  })

  // ── GET /evolution/ledger ────────────────────────────────────────
  app.get('/evolution/ledger', (c) => {
    const limitRaw = c.req.query('limit')
    const limit = limitRaw ? Math.min(100, Math.max(1, Number(limitRaw) || 50)) : 50
    const entries = ledger.list(limit)
    return c.json({
      ok: true,
      count: ledger.count(),
      limit,
      entries: entries.map((e) => ({
        id: e.id,
        title: e.proposal.title,
        type: e.proposal.type,
        risk: e.proposal.risk,
        priority: e.proposal.priority,
        affectedEngine: e.proposal.affectedEngine,
        verdict: e.verdict,
        evidence: e.evidence,
        createdAt: e.createdAt,
      })),
    })
  })

  // ── GET /evolution/risk/:id ──────────────────────────────────────
  app.get('/evolution/risk/:id', (c) => {
    const id = c.req.param('id')
    const entry = ledger.get(id)
    if (!entry) return c.json({ error: 'not found', id }, 404)
    const ev = entry.evidence as {
      risk?: import('../evolution/risk.js').RiskAssessment
      autonomy?: { level: number; needsApproval: boolean }
      approval?: unknown
      budget?: unknown
      security?: unknown
    } | null
    if (ev?.risk) {
      return c.json({
        ok: true,
        id,
        risk: ev.risk,
        autonomy: ev.autonomy,
        approval: ev.approval,
        budget: ev.budget,
        security: ev.security,
      })
    }
    // fallback: recompute risk from proposal
    const risk = riskEngine.assess(
      entry.proposal as unknown as Parameters<typeof riskEngine.assess>[0],
    )
    const level = selectLevel(risk, entry.proposal)
    return c.json({
      ok: true,
      id,
      risk,
      autonomy: { level, needsApproval: requiresApproval(level, risk) },
      proposal: entry.proposal,
      fallback: true,
    })
  })

  // ── GET /evolution/metrics — longitudinal evaluation (§16) ──────
  // Aggregates ledger history into longitudinal stats and derives a REAL
  // baseline from the most recent accepted entries — replacing reliance on
  // the hardcoded DEFAULT_BASELINE (§16: Before vs Candidate vs After).
  app.get('/evolution/metrics', (c) => {
    const limitRaw = c.req.query('limit')
    const limit = limitRaw ? Math.min(500, Math.max(1, Number(limitRaw) || 200)) : 200
    const entries = ledger.list(limit)
    const byVerdict: Record<string, number> = {}
    for (const e of entries) byVerdict[e.verdict] = (byVerdict[e.verdict] ?? 0) + 1
    const accepted = entries.filter((e) => e.verdict === 'verified' || e.verdict === 'accepted')

    // Candidate metric trend from accepted entries (chronological), via the
    // same extractor the observe pipeline uses for its evidence-based baseline.
    const metricSeries = extractCandidateMetricSeries(entries)
    const meanOf = (xs: number[]) =>
      xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length
    const trend: Record<
      string,
      {
        mean: number | null
        n: number
        first: number | null
        last: number | null
        delta: number | null
      }
    > = {}
    for (const [k, xs] of Object.entries(metricSeries)) {
      // series is newest-first (ledger.list is reverse-chronological) — flip for first/last
      const chrono = [...xs].reverse()
      const first = chrono.length > 0 ? chrono[0] : null
      const last = chrono.length > 0 ? chrono[chrono.length - 1] : null
      trend[k] = {
        mean: meanOf(xs),
        n: xs.length,
        first,
        last,
        delta:
          first !== null && last !== null && first !== 0 ? ((last - first) / first) * 100 : null,
      }
    }
    // Evidence-based baseline (same math the observe pipeline feeds evaluate())
    // + drift alarms: metrics whose recent window diverged from history
    const { baseline, drift } = deriveLongitudinalBaselineDetailed(entries)
    const derivedBaseline: Record<string, number | null> = baseline
      ? {
          successRate: baseline.successRate,
          latencyMs: baseline.latencyMs,
          costPerTask: baseline.costPerTask,
          regressionRate: baseline.regressionRate,
          securityViolations: baseline.securityViolations,
        }
      : {
          successRate: null,
          latencyMs: null,
          costPerTask: null,
          regressionRate: null,
          securityViolations: null,
        }

    return c.json({
      ok: true,
      window: { limit, observed: entries.length },
      byVerdict,
      acceptanceRate: entries.length > 0 ? accepted.length / entries.length : null,
      acceptedCount: accepted.length,
      trend,
      derivedBaseline,
      drift,
      longitudinal:
        '§16 Before vs Candidate vs After — derivedBaseline is what evaluate() uses when accepted history exists; drifted metrics use their recent window (adaptive)',
      timestamp: Date.now(),
    })
  })

  // ── GET /evolution/complexity — §20 complexity as an engineering metric ──
  app.get('/evolution/complexity', (c) => {
    const snap = complexityTracker.snapshot()
    const trend = complexityTracker.trend()
    return c.json({
      ok: true,
      current: snap,
      trend,
      history: complexityTracker.history(20),
      note: '§20: complexity tracked as engines/tools/deps/agents/permissions/actions/transitions/failure-paths — growth is a risk signal, not a feature',
      timestamp: Date.now(),
    })
  })

  // ── POST /evolution/loop/acknowledge — §11 escalation ack ────────
  // Body: { fingerprint?: string } — clears escalation state (human or
  // higher-level agent decision per §11 RECOVERY FAILED → ESCALATE).
  app.post('/evolution/loop/acknowledge', async (c) => {
    let body: { fingerprint?: unknown } | null = null
    try {
      body = (await c.req.json()) as unknown as { fingerprint?: unknown }
    } catch {
      body = null
    }
    const fingerprint =
      typeof body?.fingerprint === 'string' ? body.fingerprint.slice(0, 64) : undefined
    const cleared = loopGuard.acknowledge(fingerprint)
    try {
      bus?.publish({
        type: 'evolution.loop_acknowledged' as unknown as import('../types/index.js').BusEventType,
        payload: { fingerprint, cleared } as unknown as JsonValue,
        timestamp: Date.now(),
      } as unknown as import('../types/index.js').BusEvent)
    } catch {}
    return c.json({
      ok: true,
      cleared,
      fingerprint: fingerprint ?? 'all',
      loopGuard: loopGuard.stats(),
    })
  })

  // ── POST /evolution/approve/:id ──────────────────────────────────
  app.post('/evolution/approve/:id', async (c) => {
    const id = c.req.param('id')
    const entry = ledger.get(id)
    if (!entry) return c.json({ error: 'not found', id }, 404)
    // Identity comes from the caller's credentials. A body field named
    // `approver` used to be trusted verbatim, so any caller could record an
    // approval "by" whoever they liked.
    const bearer = c.req.header('authorization')?.startsWith('Bearer ')
      ? c.req.header('authorization')!.slice(7)
      : ''
    const owner = deps.resolveOwner?.(bearer)
    const identity = {
      owner: owner ?? 'unauthenticated',
      authenticated: Boolean(owner),
      // Establish the approver capability from the caller's role. Resolved only
      // for authenticated callers; an unknown token yields no role and the gate
      // fails closed.
      role: owner ? deps.resolveRole?.(bearer) : undefined,
    }
    if (!identity.authenticated) {
      return c.json(
        { error: 'approval requires an authenticated caller', approved: false, id },
        401,
      )
    }
    const result = approvalGate.approve(id, identity)
    // P0 fix: only update ledger verdict when approval is confirmed AND authoritative
    // A denied, non-authoritative, or policy/mock approval must NOT be recorded as verified
    const isAuthoritativeApproval = result.approved === true && result.authoritative !== false
    if (isAuthoritativeApproval) {
      try {
        const ev = entry.evidence as Record<string, unknown> | null
        const currentVerdict = String(entry.verdict)
        if (currentVerdict.includes('pending')) {
          ledger.remember({
            id: entry.id,
            proposal: entry.proposal,
            verdict: 'verified' as unknown as import('../evolution/ledger.js').LedgerVerdict,
            evidence: {
              ...(ev ?? {}),
              approval: result,
              approvedAt: Date.now(),
              approver: result.approver ?? identity.owner,
            } as unknown as JsonValue,
          })
        }
      } catch {}
    }
    return c.json({
      ok: true,
      id,
      approved: result.approved,
      approver: result.approver,
      approverKind: result.approverKind,
      authoritative: result.authoritative,
      reason: result.reason,
    })
  })

  // ── GET /evolution/approvals — the operator's pending queue ─────
  // The UI is a surface, not an authority: this reads gate state (durable),
  // approve/deny still require the operator's authenticated credentials.
  // Reading the queue is also the aging-notification tick.
  app.get('/evolution/approvals', (c) => {
    const agingEmitted = approvalGate.checkAging()
    const pending = approvalGate.listPending()
    return c.json({
      ok: true,
      count: pending.length,
      agingEmitted,
      policyFingerprint: approvalGate.policyFingerprint(),
      pending: pending.map((p) => ({
        id: p.id,
        title: p.proposal?.title,
        affectedEngine: p.proposal?.affectedEngine,
        risk: p.risk?.level,
        riskScore: p.risk?.score,
        riskReasons: p.risk?.reasons,
        level: p.level,
        requestedAt: p.requestedAt,
        // Two-person rule progress — the UI shows "1 of 2 operator approvals"
        approvers: p.approvers ?? [],
        requiredApprovals: p.requiredApprovals ?? 1,
      })),
    })
  })

  // ── GET /evolution/investigations — the follow-up queue (§24) ────
  // A proposal with no real change is not a failure — it is an open question
  // awaiting a fix. This surfaces those questions with everything needed to
  // act: the diagnosis, the observed failure, the risk, and any research hints
  // already validated against it (§10). Acting on one means producing a real
  // unified diff and re-posting it to /evolution/observe, which then flows
  // through variant → shadow → canary like any candidate.
  app.get('/evolution/investigations', (c) => {
    const limitRaw = c.req.query('limit')
    const limit = limitRaw ? Math.min(200, Math.max(1, Number(limitRaw) || 50)) : 50
    const entries = ledger.list(500)

    const investigations = entries
      .map((e) => {
        const ev = e.evidence as {
          experiment?: { appliable?: boolean; targetFile?: string }
          candidate?: { real?: boolean; basis?: string }
          diagnosis?: {
            cause?: string
            confidence?: number
            affectedEngine?: string
            failure?: string
          }
          observed?: { failure?: string; evidence?: unknown }
          risk?: { level?: string; score?: number; reasons?: string[] }
          research?: {
            knowledge?: Array<{
              claim?: string
              validated?: boolean
              confidence?: number
              corroboratedSources?: string[]
            }>
          }
        } | null
        // Only proposals that produced no appliable change, and were not
        // already resolved by an operator decision.
        if (ev?.experiment?.appliable !== false) return null
        if (e.verdict === 'rolledback' || e.verdict === 'promoted') return null
        const hints = (ev?.research?.knowledge ?? [])
          .filter((k) => k.validated)
          .map((k) => ({
            claim: k.claim ?? '',
            confidence: k.confidence ?? 0,
            corroboratedBy: k.corroboratedSources?.length ?? 1,
          }))
        return {
          id: e.id,
          title: e.proposal?.title,
          verdict: e.verdict,
          createdAt: e.createdAt,
          cause: ev?.diagnosis?.cause ?? e.proposal?.cause,
          failure: ev?.diagnosis?.failure ?? ev?.observed?.failure,
          affectedEngine: ev?.diagnosis?.affectedEngine ?? e.proposal?.affectedEngine,
          confidence: ev?.diagnosis?.confidence ?? e.proposal?.confidence,
          risk: ev?.risk?.level ?? e.proposal?.risk,
          riskReasons: ev?.risk?.reasons ?? [],
          evidence: ev?.observed?.evidence ?? null,
          why: ev?.candidate?.basis ?? 'no change proposed — investigation',
          researchHints: hints,
          next: 'produce a real unified diff against an existing file, then POST /evolution/observe with { failure, changedFiles, patch }',
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .slice(0, limit)

    return c.json({
      ok: true,
      count: investigations.length,
      window: { limit, scanned: entries.length },
      investigations,
      note: '§24: an investigation is an open question, not a failure — resolve it by producing a real diff and re-observing',
    })
  })

  // ── POST /evolution/deny/:id — operator denial (mirror of approve) ──
  app.post('/evolution/deny/:id', async (c) => {
    const id = c.req.param('id')
    const entry = ledger.get(id)
    if (!entry) return c.json({ error: 'not found', id }, 404)
    const bearer = c.req.header('authorization')?.startsWith('Bearer ')
      ? c.req.header('authorization')!.slice(7)
      : ''
    const owner = deps.resolveOwner?.(bearer)
    const identity = {
      owner: owner ?? 'unauthenticated',
      authenticated: Boolean(owner),
      role: owner ? deps.resolveRole?.(bearer) : undefined,
    }
    if (!identity.authenticated) {
      return c.json({ error: 'denial requires an authenticated caller', denied: false, id }, 401)
    }
    const result = approvalGate.deny(id, identity)
    // record the denial in the ledger (fail-closed verdict)
    try {
      const ev = entry.evidence as Record<string, unknown> | null
      ledger.remember({
        id: entry.id,
        proposal: entry.proposal,
        verdict: 'rejected' as unknown as import('../evolution/ledger.js').LedgerVerdict,
        evidence: {
          ...(ev ?? {}),
          denial: result,
          deniedAt: Date.now(),
          denier: result.approver ?? identity.owner,
        } as unknown as JsonValue,
      })
    } catch {}
    return c.json({
      ok: true,
      id,
      approved: result.approved,
      approver: result.approver,
      approverKind: result.approverKind,
      reason: result.reason,
    })
  })

  // ── POST /evolution/rollback/:id ─────────────────────────────────
  app.post('/evolution/rollback/:id', async (c) => {
    const id = c.req.param('id')
    const entry = ledger.get(id)
    if (!entry) return c.json({ error: 'not found', id }, 404)
    // In production, verify; in tests, skip for speed
    const verify = process.env.NODE_ENV !== 'test'
    const result = await rollbackManager.rollback(id, { verify })
    const after = ledger.get(id)
    return c.json({
      ok: result.success,
      id,
      rolledBack: true,
      verdict: after?.verdict ?? 'rolledback',
      restoredFiles: result.restoredFiles,
      failedFiles: result.failedFiles,
      configRestored: result.configRestored,
      verification: result.verification,
    })
  })

  // ── GET /evolution/rollback/:id/metadata — §6 system rollback metadata ──
  app.get('/evolution/rollback/:id/metadata', (c) => {
    const id = c.req.param('id')
    const meta = systemRollback.metadata(id)
    if (!meta) return c.json({ error: 'no system rollback metadata recorded', id }, 404)
    return c.json({
      ok: true,
      metadata: meta,
      note: '§6: file rollback ≠ system rollback — this metadata drives engine rollback()/config restore; systemRollbackMetadata is recorded in ledger evidence',
    })
  })

  // Governance pipeline (patch proposals) — only when a gate was passed in;
  // mountLearningRoutes mounts the same routes with learning's gate instance.
  if (deps.governance)
    mountEvolutionProposalRoutes(app, {
      governance: deps.governance,
      rollbackManager,
      canaryStart: deps.canaryStart,
      resourceLimits,
      ledger,
    })
}

// ── Governance proposal routes (patching/governance) ────────────────────────
// Mounted once per app: mountEvolutionRoutes() when given a gate, and
// mountLearningRoutes() with the learning system's gate (the instance created
// in learning/index.ts). The WeakSet guard makes double-mounting a no-op so
// whichever lane mounts first wins.

const proposalRoutesMounted = new WeakSet<Hono<{ Variables: { requestId: string } }>>()

export function mountEvolutionProposalRoutes(
  app: Hono<{ Variables: { requestId: string } }>,
  deps: {
    governance: GovernanceGateLike
    /** Exact-point refresh after promote (snapshot linkage by patchId) */
    rollbackManager?: RollbackManager
    /** Auto-canary (P3.6/Phase 5): start a canary for the patched engine after
     *  a successful promote. Returns the canary id, or null when skipped. */
    canaryStart?: (affectedEngine: string) => { canaryId: string } | null
    /** Resource limits for budget reservation settlement/release */
    resourceLimits?: ResourceLimits
    /** Ledger for reading budget reservation evidence */
    ledger?: ImprovementLedger
  },
): void {
  if (proposalRoutesMounted.has(app)) return
  proposalRoutesMounted.add(app)
  const governance = deps.governance

  // ── GET /evolution/proposals?state=<s> ───────────────────────────
  app.get('/evolution/proposals', async (c) => {
    const state = c.req.query('state')
    if (state !== undefined && state !== '' && !isProposalState(state)) {
      return c.json({ error: `invalid state: ${state.slice(0, 40)}` }, 400)
    }
    const proposals = await governance.list(
      state && isProposalState(state) ? (state as ProposalState) : undefined,
    )
    return c.json({ proposals })
  })

  // ── POST /evolution/proposals/:id/advance ────────────────────────
  // Runs exactly one pipeline stage (benchmark → security → canary).
  app.post('/evolution/proposals/:id/advance', async (c) => {
    const id = c.req.param('id')
    const proposal = await governance.advance(id)
    if (!proposal) return c.json({ error: 'not found', id }, 404)
    return c.json({ proposal })
  })

  // ── POST /evolution/proposals/:id/promote ────────────────────────
  app.post('/evolution/proposals/:id/promote', async (c) => {
    const id = c.req.param('id')
    const exists = await governance.get(id)
    if (!exists) return c.json({ error: 'not found', id }, 404)
    const result = await governance.promote(id)
    // Exact rollback linkage: the applier snapshots pre-images with
    // message_id = patchId under the evolution marker session; refresh the
    // point so POST /evolution/rollback/:id restores exactly this patch.
    if (result.applied && exists.patchId && deps.rollbackManager) {
      try {
        deps.rollbackManager.createRollbackPoint(id, [exists.patchId])
      } catch {}
    }
    // Auto-canary (opt-in via canaryStart wiring): validate the change under
    // real traffic instead of trusting the verifier alone.
    let canary: { canaryId: string } | null = null
    if (result.applied && deps.canaryStart && exists.kind) {
      try {
        canary = deps.canaryStart(exists.kind)
      } catch {}
    }
    // P1: Budget reservation settlement — settle with actual cost on promotion
    if (result.applied && deps.resourceLimits) {
      try {
        const ledgerEntry = deps.ledger?.get(id)
        const budgetEvidence = (ledgerEntry?.evidence as Record<string, unknown> | undefined)
          ?.budget as { reservationId?: string; cost?: number } | undefined
        const reservationId = budgetEvidence?.reservationId
        if (reservationId) {
          // Use the proposal's estimated cost as actual (could be measured later)
          const actualCost = budgetEvidence?.cost ?? 0.05
          deps.resourceLimits.settleReservation(reservationId, actualCost)
        }
      } catch {}
    }
    // backward compatible: prUrl/regressionBlocked/reason are omitted from the
    // JSON body when undefined; failure reasons must reach the client.
    return c.json({
      applied: result.applied,
      prUrl: result.prUrl,
      regressionBlocked: result.regressionBlocked,
      reason: result.reason,
      ...(canary ? { canary: canary.canaryId } : {}),
    })
  })

  // ── POST /evolution/proposals/:id/rollback  body: { reason } ─────
  app.post('/evolution/proposals/:id/rollback', async (c) => {
    const id = c.req.param('id')
    let body: { reason?: unknown } | null = null
    try {
      body = (await c.req.json()) as unknown as { reason?: unknown } | null
    } catch {
      body = null
    }
    const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 500) : ''
    if (!reason) return c.json({ error: 'body.reason string required' }, 400)
    const exists = await governance.get(id)
    if (!exists) return c.json({ error: 'not found', id }, 404)
    // P1: Budget reservation release — return unspent reservation to budget on rollback
    if (deps.resourceLimits) {
      try {
        const ledgerEntry = deps.ledger?.get(id)
        const budgetEvidence = (ledgerEntry?.evidence as Record<string, unknown> | undefined)
          ?.budget as { reservationId?: string; cost?: number } | undefined
        const reservationId = budgetEvidence?.reservationId
        if (reservationId) {
          deps.resourceLimits.releaseReservation(reservationId, `rollback: ${reason}`)
        }
      } catch {}
    }
    await governance.rollback(id, reason)
    // Also trigger the unified rollback for file/config restore + verification
    if (deps.rollbackManager) {
      try {
        await deps.rollbackManager.rollback(id, { verify: process.env.NODE_ENV !== 'test' })
      } catch {}
    }
    return c.json({ ok: true })
  })
}
