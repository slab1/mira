export class RollbackManager {
  async rollback(proposalId: string, reason: string): Promise<void> {
    // Placeholder rollback implementation
    // Real implementation would revert applied patch, update proposal state
    console.log(`[governance] rollback ${proposalId}: ${reason}`);
  }
}
