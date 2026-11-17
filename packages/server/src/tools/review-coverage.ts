import { z } from 'zod'
import type { JsonValue } from '../types/index.js'
import { reviewCoverageManifests } from '../storage/schema.js'
import type { MiraDB } from '../storage/db.js'
import {
  addReviewFinding,
  applyItemDisposition,
  applySectionDisposition,
  buildReviewCoverageManifest,
  finalizeReviewCoverage,
  getReviewDiff,
  repositoryRoot,
  ReviewSectionIdSchema,
  ReviewCoverageManifestSchema,
  type ReviewCoverageManifest,
} from '../review/coverage.js'
import { toolError, type ToolContext, type ToolDef } from './registry.js'

const itemDispositionSchema = z.object({
  action: z.literal('disposition'),
  manifestId: z.string().uuid(),
  target: z.enum(['item', 'section']),
  itemId: z.string().optional(),
  sectionId: ReviewSectionIdSchema.optional(),
  disposition: z.enum(['inspected', 'tested', 'not_applicable', 'unresolved']),
  evidenceRefs: z.array(z.string().min(1).max(500)).max(30).optional(),
  reason: z.string().max(2000).optional(),
  testCommand: z.string().max(1000).optional(),
})

const reviewCoverageSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('generate'),
    baseRef: z
      .string()
      .max(160)
      .optional()
      .describe(
        'Comparison base ref; defaults to origin/HEAD, origin/main, main, origin/master, or master when available.',
      ),
    headRef: z
      .string()
      .max(160)
      .optional()
      .describe(
        'Commit ref, or WORKTREE (default) to include tracked and untracked worktree changes.',
      ),
  }),
  z.object({ action: z.literal('get'), manifestId: z.string().uuid() }),
  z.object({
    action: z.literal('diff'),
    manifestId: z.string().uuid(),
    path: z.string().min(1).max(1000),
  }),
  itemDispositionSchema,
  z.object({
    action: z.literal('finding'),
    manifestId: z.string().uuid(),
    id: z.string().uuid().optional(),
    sourceFindingId: z.string().max(200).optional(),
    title: z.string().min(1).max(1000),
    severity: z.enum(['critical', 'high', 'major', 'minor', 'nit']),
    disposition: z.enum([
      'fixed',
      'not_applicable',
      'deferred',
      'duplicate',
      'not_reproducible',
      'unresolved',
    ]),
    changedFiles: z.array(z.string().max(1000)).max(50).optional(),
    testRefs: z.array(z.string().min(1).max(500)).max(30).optional(),
    testCommand: z.string().max(1000).optional(),
    testOutcome: z.enum(['passed', 'not_run', 'not_feasible']).optional(),
    testNotFeasibleReason: z.string().max(2000).optional(),
    rationale: z.string().max(3000).optional(),
    duplicateOf: z.string().uuid().optional(),
  }),
  z.object({ action: z.literal('finalize'), manifestId: z.string().uuid() }),
])

function requireDB(ctx: ToolContext): MiraDB {
  if (!ctx.db)
    throw toolError(
      'REVIEW_COVERAGE_DB_UNAVAILABLE',
      'Review coverage requires the session database.',
    )
  return ctx.db
}

function getManifest(
  db: MiraDB,
  manifestId: string,
  sessionID: string,
): { manifest: ReviewCoverageManifest; updatedAt: number } {
  const row = db.sqlite
    .prepare(
      'SELECT manifest_json, updated_at FROM review_coverage_manifests WHERE id = ? AND session_id = ?',
    )
    .get(manifestId, sessionID) as { manifest_json: string; updated_at: number } | null | undefined
  if (!row)
    throw toolError('REVIEW_COVERAGE_NOT_FOUND', 'Review manifest not found for this session.')
  let value: unknown
  try {
    value = JSON.parse(row.manifest_json)
  } catch {
    throw toolError('REVIEW_COVERAGE_CORRUPT', 'Stored review manifest is not valid JSON.')
  }
  const manifest = ReviewCoverageManifestSchema.safeParse(value)
  if (
    !manifest.success ||
    manifest.data.sessionID !== sessionID ||
    manifest.data.id !== manifestId
  ) {
    throw toolError('REVIEW_COVERAGE_CORRUPT', 'Stored review manifest failed validation.')
  }
  return { manifest: manifest.data, updatedAt: row.updated_at }
}

function insertManifest(db: MiraDB, manifest: ReviewCoverageManifest): void {
  db.insert(reviewCoverageManifests)
    .values({
      id: manifest.id,
      sessionID: manifest.sessionID,
      manifestJson: JSON.stringify(manifest),
      createdAt: manifest.generatedAt,
      updatedAt: manifest.updatedAt,
    })
    .run()
}

function persistManifest(
  db: MiraDB,
  manifest: ReviewCoverageManifest,
  expectedUpdatedAt: number,
): ReviewCoverageManifest {
  const updatedAt = Math.max(Date.now(), expectedUpdatedAt + 1)
  const next = ReviewCoverageManifestSchema.parse({ ...manifest, updatedAt })
  const result = db.sqlite
    .prepare(
      'UPDATE review_coverage_manifests SET manifest_json = ?, updated_at = ? WHERE id = ? AND session_id = ? AND updated_at = ?',
    )
    .run(JSON.stringify(next), updatedAt, manifest.id, manifest.sessionID, expectedUpdatedAt)
  if (result.changes !== 1) {
    throw toolError(
      'REVIEW_COVERAGE_CONFLICT',
      'Review manifest changed concurrently; reload it before applying another update.',
    )
  }
  return next
}

const reviewCoverageTool = {
  name: 'review_coverage',
  description:
    'Create and maintain a durable, session-scoped code-review coverage manifest. Start with action=generate. ' +
    'The partial AST graph only supplies candidates; every required section/item needs evidence or a reasoned disposition. ' +
    'Use action=diff to read exact changed hunks without shell access, action=disposition for each coverage item/section, ' +
    'action=finding to map every accepted finding to changed code and regression-test evidence or a documented exception, ' +
    'and action=finalize to check completeness. An incomplete manifest must not be reported as complete.',
  schema: reviewCoverageSchema,
  category: 'planning',
  metadata: {
    riskLevel: 'low',
    sideEffect: 'write',
    isReadOnly: false,
    isIdempotent: false,
    maxCallsPerRun: 200,
    timeoutMs: 30_000,
  },
  async execute(args, ctx: ToolContext): Promise<JsonValue> {
    const db = requireDB(ctx)
    if (args.action === 'generate') {
      try {
        const manifest = await buildReviewCoverageManifest({
          cwd: ctx.cwd ?? process.cwd(),
          sessionID: ctx.sessionID,
          baseRef: args.baseRef,
          headRef: args.headRef,
        })
        insertManifest(db, manifest)
        return {
          manifest,
          instructions:
            'Review every changed/dependent file and required section. Record inspected/tested evidence or reasoned not_applicable/unresolved dispositions; record each accepted finding before finalizing.',
        } as unknown as JsonValue
      } catch (error) {
        throw toolError('REVIEW_COVERAGE_GENERATE_FAILED', String(error).slice(0, 1000))
      }
    }

    const { manifest, updatedAt } = getManifest(db, args.manifestId, ctx.sessionID)
    if (args.action === 'get') return manifest as unknown as JsonValue
    if (args.action === 'diff') {
      try {
        const root = repositoryRoot(ctx.cwd ?? process.cwd())
        return getReviewDiff(root, manifest, args.path) as unknown as JsonValue
      } catch (error) {
        throw toolError('REVIEW_COVERAGE_DIFF_FAILED', String(error).slice(0, 1000))
      }
    }
    if (args.action === 'disposition') {
      try {
        let next: ReviewCoverageManifest
        const options = {
          evidenceRefs: args.evidenceRefs,
          reason: args.reason,
          testCommand: args.testCommand,
        }
        if (args.target === 'item') {
          if (!args.itemId) throw new Error('target=item requires itemId')
          next = applyItemDisposition(manifest, args.itemId, args.disposition, options)
        } else {
          if (!args.sectionId) throw new Error('target=section requires sectionId')
          next = applySectionDisposition(manifest, args.sectionId, args.disposition, options)
        }
        return persistManifest(db, next, updatedAt) as unknown as JsonValue
      } catch (error) {
        if ((error as { code?: string })?.code === 'REVIEW_COVERAGE_CONFLICT') throw error
        throw toolError('REVIEW_COVERAGE_INVALID_DISPOSITION', String(error).slice(0, 1000))
      }
    }
    if (args.action === 'finding') {
      try {
        const next = addReviewFinding(manifest, args)
        return persistManifest(db, next, updatedAt) as unknown as JsonValue
      } catch (error) {
        if ((error as { code?: string })?.code === 'REVIEW_COVERAGE_CONFLICT') throw error
        throw toolError('REVIEW_COVERAGE_INVALID_FINDING', String(error).slice(0, 1000))
      }
    }
    if (args.action === 'finalize') {
      const next = finalizeReviewCoverage(manifest)
      return persistManifest(db, next, updatedAt) as unknown as JsonValue
    }
    return toolError(
      'REVIEW_COVERAGE_INVALID_ACTION',
      'Unsupported review coverage action.',
    ) as unknown as JsonValue
  },
} satisfies ToolDef<typeof reviewCoverageSchema>

export const tools = [reviewCoverageTool]
export default tools
