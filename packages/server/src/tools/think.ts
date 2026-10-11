/**
 * Tool: think — a private reasoning scratchpad (no side effects).
 *
 * Agents that plan in-line between tool calls make measurably fewer wrong-file
 * and wrong-position edits: the think step forces an explicit statement of
 * WHICH file/region is about to change and WHY, before the mutation happens.
 * The thought is persisted as a normal tool call/result pair, so it shows up
 * in traces (TraceViewer, session export) instead of vanishing.
 *
 * Mirrors the well-known "think" tool pattern: zero side effects, no
 * permissions, pure structure for the model's own reasoning.
 */
import { z } from 'zod'
import type { ToolDef } from './registry.js'

const thinkSchema = z.object({
  thought: z
    .string()
    .min(1)
    .max(8000)
    .describe(
      'Your reasoning: which file/region you are about to change and why, ' +
        'what could go wrong, what you will verify afterwards.',
    ),
})

export const thinkTool = {
  name: 'think',
  description:
    'Reason privately before acting — no side effects, nothing is executed. ' +
    'Use before non-trivial edits to state the target file/region, the approach, ' +
    'the risks, and how you will verify the result. Use between steps of a long ' +
    'plan to check progress. The thought is recorded in the session trace.',
  category: 'other',
  schema: thinkSchema,
  async execute({ thought }) {
    // Deliberately nothing else: no IO, no state, no permissions. The value is
    // the forced structure + the persisted trace of the reasoning itself.
    return { ok: true, thoughtLength: thought.length }
  },
} satisfies ToolDef<typeof thinkSchema>

export const tools = [thinkTool]
