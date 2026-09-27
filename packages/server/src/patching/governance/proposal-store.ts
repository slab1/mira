import type { MiraDB } from '../../storage/db.js';
import type { PatchProposal, ProposalState } from './types.js';

export class ProposalStore {
  constructor(private db?: MiraDB) {}

  async init(): Promise<void> {
    if (!this.db) return;
    this.db.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS patch_proposals (
        id TEXT PRIMARY KEY,
        patch_id TEXT NOT NULL,
        pain_point TEXT NOT NULL,
        target_file TEXT,
        kind TEXT NOT NULL,
        severity TEXT NOT NULL,
        score REAL NOT NULL,
        state TEXT NOT NULL,
        metadata TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        promoted_at INTEGER,
        rolled_back_at INTEGER,
        pr_url TEXT
      );
    `);
  }

  create(proposal: PatchProposal): void {
    if (!this.db) return;
    this.db.sqlite.prepare(`
      INSERT INTO patch_proposals (id, patch_id, pain_point, target_file, kind, severity, score, state, metadata, created_at, updated_at, promoted_at, rolled_back_at, pr_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      proposal.id,
      proposal.patchId,
      proposal.painPointId,
      proposal.targetFile,
      proposal.kind,
      proposal.severity,
      proposal.score,
      proposal.state,
      JSON.stringify(proposal.metadata),
      proposal.createdAt,
      proposal.updatedAt,
      proposal.promotedAt ?? null,
      proposal.rolledBackAt ?? null,
      proposal.prUrl ?? null,
    );
  }

  update(id: string, patch: Partial<PatchProposal> & { updatedAt: number; state: ProposalState }): void {
    if (!this.db) return;
    const metadata = patch.metadata !== undefined ? JSON.stringify(patch.metadata) : undefined;
    this.db.sqlite.prepare(`
      UPDATE patch_proposals SET state = ?, metadata = COALESCE(?, metadata), updated_at = ?, promoted_at = ?, rolled_back_at = ?, pr_url = ? WHERE id = ?
    `).run(
      patch.state,
      metadata ?? null,
      patch.updatedAt,
      patch.promotedAt ?? null,
      patch.rolledBackAt ?? null,
      patch.prUrl ?? null,
      id,
    );
  }

  get(id: string): PatchProposal | null {
    if (!this.db) return null;
    const row = this.db.sqlite.prepare(`SELECT * FROM patch_proposals WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToProposal(row) : null;
  }

  list(state?: ProposalState): PatchProposal[] {
    if (!this.db) return [];
    const rows = state
      ? this.db.sqlite.prepare(`SELECT * FROM patch_proposals WHERE state = ? ORDER BY created_at DESC`).all(state) as Record<string, unknown>[]
      : this.db.sqlite.prepare(`SELECT * FROM patch_proposals ORDER BY created_at DESC`).all() as Record<string, unknown>[];
    return rows.map(this.rowToProposal);
  }

  private rowToProposal(row: Record<string, unknown>): PatchProposal {
    return {
      id: row.id as string,
      patchId: row.patch_id as string,
      painPointId: row.pain_point as string,
      kind: row.kind as string,
      targetFile: row.target_file as string | null,
      reason: '',
      change: '',
      severity: row.severity as string,
      score: row.score as number,
      state: row.state as ProposalState,
      metadata: JSON.parse(row.metadata as string),
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      promotedAt: (row.promoted_at as number) ?? undefined,
      rolledBackAt: (row.rolled_back_at as number) ?? undefined,
      prUrl: (row.pr_url as string) ?? undefined,
    };
  }
}
