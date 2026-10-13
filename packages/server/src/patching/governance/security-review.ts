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
    const critical = result.issues.filter((i) => i.severity === 'critical')
    const passed = critical.length === 0
    return {
      passed,
      outcome: passed ? 'PASSED' : 'FAILED',
      reason: passed
        ? 'security review passed'
        : `security issues found: ${critical.map((i) => i.detail).join(', ')}`,
    }
  }
}
