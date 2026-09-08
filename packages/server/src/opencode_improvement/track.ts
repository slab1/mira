/**
 * opencode_improvement/track — TS equivalent of Python track.py
 * Tracks verdict/strategy outcomes into shared/context.json
 * Used by agents/critic.md verdict protocol.
 *
 * Usage:
 *   import { track } from "./opencode_improvement/track.js"
 *   await track("critic", "APPROVE", "packages/server/src/tools/edit.ts:23 — safe", { sim_id, durationMs: 120 })
 * CLI: `bun run packages/server/src/opencode_improvement/track.ts critic APPROVE "reason"`
 */

import { recordOutcome, logStrategy } from "../learning/ledger.js"

export interface TrackOpts {
  sim_id?: string
  simId?: string
  fileLine?: string
  durationMs?: number
  rootDir?: string
}

export async function track(agent: string, outcome: string, reason?: string, opts: TrackOpts = {}): Promise<{ success: boolean; success_rate: number }> {
  const success = ["APPROVE", "SUCCESS", "TRUE", "1"].includes(outcome.toUpperCase()) || outcome.toLowerCase() === "success"
  const stats = recordOutcome(agent, success, opts.rootDir)
  // Also append detailed log
  try {
    logStrategy({
      strategy_chosen: agent,
      agent_target: agent,
      outcome: `${outcome}${reason ? ` — ${reason.slice(0, 200)}` : ""}`,
    }, opts.rootDir)
  } catch {}
  // Mirror Python's JSON stdout for parity
  console.log(JSON.stringify({ agent, outcome, success, success_rate: stats.success_rate, sim_id: opts.sim_id ?? opts.simId, reason: reason?.slice(0, 200) }))
  return { success, success_rate: stats.success_rate }
}

// CLI entry
if (import.meta.main) {
  const [agent, outcome, reason] = Bun.argv.slice(2)
  if (!agent || !outcome) {
    console.error("Usage: bun run track.ts <agent> <APPROVE|REJECT|REVISE|success|failure> [reason] [--duration N] [--sim-id ID]")
    process.exit(1)
  }
  const simId = Bun.argv.find(a => a.startsWith("--sim-id="))?.split("=")[1] ?? Bun.argv[Bun.argv.indexOf("--sim-id") + 1]
  const durRaw = Bun.argv.find(a => a.startsWith("--duration"))?.split("=")[1] ?? Bun.argv[Bun.argv.indexOf("--duration") + 1]
  const durationMs = durRaw ? Number(durRaw) : undefined
  track(agent, outcome, reason, { sim_id: simId, durationMs }).then(() => process.exit(0))
}

export default track
