/**
 * Tool: team_memory_write — deliberate writes to the team memory files
 * (decisions / conventions / tech_debt) that every prompt reads.
 *
 * P2-3: these files were created + injected but had no writers, so agents
 * read empty templates. decisions.md is auto-fed by the decision log and
 * tech_debt.md by the repo timeline; this tool covers conventions (and the
 * other files) for deliberate agent captures: "we always do X here".
 */
import { z } from 'zod'
import type { ToolDef } from './registry.js'
import { appendTeamMemory } from '../memory/memory_controller.js'

const teamMemoryWriteSchema = z.object({
  file: z
    .enum(['decisions', 'conventions', 'tech_debt'])
    .describe('Which team memory file to append to'),
  summary: z
    .string()
    .min(1)
    .describe("One-line entry (imperative voice: 'Always …', 'Never …', 'We use …')"),
  detail: z
    .string()
    .optional()
    .describe('Supporting detail: evidence, rationale, examples, file references'),
})

const teamMemoryWrite = {
  name: 'team_memory_write',
  description:
    'Append a durable team memory (convention, decision, or known debt) to the memory_bank file ' +
    'that every future session reads. Use for repo conventions and patterns the team follows — ' +
    'not for transient task state (use todowrite) or personal notes (use memory_write).',
  category: 'memory',
  schema: teamMemoryWriteSchema,
  metadata: {
    riskLevel: 'low',
    sideEffect: 'write',
    isReadOnly: false,
    isIdempotent: false,
  },
  async execute({ file, summary, detail }, ctx) {
    await appendTeamMemory({
      file,
      summary,
      detail,
      source: `agent:${ctx.agent ?? 'unknown'}`,
      cwd: ctx.cwd,
    })
    return { ok: true, file, persisted: summary.slice(0, 200) }
  },
} satisfies ToolDef<typeof teamMemoryWriteSchema>

export const tools = [teamMemoryWrite]
export default tools
