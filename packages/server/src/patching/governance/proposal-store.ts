import type { MiraDB } from '../../storage/db.js';
import type { PatchProposal, ProposalState } from './types.js';

export class ProposalStore {
  constructor(private db?: MiraDB) {
    this.init()
  }

  init(): void {
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
        pr_url TEXT,
        reason TEXT,
        "change" TEXT
      );
    `);
    // Idempotent column adds for DBs created before reason/change were
    // persisted (same pattern as storage/db.ts addColumn — SQLite has no
    // ADD COLUMN IF NOT EXISTS).
    for (const col of ['reason', 'change']) {
      try {
        this.db.sqlite.exec(`ALTER TABLE patch_proposals ADD COLUMN ${col === 'change' ? '"change"' : col} TEXT;`);
      } catch (e) {
        const msg = String(e);
        if (!msg.includes('duplicate column name')) {
          console.warn(`[governance] addColumn patch_proposals.${col} failed:`, msg);
        }
      }
    }
  }

  create(proposal: PatchProposal): void {
    if (!this.db) return;
    this.db.sqlite.prepare(`
      INSERT INTO patch_proposals (id, patch_id, pain_point, target_file, kind, severity, score, state, metadata, created_at, updated_at, promoted_at, rolled_back_at, pr_url, reason, "change")
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      proposal.reason,
      proposal.change,
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
    const row = this.db.sqlite.prepare(`SELECT * FROM patch_proposals WHERE id = ?`).get(id) as ProposalRow | undefined;
    return row ? this.rowToProposal(row) : null;
  }

  list(state?: ProposalState): PatchProposal[] {
    if (!this.db) return [];
    const rows = state
      ? this.db.sqlite.prepare(`SELECT * FROM patch_proposals WHERE state = ? ORDER BY created_at DESC`).all(state) as ProposalRow[]
      : this.db.sqlite.prepare(`SELECT * FROM patch_proposals ORDER BY created_at DESC`).all() as ProposalRow[];
    return rows.map(this.rowToProposal);
  }

  private rowToProposal(row: ProposalRow): PatchProposal {
    return {
      id: row.id,
      patchId: row.patch_id,
      painPointId: row.pain_point,
      kind: row.kind,
      targetFile: row.target_file,
      reason: row.reason ?? '',
      change: row.change ?? '',
      severity: row.severity,
      score: row.score,
      state: row.state as ProposalState,
      metadata: JSON.parse(row.metadata) as PatchProposal['metadata'],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      promotedAt: row.promoted_at ?? undefined,
      rolledBackAt: row.rolled_back_at ?? undefined,
      prUrl: row.pr_url ?? undefined,
    };
  }
}

/** Typed shape of a patch_proposals row (snake_case columns). */
interface ProposalRow {
  id: string;
  patch_id: string;
  pain_point: string;
  target_file: string | null;
  kind: string;
  severity: string;
  score: number;
  state: string;
  metadata: string;
  created_at: number;
  updated_at: number;
  promoted_at: number | null;
  rolled_back_at: number | null;
  pr_url: string | null;
  reason?: string;
  change?: string;
}
