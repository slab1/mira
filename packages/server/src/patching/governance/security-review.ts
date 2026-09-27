import type { SecurityScanner } from '../security.js';

export class SecurityReview {
  constructor(private scanner?: SecurityScanner) {}

  async review(change: string, targetFile?: string | null): Promise<{ passed: boolean; reason: string }> {
    if (!this.scanner) {
      return { passed: true, reason: 'security scanner not configured' };
    }
    const result = this.scanner.scan({ text: change });
    const critical = result.issues.filter((i) => i.severity === 'critical');
    const passed = critical.length === 0;
    return {
      passed,
      reason: passed
        ? 'security review passed'
        : `security issues found: ${critical.map((i) => i.detail).join(', ')}`,
    };
  }
}
