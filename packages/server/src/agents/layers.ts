/**
 * Agent Layer Contracts (master findings P2.5) — the typed hand-offs between
 * the four architectural layers. Deliberately NOT four new subsystems: each
 * contract is implemented by wiring code that already exists.
 *
 *   STRATEGIC   goals (strategic/goals.ts) → emit objectives
 *       ↓ goalId attached at task spawn (tools/task.ts)
 *   EXECUTION   subagents (tools/task.ts) → run work, produce results
 *       ↓ terminal status + VerificationState (verification.ts)
 *   VALIDATION  buildVerificationPatch → VERIFIED / FAILED_VERIFICATION
 *       ↓ outcome + verification state
 *   LEARNING    this module's recordTaskOutcome → RCSI ledger stats
 *               (strategy_effectiveness + strategy_log in shared/context.json)
 *
 * The learning hand-off is the piece that was missing: task outcomes never
 * reached recordOutcome/logStrategy, so the RCSI failure analysis
 * (analyzeFailures) had no execution data to learn from.
 */

import { recordOutcome, logStrategy } from '../learning/ledger.js'
import type { VerificationState } from '../verification.js'

// ── Layer contracts ─────────────────────────────────────────────────

/** STRATEGIC → EXECUTION: which goal a delegated task advances. */
export interface StrategicLink {
  goalId: string
  taskID: string
}

/** EXECUTION → VALIDATION → LEARNING: the terminal outcome of a task. */
export interface ExecutionOutcome {
  taskID: string
  /** agent persona that ran the task (may be undefined for default) */
  agent?: string
  status: 'completed' | 'failed' | 'cancelled'
  /** verification state if the validation layer produced one */
  verificationState?: VerificationState
  /** strategic goal this task was linked to at spawn, if any */
  goalId?: string
}

// ── Strategic↔Execution linkage registry ────────────────────────────
// In-memory by design: jobs persist, but a lost link across restarts only
// means the learning feedback for that task doesn't fire — never a failure.

const taskGoals = new Map<string, string>()

/** Link a spawned task to a strategic goal (STRATEGIC → EXECUTION hand-off). */
export function linkTaskGoal(taskID: string, goalId: string): void {
  taskGoals.set(taskID, goalId)
}

/** Resolve the goal a task was linked to (undefined if none / lost restart). */
export function taskGoal(taskID: string): string | undefined {
  return taskGoals.get(taskID)
}

// ── LEARNING hand-off ────────────────────────────────────────────────

/**
 * Feed a terminal task outcome into the learning layer (RCSI ledger):
 *   - strategy_effectiveness[agent:<persona>] gains success/failure stats,
 *     which analyzeFailures() uses to detect consistently-failing agents
 *   - strategy_log gains the outcome with goal linkage for the audit trail
 *
 * Best-effort by contract: ledger I/O failures are swallowed — the learning
 * layer must never break execution.
 */
export function recordTaskOutcome(outcome: ExecutionOutcome): void {
  try {
    const strategy = `agent:${outcome.agent ?? 'general'}`
    // VERIFIED counts as success; UNVERIFIED/PARTIALLY_VERIFIED does not —
    // unverified work is not evidence of a working strategy.
    const success =
      outcome.status === 'completed' &&
      (outcome.verificationState === undefined || outcome.verificationState === 'VERIFIED')

    recordOutcome(strategy, success)
    logStrategy({
      strategy_chosen: strategy,
      agent_target: outcome.agent ?? 'general',
      outcome: `${outcome.status}${outcome.verificationState ? `:${outcome.verificationState}` : ''}${
        outcome.goalId ? ` goal=${outcome.goalId}` : ''
      }`,
    })
  } catch {
    // learning-layer failures never propagate to execution
  }
}
