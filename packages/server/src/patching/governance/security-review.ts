import type { SecurityScanner } from '../security.js'
import type { GovernanceOutcome } from './types.js'

export interface SecurityReviewResult {
  passed: boolean
  reason: string
  outcome?: GovernanceOutcome
}

export class SecurityReview {
  constructor(private scanner?: SecurityScanner) {}

  async review(change: string, targetFile?: string | null): Promise<SecurityReviewResult> {
    // Fail closed. Previously an unconfigured scanner returned
    // `passed: true` ("security scanner not configured"), which walked the
    // proposal to SECURITY_PASSED and satisfied the promotion gate's
    // stage-evidence check. An absent scanner is not a clean review.
    if (!this.scanner) {
      return {
        passed: false,
        outcome: 'BLOCKED',
        reason: 'security review blocked — no scanner configured; the change was not reviewed',
      }
    }

    // `route` carries the target path so path-scoped rules (secrets, writable
    // config, CI definitions) can see WHERE the change lands, not just what
    // the diff text says.
    const result = this.scanner.scan({ text: change, ...(targetFile ? { route: targetFile } : {}) })

    // Honor the scanner's OWN verdict.
    //
    // This previously re-filtered to `severity === 'critical'` only, which
    // silently discarded every 'high' finding — the entire secrets-exposure
    // category. A diff shipping a hardcoded API key and POSTing it to an
    // external host was measured by the scanner, flagged, and then ignored:
    // the gate reported "security review passed". Counting only 'critical'
    // is not a policy, it is a bug that disarmed the gate.
    //
    // Fail-closed: ANY high-or-critical finding blocks. If the scanner itself
    // reports failure with no classified issues, we block too rather than
    // assume the reason is benign.
    const blocking = result.issues.filter((i) => i.severity === 'critical' || i.severity === 'high')
    const passed = blocking.length === 0 && (result.passed || result.issues.length === 0)
    return {
      passed,
      outcome: passed ? 'PASSED' : 'FAILED',
      reason: passed
        ? 'security review passed'
        : `security issues found: ${blocking.map((i) => `${i.severity}/${i.category ?? 'issue'}: ${i.detail}`).join('; ')}`,
    }
  }
}
