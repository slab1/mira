/**
 * Review Completeness Manifests
 *
 * Generates and persists structured code-review & verification coverage
 * manifests across 7 required surfaces (changed files, callers/dependents,
 * tool/event registrations, adapters/hooks, config/schema/migrations,
 * expected tests, and analysis limitations), using git diffs, CodeGraph,
 * and workspace file_snapshots when git is unavailable.
 */
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { z } from 'zod'
import { desc, eq } from 'drizzle-orm'
import type { MiraDB } from '../storage/db.js'
import { codeGraphFor } from '../codegraph/index.js'
import { fingerprintWorkspace } from '../workspace-fingerprint.js'

export const REVIEW_SECTION_IDS = [
  'changed_files',
  'callers_dependents',
  'tool_event_registrations',
  'adapters_hooks',
  'configuration_schema_migrations',
  'expected_tests',
  'analysis_limitations',
] as const

export const ReviewSectionIdSchema = z.enum(REVIEW_SECTION_IDS)
export type ReviewSectionId = z.infer<typeof ReviewSectionIdSchema>

export const ReviewDispositionSchema = z.enum([
  'pending',
  'inspected',
  'tested',
  'not_applicable',
  'unresolved',
])
export type ReviewDisposition = z.infer<typeof ReviewDispositionSchema>

export const ReviewItemSchema = z.object({
  id: z.string(),
  kind: z.enum(['changed_file', 'dependent']),
  path: z.string(),
  sourcePath: z.string().optional(),
  provenance: z.enum(['diff', 'snapshot', 'reverse_import', 'import', 'symbol_call']).optional(),
  detail: z.string().optional(),
  disposition: ReviewDispositionSchema,
  evidenceRefs: z.array(z.string()).default([]),
  reason: z.string().optional(),
  testCommand: z.string().optional(),
})
export type ReviewItem = z.infer<typeof ReviewItemSchema>

export const ReviewSectionSchema = z.object({
  id: ReviewSectionIdSchema,
  candidatePaths: z.array(z.string()),
  disposition: ReviewDispositionSchema,
  evidenceRefs: z.array(z.string()).default([]),
  reason: z.string().optional(),
  testCommand: z.string().optional(),
})
export type ReviewSection = z.infer<typeof ReviewSectionSchema>

export const ReviewFindingSchema = z.object({
  id: z.string(),
  sourceFindingId: z.string().optional(),
  title: z.string(),
  severity: z.enum(['critical', 'high', 'major', 'minor', 'nit']),
  disposition: z.enum([
    'fixed',
    'not_applicable',
    'deferred',
    'duplicate',
    'not_reproducible',
    'unresolved',
  ]),
  changedFiles: z.array(z.string()).default([]),
  testRefs: z.array(z.string()).default([]),
  testCommand: z.string().optional(),
  testOutcome: z.enum(['passed', 'not_run', 'not_feasible']).optional(),
  testNotFeasibleReason: z.string().optional(),
  rationale: z.string().optional(),
  duplicateOf: z.string().optional(),
})
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>

export const ReviewCoverageManifestSchema = z
  .object({
    version: z.literal(1),
    id: z.string(),
    sessionID: z.string(),
    baseRef: z.string(),
    baseSha: z.string(),
    headRef: z.string(),
    headSha: z.string(),
    candidateHash: z.string().optional(),
    generatedAt: z.number().int(),
    updatedAt: z.number().int(),
    state: z.enum(['in_progress', 'complete', 'blocked']),
    diff: z.object({
      changedFiles: z.array(z.object({ path: z.string(), status: z.string() })),
      truncated: z.boolean(),
    }),
    graph: z.object({
      complete: z.boolean(),
      indexedFiles: z.number().int().nonnegative(),
      discoveredSourceFiles: z.number().int().nonnegative(),
      truncated: z.boolean(),
      caveats: z.array(z.string()),
    }),
    requiredSectionIds: z.array(ReviewSectionIdSchema),
    sections: z.array(ReviewSectionSchema),
    requiredItemIds: z.array(z.string()),
    items: z.array(ReviewItemSchema),
    requiredFindingIds: z.array(z.string()),
    findings: z.array(ReviewFindingSchema),
    blockers: z.array(z.string()),
  })
  .strict()

export type ReviewCoverageManifest = z.infer<typeof ReviewCoverageManifestSchema>

function runGit(cwd: string, args: string[]): string | null {
  try {
    const out = spawnSync('git', args, { cwd, encoding: 'utf-8', timeout: 4000 })
    if (out.status !== 0) return null
    return (out.stdout ?? '').trimEnd()
  } catch {
    return null
  }
}

function classifySections(paths: string[]): Record<ReviewSectionId, string[]> {
  const map: Record<ReviewSectionId, string[]> = {
    changed_files: [...paths],
    callers_dependents: [],
    tool_event_registrations: [],
    adapters_hooks: [],
    configuration_schema_migrations: [],
    expected_tests: [],
    analysis_limitations: [],
  }
  for (const p of paths) {
    const low = p.toLowerCase()
    if (low.includes('/tools/') || low.includes('registry') || low.includes('bus') || low.includes('events')) {
      map.tool_event_registrations.push(p)
    }
    if (low.includes('adapter') || low.includes('hook') || low.includes('middleware') || low.includes('route')) {
      map.adapters_hooks.push(p)
    }
    if (
      low.includes('schema') ||
      low.includes('db.ts') ||
      low.includes('migration') ||
      low.includes('config') ||
      low.endsWith('.json')
    ) {
      map.configuration_schema_migrations.push(p)
    }
    if (low.includes('.test.') || low.includes('.spec.') || low.includes('/eval/')) {
      map.expected_tests.push(p)
    }
  }
  return map
}

function recomputeManifestState(manifest: ReviewCoverageManifest): ReviewCoverageManifest {
  const blockers: string[] = []
  for (const s of manifest.sections) {
    if (s.candidatePaths.length > 0 && (s.disposition === 'pending' || s.disposition === 'unresolved')) {
      blockers.push(`Section "${s.id}" is ${s.disposition} (${s.candidatePaths.length} files)`)
    }
  }
  for (const item of manifest.items) {
    if (item.disposition === 'pending' || item.disposition === 'unresolved') {
      blockers.push(`Item "${item.path}" (${item.kind}) is ${item.disposition}`)
    }
  }
  for (const f of manifest.findings) {
    if (f.disposition === 'unresolved') {
      blockers.push(`Finding "${f.title}" is unresolved`)
    }
  }
  const hasUnresolved = blockers.length > 0
  const anyTouched =
    manifest.sections.some((s) => s.disposition !== 'pending') ||
    manifest.items.some((i) => i.disposition !== 'pending')
  return {
    ...manifest,
    blockers,
    state: !hasUnresolved ? 'complete' : anyTouched ? 'in_progress' : 'blocked',
  }
}

export async function generateReviewCoverageManifest(opts: {
  db: MiraDB
  sessionID: string
  cwd?: string
  baseRef?: string
  headRef?: string
}): Promise<ReviewCoverageManifest> {
  const cwd = opts.cwd ?? process.cwd()
  const now = Date.now()
  const caveats: string[] = []

  const fp = await fingerprintWorkspace(cwd).catch(() => undefined)
  const headSha = fp?.baseHash ?? runGit(cwd, ['rev-parse', 'HEAD']) ?? 'workspace'
  const baseRef = opts.baseRef ?? 'HEAD'
  const headRef = opts.headRef ?? 'WORKING_TREE'

  let changedFiles: Array<{ path: string; status: string }> = []
  const gitStatus = runGit(cwd, ['status', '--porcelain=v1'])
  if (gitStatus !== null) {
    for (const line of gitStatus.split('\n')) {
      if (!line) continue
      const status = line.slice(0, 2).trim() || 'M'
      const filePath = line.slice(3).trim()
      if (filePath) changedFiles.push({ path: filePath, status })
    }
  } else {
    caveats.push('Git repository metadata unavailable; falling back to recorded session file_snapshots.')
  }

  // Fallback / augment with session file snapshots from DB
  try {
    const snaps = await opts.db.query.fileSnapshots.findMany({
      where: (fs, { eq: eqFn }) => eqFn(fs.sessionID, opts.sessionID),
      orderBy: desc(opts.db.schema.fileSnapshots.createdAt),
      limit: 100,
    })
    const seen = new Set(changedFiles.map((c) => c.path))
    for (const s of snaps) {
      if (!seen.has(s.path)) {
        seen.add(s.path)
        changedFiles.push({ path: s.path, status: s.content === null ? 'D' : 'M' })
      }
    }
  } catch {}

  changedFiles = changedFiles.slice(0, 200)
  const paths = changedFiles.map((c) => c.path)

  const graph = codeGraphFor(opts.db)
  const stats = graph.stats()
  const sectionPaths = classifySections(paths)
  const items: ReviewItem[] = changedFiles.map((cf, idx) => ({
    id: `file:${idx}:${cf.path}`,
    kind: 'changed_file',
    path: cf.path,
    provenance: gitStatus ? 'diff' : 'snapshot',
    detail: `Status: ${cf.status}`,
    disposition: 'pending',
    evidenceRefs: [],
  }))

  const dependentPaths = new Set<string>()
  for (const p of paths.slice(0, 40)) {
    try {
      const deps = graph.findDependents(p, 20)
      for (const d of deps) {
        if (!paths.includes(d) && !dependentPaths.has(d)) {
          dependentPaths.add(d)
          items.push({
            id: `dep:${items.length}:${d}`,
            kind: 'dependent',
            path: d,
            sourcePath: p,
            provenance: 'reverse_import',
            detail: `Imports ${p}`,
            disposition: 'pending',
            evidenceRefs: [],
          })
        }
      }
    } catch {}
  }
  sectionPaths.callers_dependents = [...dependentPaths]
  if (stats.files === 0) {
    caveats.push('AST CodeGraph index is currently empty; reverse-import dependents may be incomplete.')
  }
  if (caveats.length > 0) {
    sectionPaths.analysis_limitations = caveats
  }

  const sections: ReviewSection[] = REVIEW_SECTION_IDS.map((id) => ({
    id,
    candidatePaths: sectionPaths[id],
    disposition: sectionPaths[id].length === 0 ? 'not_applicable' : 'pending',
    evidenceRefs: [],
    reason: sectionPaths[id].length === 0 ? 'No matching files in current diff or snapshot set.' : undefined,
  }))

  // Load any open findings for this session
  const sessionFindings = await opts.db.query.findings
    .findMany({
      where: (f, { eq: eqFn }) => eqFn(f.sessionID, opts.sessionID),
    })
    .catch(() => [])

  const findings: ReviewFinding[] = sessionFindings.map((f) => ({
    id: `rf_${f.id}`,
    sourceFindingId: f.id,
    title: f.title,
    severity: (f.severity === 'critical'
      ? 'critical'
      : f.severity === 'major'
        ? 'major'
        : 'minor') as ReviewFinding['severity'],
    disposition: (f.status === 'resolved' ? 'fixed' : 'unresolved') as ReviewFinding['disposition'],
    changedFiles: [],
    testRefs: [],
    rationale: f.evidence ?? undefined,
  }))

  const baseManifest: ReviewCoverageManifest = {
    version: 1,
    id: `rcm_${randomUUID().slice(0, 12)}`,
    sessionID: opts.sessionID,
    baseRef,
    baseSha: headSha,
    headRef,
    headSha,
    candidateHash: fp?.candidateHash,
    generatedAt: now,
    updatedAt: now,
    state: 'blocked',
    diff: { changedFiles, truncated: changedFiles.length >= 200 },
    graph: {
      complete: stats.files > 0 && caveats.length === 0,
      indexedFiles: stats.files,
      discoveredSourceFiles: stats.files,
      truncated: false,
      caveats,
    },
    requiredSectionIds: [...REVIEW_SECTION_IDS],
    sections,
    requiredItemIds: items.map((i) => i.id),
    items,
    requiredFindingIds: findings.map((f) => f.id),
    findings,
    blockers: [],
  }

  const finalized = recomputeManifestState(baseManifest)
  await opts.db.insert(opts.db.schema.reviewCoverageManifests).values({
    id: finalized.id,
    sessionID: finalized.sessionID,
    manifestJson: JSON.stringify(finalized),
    createdAt: finalized.generatedAt,
    updatedAt: finalized.updatedAt,
  })
  return finalized
}

export async function listReviewManifests(
  db: MiraDB,
  sessionID?: string,
  limit = 20,
): Promise<ReviewCoverageManifest[]> {
  const rows = sessionID
    ? await db.query.reviewCoverageManifests.findMany({
        where: eq(db.schema.reviewCoverageManifests.sessionID, sessionID),
        orderBy: desc(db.schema.reviewCoverageManifests.updatedAt),
        limit,
      })
    : await db.query.reviewCoverageManifests.findMany({
        orderBy: desc(db.schema.reviewCoverageManifests.updatedAt),
        limit,
      })
  const out: ReviewCoverageManifest[] = []
  for (const r of rows) {
    try {
      out.push(JSON.parse(r.manifestJson) as ReviewCoverageManifest)
    } catch {}
  }
  return out
}

export async function getReviewManifestById(
  db: MiraDB,
  id: string,
): Promise<ReviewCoverageManifest | null> {
  const row = await db.query.reviewCoverageManifests.findFirst({
    where: eq(db.schema.reviewCoverageManifests.id, id),
  })
  if (!row) return null
  try {
    return JSON.parse(row.manifestJson) as ReviewCoverageManifest
  } catch {
    return null
  }
}

export async function updateReviewManifest(
  db: MiraDB,
  id: string,
  patch: {
    section?: { id: ReviewSectionId; disposition: ReviewDisposition; reason?: string; evidenceRefs?: string[] }
    item?: { id: string; disposition: ReviewDisposition; reason?: string; evidenceRefs?: string[]; testCommand?: string }
    finding?: ReviewFinding
  },
): Promise<ReviewCoverageManifest | null> {
  const current = await getReviewManifestById(db, id)
  if (!current) return null

  const next: ReviewCoverageManifest = {
    ...current,
    updatedAt: Date.now(),
    sections: current.sections.map((s) =>
      patch.section && s.id === patch.section.id
        ? {
            ...s,
            disposition: patch.section.disposition,
            reason: patch.section.reason ?? s.reason,
            evidenceRefs: patch.section.evidenceRefs ?? s.evidenceRefs,
          }
        : s,
    ),
    items: current.items.map((i) =>
      patch.item && i.id === patch.item.id
        ? {
            ...i,
            disposition: patch.item.disposition,
            reason: patch.item.reason ?? i.reason,
            evidenceRefs: patch.item.evidenceRefs ?? i.evidenceRefs,
            testCommand: patch.item.testCommand ?? i.testCommand,
          }
        : i,
    ),
    findings: patch.finding
      ? current.findings.some((f) => f.id === patch.finding!.id)
        ? current.findings.map((f) => (f.id === patch.finding!.id ? patch.finding! : f))
        : [...current.findings, patch.finding]
      : current.findings,
  }

  const finalized = recomputeManifestState(next)
  await db
    .update(db.schema.reviewCoverageManifests)
    .set({
      manifestJson: JSON.stringify(finalized),
      updatedAt: finalized.updatedAt,
    })
    .where(eq(db.schema.reviewCoverageManifests.id, id))

  return finalized
}
