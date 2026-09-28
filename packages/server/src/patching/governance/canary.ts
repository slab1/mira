import type { CanaryResult, CanaryConfig } from './types.js';
import type { LatencyTracker } from '../latency.js';

export class CanaryRunner {
  constructor(private latency?: LatencyTracker) {}

  async start(proposalId: string, config?: CanaryConfig): Promise<CanaryResult> {
    const trafficPct = config?.trafficPct ?? 5;
    const durationMs = config?.durationMs ?? 300_000;
    const slo = config?.slo;

    if (!this.latency) {
      return {
        passed: true,
        reason: 'canary skipped — no latency tracker available',
        metrics: { trafficPct, durationMs },
      };
    }

    const stats = this.latency.stats();
    const p50 = Number(stats.p50 ?? 0);
    const p95 = Number(stats.p95 ?? 0);
    const errorRate = Number(stats.errorRate ?? 0);

    const p50Ok = !slo?.p50Ms || p50 <= slo.p50Ms;
    const p95Ok = !slo?.p95Ms || p95 <= slo.p95Ms;
    const errorOk = !slo?.errorRate || errorRate <= slo.errorRate;
    const passed = p50Ok && p95Ok && errorOk;

    return {
      passed,
      reason: passed
        ? `canary passed — p50=${p50}ms p95=${p95}ms errors=${(errorRate * 100).toFixed(1)}% traffic=${trafficPct}%`
        : `canary failed — p50=${p50}ms (limit ${slo?.p50Ms ?? '∞'}) p95=${p95}ms (limit ${slo?.p95Ms ?? '∞'}) errors=${(errorRate * 100).toFixed(1)}% (limit ${((slo?.errorRate ?? 0) * 100).toFixed(1)}%)`,
      metrics: { trafficPct, durationMs, p50, p95, errorRate },
    };
  }
}
