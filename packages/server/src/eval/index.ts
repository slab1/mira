/**
 * Mira Eval — Main Runner (3-Tier)
 *
 * Tiers:
 *   pr       → fast checks, blocks merge (< 5 min)
 *   nightly  → LLM-as-judge + benchmarks (~30 min)
 *   prod     → drift alerts (continuous)
 *
 * Usage:
 *   bun src/eval/index.ts --tier pr
 *   bun src/eval/index.ts --tier nightly
 *   bun src/eval/index.ts --tier prod
 *   bun src/eval/index.ts --tier all
 *
 * Programmatic:
 *   import { runEval, EvalRunner } from "./eval/index.js"
 *   const report = await runEval("pr")
 */

import { getTier, listTiers, type TierName, type TierReport } from "./tiers.js";
import { createTrace, startSpan, endSpan, flush, exportTraces, type ExportedTraces } from "./tracing.js";

export interface EvalReport {
  requested: TierName | "all";
  at: string;
  sha?: string;
  branch?: string;
  tiers: TierReport[];
  passed: boolean;
  durationMs: number;
  traces?: ExportedTraces;
}

export class EvalRunner {
  async run(tier: TierName | "all", opts: { sha?: string; branch?: string } = {}): Promise<EvalReport> {
    const t0 = Date.now();
    const trace = createTrace(`eval:${tier}`, { tier, sha: opts.sha, branch: opts.branch });
    const targetTiers: TierName[] =
      tier === "all" ? (["pr", "nightly", "prod"] as TierName[]) : [tier as TierName];

    const reports: TierReport[] = [];
    for (const name of targetTiers) {
      const cfg = getTier(name);
      const span = startSpan(trace, `tier:${name}`, { tier: name });
      try {
        const { runTier } = await import("./tiers.js");
        const report = await runTier(cfg, {
          tier: name,
          sha: opts.sha ?? process.env.GITHUB_SHA,
          branch: opts.branch ?? process.env.GITHUB_REF_NAME,
          env: process.env as Record<string, string>,
        });
        endSpan(span, { passed: report.passed, checks: report.checks.length, summary: report.summary });
        reports.push(report);
        console.log(`[eval:${name}] ${report.summary}`);
        for (const c of report.checks) {
          const icon = c.passed ? "✓" : "✗";
          console.log(`  ${icon} ${c.checkId} — ${c.message ?? ""} ${c.score !== undefined ? `(score ${c.score.toFixed(2)})` : ""} ${c.latencyMs}ms`);
        }
        // If PR tier fails and it's blocking, short-circuit (still reports)
        if (!report.passed && cfg.blocking) {
          console.error(`[eval] blocking tier ${name} failed — stopping`);
          if (tier !== "all") break;
        }
      } catch (e) {
        endSpan(span, { error: String(e) }, true);
        const failed: TierReport = {
          tier: name,
          passed: false,
          durationMs: Date.now() - span.startMs,
          checks: [{ checkId: "tier-error", passed: false, latencyMs: 0, message: String(e) }],
          summary: `${name} ERROR: ${String(e).slice(0, 200)}`,
        };
        reports.push(failed);
      }
    }

    await flush().catch(() => {});
    const durationMs = Date.now() - t0;
    const passed = reports.every(r => r.passed);
    const at = new Date().toISOString();
    if (!passed) console.error(`[eval] ✗ ${tier} FAILED in ${durationMs}ms`);
    else console.log(`[eval] ✓ ${tier} PASSED in ${durationMs}ms`);

    return {
      requested: tier,
      at,
      sha: opts.sha ?? process.env.GITHUB_SHA,
      branch: opts.branch,
      tiers: reports,
      passed,
      durationMs,
      traces: exportTraces(),
    };
  }
}

export async function runEval(tier: TierName | "all" = "pr", opts: { sha?: string; branch?: string } = {}): Promise<EvalReport> {
  const runner = new EvalRunner();
  return runner.run(tier, opts);
}

// ── CLI ───────────────────────────────────────────────────────────────

function parseTier(argv: string[]): TierName | "all" {
  const idx = argv.findIndex(a => a === "--tier" || a === "-t");
  const raw = idx !== -1 ? argv[idx + 1] : argv.find(a => a.startsWith("--tier="))?.split("=")[1];
  const v = (raw ?? "pr").toLowerCase();
  if (v === "all" || v === "pr" || v === "nightly" || v === "prod") return v;
  console.warn(`[eval] unrecognized tier "${raw}", defaulting to pr`);
  return "pr";
}

export function printReport(report: EvalReport): void {
  console.log("\n" + "─".repeat(60));
  console.log(`Mira Eval Report — ${report.requested} — ${report.passed ? "PASS" : "FAIL"} — ${report.durationMs}ms`);
  console.log(`at: ${report.at}  sha: ${report.sha ?? "local"}  branch: ${report.branch ?? "local"}`);
  for (const t of report.tiers) {
    console.log(`\n[${t.tier}] ${t.summary}`);
    for (const c of t.checks) console.log(`  ${c.passed ? "✓" : "✗"} ${c.checkId.padEnd(18)} ${c.message ?? ""}`);
  }
  console.log("─".repeat(60) + "\n");
}

if (import.meta.main) {
  const tier = parseTier(Bun.argv);
  const runner = new EvalRunner();
  const report = await runner.run(tier);
  printReport(report);
  // Emit JSON for CI artifacts if requested
  if (Bun.argv.includes("--json")) {
    const out = Bun.argv.includes("--out") ? Bun.argv[Bun.argv.indexOf("--out") + 1] : undefined;
    const json = JSON.stringify(report, null, 2);
    if (out) await Bun.write(out, json);
    else console.log(json);
  }
  // GitHub Actions output
  if (process.env.GITHUB_OUTPUT) {
    try { await Bun.write(process.env.GITHUB_OUTPUT, `passed=${report.passed}\ndurationMs=${report.durationMs}\n`); } catch {}
  }
  process.exit(report.passed ? 0 : 1);
}

// Re-exports for ergonomic imports
export * from "./tiers.js";
export * from "./judge.js";
export * from "./benchmarks.js";
export * from "./tracing.js";
