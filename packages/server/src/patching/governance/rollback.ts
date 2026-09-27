import type { Bus } from '../../bus/index.js';

/**
 * Governance rollback — record + notify.
 *
 * WHAT THIS DOES
 *   1. Records the rollback (proposalId, reason, timestamp) in an in-memory
 *      audit history (`records()` / `last()`), so callers and tests can see
 *      that a rollback happened and why.
 *   2. Emits a `learning.updated` Bus event (`kind: "governance.rollback"`)
 *      when a Bus was supplied — BusEventType is a closed union, so we reuse
 *      `learning.updated` rather than adding a new event type.
 *
 * WHAT THIS DOES NOT DO (out of scope for now)
 *   - It does NOT revert files on disk and does NOT run `git revert`.
 *   - It does NOT undo a merged PR / restore the pre-patch content.
 *   - It does NOT touch the proposal store: the `state → ROLLED_BACK`
 *     transition is persisted by `GovernanceGate.rollback()`, which calls
 *     this AFTER writing the new state.
 *   - History is in-memory only — it does not survive a process restart
 *     (the durable record is the `patch_proposals.state` column).
 *
 * Real file-level revert belongs with the Applier/autopilot (it knows what
 * was written and which branch it landed on) and is tracked separately.
 */

export interface RollbackRecord {
  proposalId: string;
  reason: string;
  at: number;
}

export class RollbackManager {
  private history: RollbackRecord[] = [];

  constructor(private deps: { bus?: Bus } = {}) {}

  async rollback(proposalId: string, reason: string): Promise<RollbackRecord> {
    const record: RollbackRecord = { proposalId, reason, at: Date.now() };
    this.history.push(record);

    this.deps.bus?.publish({
      type: 'learning.updated',
      payload: {
        kind: 'governance.rollback',
        proposalId,
        reason,
        state: 'ROLLED_BACK',
        at: record.at,
      },
      timestamp: record.at,
    });

    console.log(`[governance] rollback recorded ${proposalId}: ${reason}`);
    return record;
  }

  /** All rollbacks recorded in this process (newest last). */
  records(): readonly RollbackRecord[] {
    return this.history;
  }

  /** Most recent rollback, or null. */
  last(): RollbackRecord | null {
    return this.history[this.history.length - 1] ?? null;
  }
}
