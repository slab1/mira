import { ProposalStore } from './proposal-store.js';
import { BenchmarkRunner } from './benchmark.js';
import { SecurityReview } from './security-review.js';
import { CanaryRunner } from './canary.js';
import { Promoter } from './promoter.js';
import { RollbackManager } from './rollback.js';
import type { PatchProposal, ProposalState } from './types.js';
import type { MiraDB } from '../../storage/db.js';
import type { Bus } from '../../bus/index.js';

export class GovernanceGate {
  public readonly store: ProposalStore;
  private benchmark: BenchmarkRunner;
  private security: SecurityReview;
  private canary: CanaryRunner;
  private promoter: Promoter;
  private rollbackManager: RollbackManager;

  constructor(deps: { db?: MiraDB; bus?: Bus; rootDir: string }) {
    this.store = new ProposalStore(deps.db);
    this.benchmark = new BenchmarkRunner();
    this.security = new SecurityReview();
    this.canary = new CanaryRunner();
    this.promoter = new Promoter(deps.rootDir);
    this.rollbackManager = new RollbackManager();
  }

  async init(): Promise<void> {
    await this.store.init();
  }

  async createProposal(patch: any, verifyResult: any): Promise<PatchProposal> {
    const id = `proposal_${patch.id}_${Date.now()}`;
    const proposal: PatchProposal = {
      id,
      patchId: patch.id,
      painPointId: patch.painPointId,
      kind: patch.kind,
      targetFile: patch.targetFile,
      reason: patch.reason ?? '',
      change: patch.change ?? '',
      severity: patch.severity ?? 'medium',
      score: patch.score ?? 0,
      state: 'PROPOSED',
      metadata: { verifyResult },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.store.create(proposal);
    return proposal;
  }

  async advance(proposalId: string): Promise<PatchProposal | null> {
    const proposal = await this.store.get(proposalId);
    if (!proposal) return null;
    // Simplified state machine
    proposal.updatedAt = Date.now();
    await this.store.update(proposalId, { ...proposal, updatedAt: proposal.updatedAt, state: proposal.state });
    return proposal;
  }

  async promote(proposalId: string): Promise<{ applied: boolean; prUrl?: string }> {
    const proposal = await this.store.get(proposalId);
    if (!proposal) return { applied: false };
    const result = await this.promoter.promote(proposal);
    if (result.applied) {
      proposal.state = 'PROMOTED';
      proposal.promotedAt = Date.now();
      proposal.prUrl = result.prUrl;
      await this.store.update(proposalId, { ...proposal, updatedAt: Date.now(), state: proposal.state, promotedAt: proposal.promotedAt, prUrl: proposal.prUrl });
    }
    return result;
  }

  async rollback(proposalId: string, reason: string): Promise<void> {
    await this.rollbackManager.rollback(proposalId, reason);
    const proposal = await this.store.get(proposalId);
    if (proposal) {
      proposal.state = 'ROLLED_BACK';
      proposal.rolledBackAt = Date.now();
      await this.store.update(proposalId, { ...proposal, updatedAt: Date.now(), state: proposal.state, rolledBackAt: proposal.rolledBackAt });
    }
  }

  async list(state?: ProposalState): Promise<PatchProposal[]> {
    return this.store.list(state);
  }

  async get(id: string): Promise<PatchProposal | null> {
    return this.store.get(id);
  }
}

export function createGovernanceGate(deps: { db?: MiraDB; bus?: Bus; rootDir: string }) {
  return new GovernanceGate(deps);
}
