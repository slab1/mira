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
  | 'BENCHMARK_PENDING' | 'BENCHMARK_PASSED' | 'BENCHMARK_FAILED'
  | 'SECURITY_PENDING' | 'SECURITY_PASSED' | 'SECURITY_FAILED'
  | 'CANARY_PENDING' | 'CANARY_PASSED' | 'CANARY_FAILED'
  | 'PROMOTED'
  | 'ROLLED_BACK'
  | 'REJECTED';

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
] as const satisfies readonly ProposalState[];

export function isProposalState(value: string): value is ProposalState {
  return (PROPOSAL_STATES as readonly string[]).includes(value);
}

export interface CanaryConfig {
  trafficPct: number;
  durationMs: number;
  slo?: {
    p50Ms?: number;
    p95Ms?: number;
    errorRate?: number;
  };
}

/** Snapshot of scalar metrics captured at a pipeline stage. */
export type MetricSnapshot = Record<string, number>;

export interface BenchmarkResult {
  passed: boolean;
  reason: string;
  before?: MetricSnapshot;
  after?: MetricSnapshot;
  delta?: Record<string, number>;
}

/** Recorded security-review outcome persisted on the proposal. */
export interface SecurityReviewRecord {
  passed: boolean;
  reason: string;
  at?: number;
}

export interface CanaryResult {
  passed: boolean;
  reason: string;
  metrics?: Record<string, number | string | boolean>;
}

export interface PatchProposal {
  id: string;
  patchId: string;
  painPointId: string;
  kind: string;
  targetFile: string | null;
  reason: string;
  change: string;
  severity: string;
  score: number;
  state: ProposalState;
  metadata: {
    verifyResult: import('../verifier.js').VerifyResult;
    benchmark?: BenchmarkResult;
    security?: SecurityReviewRecord;
    canary?: CanaryResult;
  };
  createdAt: number;
  updatedAt: number;
  promotedAt?: number;
  rolledBackAt?: number;
  prUrl?: string;
  canaryConfig?: CanaryConfig;
}
