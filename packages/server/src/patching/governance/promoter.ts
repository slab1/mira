import type { PatchProposal } from './types.js'
import { createPullRequestForPatch } from '../autopilot.js'

export class Promoter {
  constructor(private rootDir: string) {}

  async promote(
    proposal: PatchProposal,
  ): Promise<{ applied: boolean; prUrl?: string; reason?: string }> {
    // Placeholder promotion: create PR via autopilot if enabled
    // Real implementation would apply patch to production
    const result = await createPullRequestForPatch({
      repoRoot: this.rootDir,
      files: proposal.targetFile ? [proposal.targetFile] : [],
      painPointId: proposal.painPointId,
      reason: proposal.reason,
      change: proposal.change,
      patchId: proposal.patchId,
    })
    return {
      applied: result.created,
      prUrl: result.prUrl,
      // Never return a refusal without a cause — the gate reports this to the
      // operator, and an unexplained `applied:false` is unactionable.
      ...(result.created ? {} : { reason: result.reason ?? 'promotion not applied' }),
    }
  }
}
