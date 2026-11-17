import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase, migrate } from '../storage/db.js'
import type { MiraDB } from '../storage/db.js'
import { Bus } from '../bus/index.js'
import { ToolRegistry, type ToolDef, type ToolContext } from '../tools/registry.js'
import { tools as reviewCoverageTools } from '../tools/review-coverage.js'
import {
  addReviewFinding,
  applyItemDisposition,
  buildReviewCoverageManifest,
  finalizeReviewCoverage,
  REVIEW_SECTION_IDS,
} from './coverage.js'

let root: string
let db: MiraDB
let registry: ToolRegistry

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function makeRepository(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'mira-review-coverage-'))
  git(cwd, 'init', '--quiet')
  git(cwd, 'config', 'user.name', 'Mira Test')
  git(cwd, 'config', 'user.email', 'mira-test@example.invalid')
  mkdirSync(join(cwd, 'src', 'tools'), { recursive: true })
  writeFileSync(join(cwd, 'src', 'lib.ts'), 'export function value(): number {\n  return 1\n}\n')
  writeFileSync(
    join(cwd, 'src', 'consumer.ts'),
    "import { value } from './lib'\nexport const result = value()\n",
  )
  git(cwd, 'add', '.')
  git(cwd, 'commit', '--quiet', '-m', 'base')
  return cwd
}

function makeRegistry(database: MiraDB): ToolRegistry {
  const bus = new Bus()
  const instance = new ToolRegistry({
    db: database,
    bus,
    permissions: {} as never,
    gateway: {} as never,
  })
  instance.register(reviewCoverageTools[0] as ToolDef)
  return instance
}

function context(sessionID: string): ToolContext {
  return { sessionID, messageID: 'message-review-1', cwd: root, db }
}

function seedSession(id: string): void {
  db.sqlite
    .prepare(
      'INSERT INTO sessions (id, title, model, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, id, 'test-model', 'test-provider', Date.now(), Date.now())
}

async function call(sessionID: string, args: Record<string, unknown>): Promise<any> {
  return registry.execute('review_coverage', args as never, context(sessionID))
}

beforeEach(async () => {
  root = makeRepository()
  writeFileSync(join(root, 'src', 'lib.ts'), 'export function value(): number {\n  return 2\n}\n')
  writeFileSync(
    join(root, 'src', 'tools', 'new-tool.ts'),
    "import { value } from '../lib'\nexport const toolValue = value()\n",
  )
  db = createDatabase(':memory:')
  await migrate(db)
  seedSession('session-review')
  seedSession('session-other')
  registry = makeRegistry(db)
})

afterEach(() => {
  try {
    db.sqlite.close()
  } catch {}
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {}
})

describe('buildReviewCoverageManifest', () => {
  test('captures tracked and untracked changes, direct graph candidates, section checklist, and bounded caveats', async () => {
    const manifest = await buildReviewCoverageManifest({
      cwd: root,
      sessionID: 'session-review',
      baseRef: 'HEAD',
      headRef: 'WORKTREE',
      now: 1234,
    })

    expect(manifest.sessionID).toBe('session-review')
    expect(manifest.generatedAt).toBe(1234)
    expect(manifest.updatedAt).toBe(1234)
    expect(manifest.state).toBe('in_progress')
    expect(manifest.diff.changedFiles).toEqual([
      { path: 'src/lib.ts', status: 'M' },
      { path: 'src/tools/new-tool.ts', status: 'A' },
    ])
    expect(
      manifest.items.some((item) => item.kind === 'dependent' && item.path === 'src/consumer.ts'),
    ).toBe(true)
    expect(
      manifest.items.some(
        (item) => item.kind === 'dependent' && item.path === 'src/tools/new-tool.ts',
      ),
    ).toBe(true)
    expect(manifest.requiredSectionIds).toEqual([...REVIEW_SECTION_IDS])
    expect(manifest.sections.map((section) => section.id)).toEqual([...REVIEW_SECTION_IDS])
    expect(
      manifest.sections.find((section) => section.id === 'tool_event_registrations')
        ?.candidatePaths,
    ).toContain('src/tools/new-tool.ts')
    expect(manifest.graph.discoveredSourceFiles).toBeGreaterThanOrEqual(3)
    expect(manifest.graph.indexedFiles).toBeGreaterThanOrEqual(3)
    expect(manifest.graph.complete).toBe(false)
    expect(manifest.graph.caveats.length).toBeGreaterThan(0)
    expect(manifest.items.every((item) => item.disposition === 'pending')).toBe(true)
  })

  test('requires evidence for inspected items and refuses to finalize incomplete coverage', async () => {
    const manifest = await buildReviewCoverageManifest({
      cwd: root,
      sessionID: 'session-review',
      baseRef: 'HEAD',
      headRef: 'WORKTREE',
    })
    const item = manifest.items.find((candidate) => candidate.kind === 'changed_file')!

    expect(() => applyItemDisposition(manifest, item.id, 'inspected', {})).toThrow(
      /evidence reference/,
    )
    const updated = applyItemDisposition(manifest, item.id, 'inspected', {
      evidenceRefs: ['src/lib.ts:1'],
    })
    expect(updated.items.find((candidate) => candidate.id === item.id)?.disposition).toBe(
      'inspected',
    )

    const finalized = finalizeReviewCoverage(updated)
    expect(finalized.state).toBe('blocked')
    expect(finalized.blockers.some((blocker) => blocker.startsWith('Section '))).toBe(true)
    expect(finalized.blockers.some((blocker) => blocker.startsWith('Item '))).toBe(true)
  })

  test('requires fixed findings to include changed-file and regression-test evidence', async () => {
    const manifest = await buildReviewCoverageManifest({
      cwd: root,
      sessionID: 'session-review',
      baseRef: 'HEAD',
      headRef: 'WORKTREE',
    })
    expect(() =>
      addReviewFinding(manifest, {
        id: 'finding-invalid',
        title: 'Missing test evidence',
        severity: 'major',
        disposition: 'fixed',
        changedFiles: ['src/lib.ts'],
        testOutcome: 'passed',
      }),
    ).toThrow(/testCommand and testRefs/)
  })
})

describe('review_coverage tool', () => {
  test('supports generate, get, diff, disposition, finding, finalize, session isolation, and cascade deletion', async () => {
    const generated = await call('session-review', {
      action: 'generate',
      baseRef: 'HEAD',
      headRef: 'WORKTREE',
    })
    const manifestId = generated.manifest.id as string
    expect(manifestId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(generated.manifest.state).toBe('in_progress')

    const storedRow = db.sqlite
      .prepare('SELECT manifest_json, session_id FROM review_coverage_manifests WHERE id = ?')
      .get(manifestId) as { manifest_json: string; session_id: string }
    expect(storedRow.session_id).toBe('session-review')
    expect(JSON.parse(storedRow.manifest_json).id).toBe(manifestId)

    const loaded = await call('session-review', { action: 'get', manifestId })
    expect(loaded.id).toBe(manifestId)
    await expect(call('session-other', { action: 'get', manifestId })).rejects.toMatchObject({
      code: 'REVIEW_COVERAGE_NOT_FOUND',
    })

    const trackedDiff = await call('session-review', {
      action: 'diff',
      manifestId,
      path: 'src/lib.ts',
    })
    expect(trackedDiff.diff).toContain('-  return 1')
    expect(trackedDiff.diff).toContain('+  return 2')
    const untrackedDiff = await call('session-review', {
      action: 'diff',
      manifestId,
      path: 'src/tools/new-tool.ts',
    })
    expect(untrackedDiff.diff).toContain('+export const toolValue = value()')

    const targetItem = loaded.items.find(
      (item: { kind: string; path: string }) =>
        item.kind === 'changed_file' && item.path === 'src/lib.ts',
    )
    const afterItem = await call('session-review', {
      action: 'disposition',
      manifestId,
      target: 'item',
      itemId: targetItem.id,
      disposition: 'inspected',
      evidenceRefs: ['src/lib.ts:1'],
    })
    expect(
      afterItem.items.find((item: { id: string }) => item.id === targetItem.id).disposition,
    ).toBe('inspected')

    await call('session-review', {
      action: 'disposition',
      manifestId,
      target: 'section',
      sectionId: 'changed_files',
      disposition: 'inspected',
      evidenceRefs: ['reviewed exact changed-file diffs'],
    })

    const withFinding = await call('session-review', {
      action: 'finding',
      manifestId,
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      title: 'Documented non-reproducible review concern',
      severity: 'minor',
      disposition: 'not_reproducible',
      rationale: 'Reproduced against the current checkout and no longer occurs.',
    })
    expect(withFinding.requiredFindingIds).toContain('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')

    const incomplete = await call('session-review', { action: 'finalize', manifestId })
    expect(incomplete.state).toBe('blocked')
    expect(incomplete.blockers.length).toBeGreaterThan(0)

    let current = await call('session-review', { action: 'get', manifestId })
    for (const item of current.items) {
      if (item.disposition !== 'pending') continue
      current = await call('session-review', {
        action: 'disposition',
        manifestId,
        target: 'item',
        itemId: item.id,
        disposition: 'inspected',
        evidenceRefs: [`${item.path}: inspected`],
      })
    }
    for (const section of current.sections) {
      if (section.disposition !== 'pending') continue
      current = await call('session-review', {
        action: 'disposition',
        manifestId,
        target: 'section',
        sectionId: section.id,
        disposition: 'inspected',
        evidenceRefs: [`${section.id}: reviewed manually`],
      })
    }
    const complete = await call('session-review', { action: 'finalize', manifestId })
    expect(complete.state).toBe('complete')
    expect(complete.blockers).toEqual([])

    db.sqlite.prepare('DELETE FROM sessions WHERE id = ?').run('session-review')
    expect(
      db.sqlite.prepare('SELECT id FROM review_coverage_manifests WHERE id = ?').get(manifestId),
    ).toBeNull()
  })
})
