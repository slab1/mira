import { ProposalStore } from './proposal-store.js';
import { BenchmarkRunner } from './benchmark.js';
import { SecurityReview } from './security-review.js';
import { CanaryRunner } from './canary.js';
import { Promoter } from './promoter.js';
import { RollbackManager } from './rollback.js';
import { SecurityScanner } from '../security.js';
import { RegressionDetector, classifyAxis, type RegressionResult, type MetricPoint } from './regression.js';
import type { PatchProposal, ProposalState } from './types.js';
import type { Patch } from '../patcher.js';
import type { VerifyResult } from '../verifier.js';
import type { MiraDB } from '../../storage/db.js';
import type { Bus } from '../../bus/index.js';

// ── Stage seams (structural — plain object stubs are assignable) ────

export type BenchmarkStage = Pick<BenchmarkRunner, 'run'>;
export type SecurityStage = Pick<SecurityReview, 'review'>;
export type CanaryStage = Pick<CanaryRunner, 'start'>;
export type PromoteStage = Pick<Promoter, 'promote'>;
export type RollbackStage = Pick<RollbackManager, 'rollback'>;

export interface GovernanceGateDeps {
  db?: MiraDB;
  bus?: Bus;
  rootDir: string;
  /** Stage overrides — production leaves these unset; tests inject fakes
   *  to force a stage to pass/fail deterministically. */
  benchmark?: BenchmarkStage;
  security?: SecurityStage;
  canary?: CanaryStage;
  promoter?: PromoteStage;
  rollback?: RollbackStage;
}

/**
 * Structural contract of the governance gate — the DI shape consumed by
 * `PatchingEngineDeps.governance` (patching/index.ts) and the
 * `/evolution/proposals*` route handlers (routes/evolution.ts).
 * `GovernanceGate` implements it.
 */
export interface GovernanceGateLike {
  init(): Promise<void>;
  createProposal(patch: Patch, verifyResult: VerifyResult): Promise<PatchProposal>;
  /** Run the NEXT pipeline stage once; null if the proposal does not exist. */
  advance(proposalId: string): Promise<PatchProposal | null>;
  promote(proposalId: string): Promise<{ applied: boolean; prUrl?: string; regressionBlocked?: boolean; reason?: string }>;
  rollback(proposalId: string, reason: string): Promise<void>;
  list(state?: ProposalState): Promise<PatchProposal[]>;
  get(id: string): Promise<PatchProposal | null>;
}

export class GovernanceGate implements GovernanceGateLike {
  public readonly store: ProposalStore;
  private readonly bus?: Bus;
  private benchmark: BenchmarkStage;
  private security: SecurityStage;
  private canary: CanaryStage;
  private promoter: PromoteStage;
  private rollbackManager: RollbackStage;
  private regression: RegressionDetector;

  constructor(deps: GovernanceGateDeps) {
    this.store = new ProposalStore(deps.db);
    this.bus = deps.bus;
    this.benchmark = deps.benchmark ?? new BenchmarkRunner();
    // Fail-closed: scan the proposed change for critical issues (injection,
    // command injection) instead of passing unreviewed.
    this.security = deps.security ?? new SecurityReview(new SecurityScanner());
    this.canary = deps.canary ?? new CanaryRunner();
    this.promoter = deps.promoter ?? new Promoter(deps.rootDir);
    this.rollbackManager = deps.rollback ?? new RollbackManager({ bus: deps.bus });
    this.regression = new RegressionDetector();
  }

  async init(): Promise<void> {
    this.store.init();
  }

  async createProposal(patch: Patch, verifyResult: VerifyResult): Promise<PatchProposal> {
    const id = `proposal_${patch.id}_${Date.now()}`;
    const proposal: PatchProposal = {
      id,
      patchId: patch.id,
      painPointId: patch.painPointId,
      kind: patch.kind,
      targetFile: patch.targetFile,
      reason: patch.reason ?? '',
      change: patch.change ?? '',
      severity: String(patch.severity ?? 'medium'),
      score: patch.score ?? 0,
      state: 'PROPOSED',
      metadata: { verifyResult },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.store.create(proposal);
    return proposal;
  }

  /**
   * State machine — runs exactly ONE stage per call (granular contract:
   * the web client enables Advance on PROPOSED / *_PENDING / *_PASSED):
   *
   *   PROPOSED           --benchmark--> BENCHMARK_PASSED   | REJECTED
   *   BENCHMARK_PASSED   --security---> SECURITY_PASSED    | REJECTED
   *   SECURITY_PASSED    --canary-----> CANARY_PASSED      | REJECTED
   *   CANARY_PASSED      --promote----> PROMOTED   (separate promote() call)
   *   PROMOTED           --rollback---> ROLLED_BACK        (separate rollback() call)
   *
   *   BENCHMARK_PENDING / SECURITY_PENDING / CANARY_PENDING resume their
   *   own stage (same runner, same *_PASSED outcome) so a proposal parked
   *   mid-stage by an older build still moves forward.
   *
   * Every stage result is stored in `proposal.metadata[stage]`, the new state
   * is persisted through ProposalStore, and a `learning.updated` Bus event
   * describes the transition (BusEventType is a closed union — no new types).
   * Terminal states (CANARY_PASSED awaiting promote / *_FAILED / PROMOTED /
   * REJECTED / ROLLED_BACK) are a no-op: the proposal is returned unchanged,
   * nothing is persisted and no event is emitted.
   */
  async advance(proposalId: string): Promise<PatchProposal | null> {
    const proposal = await this.store.get(proposalId);
    if (!proposal) return null;

    const from = proposal.state;
    let stage: 'benchmark' | 'security' | 'canary';
    let next: ProposalState;
    let passed: boolean;
    let reason: string;

    if (from === 'PROPOSED' || from === 'BENCHMARK_PENDING') {
      stage = 'benchmark';
      // Placeholder runner compares before/after latency when available; a
      // real implementation captures shadow-run metrics for the target file.
      const result = await this.benchmark.run();
      proposal.metadata = { ...proposal.metadata, benchmark: result };
      passed = result.passed;
      reason = result.reason;
      next = passed ? 'BENCHMARK_PASSED' : 'REJECTED';
    } else if (from === 'BENCHMARK_PASSED' || from === 'SECURITY_PENDING') {
      stage = 'security';
      const result = await this.security.review(proposal.change, proposal.targetFile);
      proposal.metadata = { ...proposal.metadata, security: { ...result, at: Date.now() } };
      passed = result.passed;
      reason = result.reason;
      next = passed ? 'SECURITY_PASSED' : 'REJECTED';
    } else if (from === 'SECURITY_PASSED' || from === 'CANARY_PENDING') {
      stage = 'canary';
      const result = await this.canary.start(proposal.id, proposal.canaryConfig);
      proposal.metadata = { ...proposal.metadata, canary: result };
      passed = result.passed;
      reason = result.reason;
      next = passed ? 'CANARY_PASSED' : 'REJECTED';
    } else {
      // CANARY_PASSED (awaiting promote), *_FAILED, PROMOTED, REJECTED and
      // ROLLED_BACK: no next stage — leave the proposal untouched.
      return proposal;
    }

    proposal.state = next;
    proposal.updatedAt = Date.now();
    await this.store.update(proposalId, {
      ...proposal,
      state: proposal.state,
      metadata: proposal.metadata,
      updatedAt: proposal.updatedAt,
    });

    this.bus?.publish({
      type: 'learning.updated',
      payload: {
        kind: 'governance.transition',
        proposalId: proposal.id,
        stage,
        from,
        to: next,
        passed,
        reason,
      },
      timestamp: proposal.updatedAt,
    });

    return proposal;
  }

  /** Run regression detection — blocks promotion if baseline metrics regressed. */
  checkRegression(
    baseline: Record<string, MetricPoint>,
    candidate: Record<string, MetricPoint>,
    tolerances?: Parameters<RegressionDetector['detect']>[0]['tolerances'],
  ): RegressionResult {
    return this.regression.detect({ baseline, candidate, tolerances });
  }

  /**
   * Derive regression evidence from the stage metadata advance() persisted
   * (never from the caller):
   *   baseline  ← metadata.benchmark.before (fallback .after — both are the
   *               benchmark stage's measurement of the change)
   *   candidate ← metadata.canary.metrics (numeric entries only)
   * Returns null unless at least one axis-classifiable metric exists on BOTH
   * sides — an uncomparable pair proves nothing, so it counts as no evidence.
   */
  private deriveMetrics(proposal: PatchProposal): { baseline: Record<string, MetricPoint>; candidate: Record<string, MetricPoint> } | null {
    const before = proposal.metadata.benchmark?.before;
    const after = proposal.metadata.benchmark?.after;
    const snapshot = before && Object.keys(before).length > 0 ? before : after;
    const toPoints = (src: Record<string, unknown> | undefined): Record<string, MetricPoint> => {
      const out: Record<string, MetricPoint> = {};
      for (const [k, v] of Object.entries(src ?? {})) {
        if (typeof v === 'number' && Number.isFinite(v)) out[k] = { value: v, unit: 'raw' };
      }
      return out;
    };
    const baseline = toPoints(snapshot);
    const candidate = toPoints(proposal.metadata.canary?.metrics);
    const comparable = Object.keys(candidate).some((k) => k in baseline && classifyAxis(k) !== null);
    return comparable ? { baseline, candidate } : null;
  }

  /**
   * Promotion gate — ENFORCED and fail-closed. Two checks run before the
   * promoter is ever invoked:
   *
   * 1. STATE GUARD: only CANARY_PASSED may promote. Any other state returns
   *    { applied:false, reason:'invalid_state:<state>' } — there is no
   *    PROPOSED → PROMOTED skip through the API.
   *
   * 2. REGRESSION GATE (auto-derived): baseline/candidate come from the
   *    stage metadata advance() persisted — never trusted from the caller:
   *      baseline  ← metadata.benchmark.before (fallback .after)
   *      candidate ← metadata.canary.metrics
   *    * regressed past tolerance → rollback + { regressionBlocked:true, reason }
   *    * metrics present and pass → promote proceeds
   *    * metrics ABSENT (no comparable baseline/candidate pair) → conservative
   *      deny { applied:false, reason:'metrics_missing' }.
   *      POLICY: unevidenced changes must not promote. The placeholder
   *      runners record no numbers, so a proposal measured by nothing has no
   *      proof it is safe — fail closed until instrumented stages exist.
   *
   * opts.baseline/candidate stays a deliberate override for tests/manual runs:
   * explicit operator-supplied evidence bypasses derivation (but never the
   * state guard).
   */
  async promote(
    proposalId: string,
    opts?: { baseline?: Record<string, MetricPoint>; candidate?: Record<string, MetricPoint> },
  ): Promise<{ applied: boolean; prUrl?: string; regressionBlocked?: boolean; reason?: string }> {
    const proposal = await this.store.get(proposalId);
    if (!proposal) return { applied: false };

    // 1) State guard — only a proposal that cleared every stage may promote.
    if (proposal.state !== 'CANARY_PASSED') {
      return { applied: false, reason: `invalid_state:${proposal.state}` };
    }

    // 2) Regression gate — explicit override, else metrics derived from metadata.
    let baseline = opts?.baseline;
    let candidate = opts?.candidate;
    if (!baseline || !candidate) {
      const derived = this.deriveMetrics(proposal);
      if (!derived) return { applied: false, reason: 'metrics_missing' };
      baseline = derived.baseline;
      candidate = derived.candidate;
    }
    const rr = this.checkRegression(baseline, candidate);
    if (!rr.passed) {
      const reason = `regression: ${rr.findings.map((f) => `${f.axis}/${f.metric} +${(f.deltaPct * 100).toFixed(1)}%`).join(', ')}`;
      await this.rollback(proposalId, reason);
      return { applied: false, regressionBlocked: true, reason };
    }

    const result = await this.promoter.promote(proposal);
    if (result.applied) {
      const from = proposal.state;
      proposal.state = 'PROMOTED';
      proposal.promotedAt = Date.now();
      proposal.prUrl = result.prUrl;
      await this.store.update(proposalId, { ...proposal, updatedAt: Date.now(), state: proposal.state, promotedAt: proposal.promotedAt, prUrl: proposal.prUrl });
      this.bus?.publish({
        type: 'learning.updated',
        payload: {
          kind: 'governance.transition',
          proposalId: proposal.id,
          stage: 'promote',
          from,
          to: 'PROMOTED',
          passed: true,
          reason: result.prUrl ?? 'promoted',
        },
        timestamp: Date.now(),
      });
    }
    return result;
  }

  /**
   * ROLLED_BACK escape hatch — allowed from any state (the happy-path
   * branch is PROMOTED → ROLLED_BACK; regression checks also roll back a
   * not-yet-promoted proposal). Persists the state first, then lets the
   * RollbackManager record the event (see rollback.ts for what it does
   * and does NOT do).
   */
  async rollback(proposalId: string, reason: string): Promise<void> {
    const proposal = await this.store.get(proposalId);
    if (!proposal) return;
    const from = proposal.state;
    proposal.state = 'ROLLED_BACK';
    proposal.rolledBackAt = Date.now();
    await this.store.update(proposalId, {
      ...proposal,
      state: proposal.state,
      rolledBackAt: proposal.rolledBackAt,
      updatedAt: proposal.rolledBackAt,
    });
    await this.rollbackManager.rollback(proposalId, reason);
    this.bus?.publish({
      type: 'learning.updated',
      payload: {
        kind: 'governance.transition',
        proposalId,
        stage: 'rollback',
        from,
        to: 'ROLLED_BACK',
        passed: false,
        reason,
      },
      timestamp: Date.now(),
    });
  }

  async list(state?: ProposalState): Promise<PatchProposal[]> {
    return this.store.list(state);
  }

  async get(id: string): Promise<PatchProposal | null> {
    return this.store.get(id);
  }
}

export function createGovernanceGate(deps: GovernanceGateDeps): GovernanceGate {
  return new GovernanceGate(deps);
}
