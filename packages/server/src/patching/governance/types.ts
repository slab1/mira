export type ProposalState =
  | 'PROPOSED'
  | 'BENCHMARK_PENDING' | 'BENCHMARK_PASSED' | 'BENCHMARK_FAILED'
  | 'SECURITY_PENDING' | 'SECURITY_PASSED' | 'SECURITY_FAILED'
  | 'CANARY_PENDING' | 'CANARY_PASSED' | 'CANARY_FAILED'
  | 'PROMOTED'
  | 'ROLLED_BACK'
  | 'REJECTED';

export interface CanaryConfig {
  trafficPct: number;
  durationMs: number;
  slo?: {
    p50Ms?: number;
    p95Ms?: number;
    errorRate?: number;
  };
}

export interface BenchmarkResult {
  passed: boolean;
  reason: string;
  before?: unknown;
  after?: unknown;
  delta?: Record<string, number>;
}

export interface CanaryResult {
  passed: boolean;
  reason: string;
  metrics?: Record<string, unknown>;
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
    verifyResult: unknown;
    benchmark?: BenchmarkResult;
    security?: unknown;
    canary?: CanaryResult;
  };
  createdAt: number;
  updatedAt: number;
  promotedAt?: number;
  rolledBackAt?: number;
  prUrl?: string;
  canaryConfig?: CanaryConfig;
}
