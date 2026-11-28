import { z } from 'zod'
import type { ToolDef } from './registry.js'
import {
  generateReviewCoverageManifest,
  listReviewManifests,
  updateReviewManifest,
  validateReviewPatch,
  ReviewSectionIdSchema,
  ReviewDispositionSchema,
  ReviewFindingSchema,
} from '../review/coverage.js'
import type { JsonValue } from '../types/index.js'

const schema = z.object({
  action: z.enum(['generate', 'status', 'mark_section', 'mark_item', 'record_finding']),
  manifestId: z.string().optional().describe('Manifest ID for status/update actions'),
  sectionId: ReviewSectionIdSchema.optional(),
  itemId: z.string().optional(),
  disposition: ReviewDispositionSchema.optional(),
  reason: z.string().optional(),
  evidenceRefs: z.array(z.string()).optional(),
  testCommand: z.string().optional(),
  finding: ReviewFindingSchema.optional(),
})

export const reviewCoverageTool = {
  name: 'review_coverage',
  description:
    'Generate and update a structured Review Completeness Manifest tracking diff files, callers/dependents, registrations, schemas, expected tests, and findings.',
  category: 'other',
  metadata: {
    riskLevel: 'low',
    sideEffect: 'write',
    isReadOnly: false,
    isIdempotent: true,
  },
  schema,
  async execute(args, ctx) {
    if (!ctx.db) throw new Error('Database not available in tool context')
    if (args.action === 'generate') {
      const m = await generateReviewCoverageManifest({
        db: ctx.db,
        sessionID: ctx.sessionID,
        cwd: ctx.cwd,
      })
      return m as unknown as JsonValue
    }
    if (args.action === 'status') {
      const list = await listReviewManifests(ctx.db, ctx.sessionID, 5)
      return { latest: list[0] ?? null, count: list.length } as unknown as JsonValue
    }
    let id = args.manifestId
    if (!id) {
      const list = await listReviewManifests(ctx.db, ctx.sessionID, 1)
      id = list[0]?.id
    }
    if (!id) throw new Error('No review coverage manifest found; call action: "generate" first.')

    if (args.action === 'mark_section' && args.sectionId && args.disposition) {
      const patch = {
        section: {
          id: args.sectionId,
          disposition: args.disposition,
          reason: args.reason,
          evidenceRefs: args.evidenceRefs,
          testCommand: args.testCommand,
        },
      }
      const err = validateReviewPatch(patch)
      if (err) throw new Error(err)
      const updated = await updateReviewManifest(ctx.db, id, patch)
      return updated as unknown as JsonValue
    }
    if (args.action === 'mark_item' && args.itemId && args.disposition) {
      const patch = {
        item: {
          id: args.itemId,
          disposition: args.disposition,
          reason: args.reason,
          evidenceRefs: args.evidenceRefs,
          testCommand: args.testCommand,
        },
      }
      const err = validateReviewPatch(patch)
      if (err) throw new Error(err)
      const updated = await updateReviewManifest(ctx.db, id, patch)
      return updated as unknown as JsonValue
    }
    if (args.action === 'record_finding' && args.finding) {
      const patch = { finding: args.finding }
      const err = validateReviewPatch(patch)
      if (err) throw new Error(err)
      const updated = await updateReviewManifest(ctx.db, id, patch)
      return updated as unknown as JsonValue
    }
    throw new Error(`Invalid parameters for review_coverage action=${args.action}`)
  },
} satisfies ToolDef<typeof schema>

export const tools = [reviewCoverageTool]
export default reviewCoverageTool
