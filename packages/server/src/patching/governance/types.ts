/**
 * Governance pipeline state machine (FIXED granular contract — the web
 * client codes against exactly this union; do NOT collapse it to simplified
 * states like BENCHMARKED/SECURITY_APPROVED):
 *
 *   PROPOSED → BENCHMARK_PASSED → SECURITY_PASSED → CANARY_PASSED → PROMOTED
 *      │              │                 │                 │
 *      └──────────────┴─────────────────┴──→ REJECTED     └──→ ROLLED_BACK
 *                                                        (from PROMOTED)
 *
 * `advance()` runs exactly one stage per call (benchmark → security →
 * canary), stores the runner result in `metadata`, and lands on that
 * stage's `*_PASSED` state — or REJECTED when the runner fails. A proposal
 * parked in a `*_PENDING` state resumes its own stage on advance().
 * `*_FAILED` states are terminal for advance() (kept for legacy rows).
 *
 * Web-client button contract (Evolution.tsx):
 *   Advance  → PROPOSED / *_PENDING / *_PASSED
 *   Promote  → CANARY_PASSED
 *   Rollback → PROMOTED
 */
export type ProposalState =
  | 'PROPOSED'
  | 'BENCHMARK_PENDING'
  | 'BENCHMARK_PASSED'
  | 'BENCHMARK_FAILED'
  | 'SECURITY_PENDING'
  | 'SECURITY_PASSED'
  | 'SECURITY_FAILED'
  | 'CANARY_PENDING'
  | 'CANARY_PASSED'
  | 'CANARY_FAILED'
  | 'PROMOTED'
  | 'ROLLED_BACK'
  | 'REJECTED'

/** Every valid ProposalState string — used to validate `?state=` query params. */
export const PROPOSAL_STATES = [
  'PROPOSED',
  'BENCHMARK_PENDING',
  'BENCHMARK_PASSED',
  'BENCHMARK_FAILED',
  'SECURITY_PENDING',
  'SECURITY_PASSED',
  'SECURITY_FAILED',
  'CANARY_PENDING',
  'CANARY_PASSED',
  'CANARY_FAILED',
  'PROMOTED',
  'ROLLED_BACK',
  'REJECTED',
] as const satisfies readonly ProposalState[]

export function isProposalState(value: string): value is ProposalState {
  return (PROPOSAL_STATES as readonly string[]).includes(value)
}

export interface CanaryConfig {
  trafficPct: number
  durationMs: number
  slo?: {
    p50Ms?: number
    p95Ms?: number
    errorRate?: number
  }
  /**
   * Minimum candidate requests that must be observed inside `durationMs`
   * before the SLO comparison may authorize promotion. A canary that saw
   * (near) no traffic proves nothing, however good its numbers look.
   * Defaults to 1 — i.e. "at least one real candidate request was observed".
   */
  minSamples?: number
  /**
   * Route/trace label used to scope measurement to THIS candidate.
   * Defaults to the proposal id. Canary evidence must be candidate-specific;
   * process-wide latency telemetry is not proof that this candidate worked.
   */
  route?: string
}

/** Snapshot of scalar metrics captured at a pipeline stage. */
export type MetricSnapshot = Record<string, number>

/**
 * Explicit stage outcome (§3 of docs/LONG_TERM_RISK_AND_SCALABILITY_PLAN.md).
 *
 * `passed` alone cannot express the difference between "measured and good"
 * and "never measured". Only `PASSED` may satisfy a required promotion gate;
 * `BLOCKED`/`SKIPPED` mean a dependency or measurement was unavailable and
 * therefore authorize nothing.
 */
export type GovernanceOutcome = 'PASSED' | 'FAILED' | 'BLOCKED' | 'SKIPPED'

/**
 * Back-compat shim for stage doubles and legacy rows written before
 * `outcome` existed. A result that omits `outcome` is interpreted by its
 * `passed` flag; real runners always set `outcome` explicitly.
 */
export function outcomeOf(result: {
  passed: boolean
  outcome?: GovernanceOutcome
}): GovernanceOutcome {
  if (result.outcome) return result.outcome
  return result.passed ? 'PASSED' : 'FAILED'
}

/** Only an explicit PASSED may advance the pipeline or authorize promotion. */
export function isPassing(result: { passed: boolean; outcome?: GovernanceOutcome }): boolean {
  return outcomeOf(result) === 'PASSED'
}

export interface BenchmarkResult {
  passed: boolean
  reason: string
  outcome?: GovernanceOutcome
  before?: MetricSnapshot
  after?: MetricSnapshot
  delta?: Record<string, number>
}

/** Recorded security-review outcome persisted on the proposal. */
export interface SecurityReviewRecord {
  passed: boolean
  reason: string
  at?: number
}

export interface CanaryResult {
  passed: boolean
  reason: string
  outcome?: GovernanceOutcome
  /** Measured values only (count/p50/p95/errorRate). Never echoes config —
   *  a configured threshold is not an observation, and mixing the two would
   *  let `deriveMetrics` mistake policy for evidence. */
  metrics?: Record<string, number | string | boolean>
  /** The thresholds and scope this decision was made against. */
  policy?: Record<string, number | string | boolean>
}

export interface PatchProposal {
  id: string
  patchId: string
  painPointId: string
  kind: string
  targetFile: string | null
  reason: string
  change: string
  severity: string
  score: number
  state: ProposalState
  metadata: {
    verifyResult: import('../verifier.js').VerifyResult
    benchmark?: BenchmarkResult
    security?: SecurityReviewRecord
    canary?: CanaryResult
  }
  createdAt: number
  updatedAt: number
  promotedAt?: number
  rolledBackAt?: number
  prUrl?: string
  canaryConfig?: CanaryConfig
}
