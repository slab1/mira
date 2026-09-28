import type { LatencyTracker } from '../latency.js';
import type { BenchmarkResult, MetricSnapshot } from './types.js';
import { RegressionDetector } from './regression.js';

export class BenchmarkRunner {
  private regression = new RegressionDetector();

  constructor(private latency?: LatencyTracker) {}

  async run(beforeStats?: MetricSnapshot, afterStats?: MetricSnapshot): Promise<BenchmarkResult> {
    // If no latency tracker or no stats provided, fall back to pass-through
    if (!this.latency || !beforeStats || !afterStats) {
      return {
        passed: true,
        reason: 'benchmark skipped — no latency data available',
        before: beforeStats,
        after: afterStats,
        delta: {},
      };
    }

    // Compare p50/p95 latency metrics
    const baseline: Record<string, { value: number; unit: string }> = {
      p50: { value: beforeStats.p50 ?? 0, unit: 'ms' },
      p95: { value: beforeStats.p95 ?? 0, unit: 'ms' },
    };
    const candidate: Record<string, { value: number; unit: string }> = {
      p50: { value: afterStats.p50 ?? 0, unit: 'ms' },
      p95: { value: afterStats.p95 ?? 0, unit: 'ms' },
    };

    const result = this.regression.detect({ baseline, candidate });

    const delta: Record<string, number> = {};
    for (const key of Object.keys(baseline)) {
      const b = baseline[key].value;
      const c = candidate[key].value;
      delta[key] = b > 0 ? ((c - b) / b) * 100 : 0;
    }

    return {
      passed: result.passed,
      reason: result.passed
        ? `benchmark passed — p50 ${delta.p50?.toFixed(1)}%, p95 ${delta.p95?.toFixed(1)}%`
        : `benchmark failed — ${result.findings.map((f) => `${f.metric} +${f.deltaPct.toFixed(1)}%`).join(', ')}`,
      before: beforeStats,
      after: afterStats,
      delta,
    };
  }
}
