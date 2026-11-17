import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { Glob } from 'bun'
import { createDatabase } from '../storage/db.js'
import { CodeGraph } from '../codegraph/index.js'

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
  provenance: z.enum(['diff', 'reverse_import', 'import', 'symbol_call_candidate']).optional(),
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

const MAX_CHANGED_FILES = 200
const MAX_ITEMS = 1200
const MAX_DEPENDENTS_PER_FILE = 100
const MAX_DEPENDENCIES_PER_FILE = 100
const MAX_SYMBOLS_PER_FILE = 25
const MAX_CALLERS_PER_SYMBOL = 50
const MAX_GIT_BUFFER = 8 * 1024 * 1024
const MAX_DIFF_CHARS = 40_000
const SOURCE_GLOBS = ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx']
const GRAPH_IGNORE_RE = /node_modules|dist|build|\.git|\.next|out\/|coverage|\.turbo/
const GRAPH_CAVEATS = [
  'The AST graph indexes TS/TSX/JS/JSX and relative imports only; it does not prove absence of dynamic, reflective, generated, or non-source consumers.',
  'Symbol caller matches are global identifier-name candidates, not scope-resolved call edges; inspect them as possible dependents.',
  'Only direct dependency/caller candidates are generated. Review transitive effects, registrations, adapters, configuration, schemas, migrations, and tests separately.',
]

interface GitResult {
  stdout: string
  stderr: string
  status: number | null
  error?: Error
}

function runGit(cwd: string, args: string[]): GitResult {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: MAX_GIT_BUFFER,
    windowsHide: true,
  })
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
    error: result.error,
  }
}

function gitOutput(cwd: string, args: string[]): string {
  const result = runGit(cwd, args)
  if (result.error || result.status !== 0) {
    throw new Error(
      `git ${args[0] ?? 'command'} failed: ${(result.stderr ?? '').toString().slice(0, 300)}`,
    )
  }
  return result.stdout
}

function safeRef(ref: string): boolean {
  return (
    ref.length > 0 &&
    ref.length <= 160 &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) &&
    !ref.includes('..') &&
    !ref.includes('//') &&
    !ref.endsWith('/') &&
    !ref.endsWith('.')
  )
}

function resolveCommit(cwd: string, ref: string): string {
  if (!safeRef(ref)) throw new Error(`Invalid Git ref: ${ref}`)
  const result = runGit(cwd, [
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    `${ref}^{commit}`,
  ])
  const sha = result.stdout.trim()
  if (result.error || result.status !== 0 || !/^[a-f0-9]{40,64}$/i.test(sha)) {
    throw new Error(`Git ref does not resolve to a commit: ${ref}`)
  }
  return sha
}

export function repositoryRoot(cwd: string): string {
  return gitOutput(cwd, ['rev-parse', '--show-toplevel']).trim()
}

function defaultBaseRef(cwd: string): string {
  const symbolic = runGit(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  const candidates = [
    symbolic.status === 0 ? symbolic.stdout.trim() : '',
    'origin/main',
    'main',
    'origin/master',
    'master',
  ]
  for (const candidate of candidates) {
    if (candidate && safeRef(candidate)) {
      const check = runGit(cwd, [
        'rev-parse',
        '--verify',
        '--quiet',
        '--end-of-options',
        `${candidate}^{commit}`,
      ])
      if (check.status === 0 && /^[a-f0-9]{40,64}$/i.test(check.stdout.trim())) return candidate
    }
  }
  throw new Error('No default base ref found; supply baseRef (for example origin/main).')
}

function normalizeRepoPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.split('/').some((part) => part === '..')
  ) {
    throw new Error(`Unsafe path in Git diff: ${filePath}`)
  }
  return normalized.replace(/^\.\//, '')
}

function parseNameStatus(stdout: string): Array<{ path: string; status: string }> {
  const tokens = stdout.split('\0')
  const files: Array<{ path: string; status: string }> = []
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++]
    if (!status) continue
    const path = tokens[index++]
    if (typeof path !== 'string') throw new Error('Git returned an incomplete name-status record')
    files.push({ path: normalizeRepoPath(path), status: status.slice(0, 1) })
  }
  return files
}

function itemId(kind: ReviewItem['kind'], path: string, sourcePath = ''): string {
  const digest = createHash('sha256')
    .update(`${kind}\0${path}\0${sourcePath}`)
    .digest('hex')
    .slice(0, 16)
  return `${kind}:${digest}`
}

function sectionCandidatePaths(
  section: ReviewSectionId,
  changedFiles: string[],
  items: ReviewItem[],
  graphCaveats: string[],
): string[] {
  const allPaths = [...new Set([...changedFiles, ...items.map((item) => item.path)])].sort()
  const matches = (pattern: RegExp) => allPaths.filter((file) => pattern.test(file))
  switch (section) {
    case 'changed_files':
      return changedFiles
    case 'callers_dependents':
      return items.filter((item) => item.kind === 'dependent').map((item) => item.path)
    case 'tool_event_registrations':
      return matches(/(^|\/)(tools?|routes?|events?|bus|agents?|mcp|plugins?)(\/|\.|$)/i)
    case 'adapters_hooks':
      return matches(/adapter|provider|hook|middleware|integration|plugin/i)
    case 'configuration_schema_migrations':
      return matches(/config|schema|migration|\.ya?ml$|\.json$|\.toml$|\.sql$/i)
    case 'expected_tests':
      return matches(/(?:\.|\/)(?:test|spec)\.[cm]?[jt]sx?$/i)
    case 'analysis_limitations':
      return graphCaveats
  }
}

function expectedTestCandidates(root: string, changedFile: string): string[] {
  const extension = extname(changedFile)
  const stem = basename(changedFile, extension)
  const candidates = new Set<string>()
  const siblingDir = dirname(changedFile)
  const packageRoot = (() => {
    let current = resolve(root, siblingDir)
    while (current.startsWith(root)) {
      if (existsSync(resolve(current, 'package.json'))) return current
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
    return root
  })()
  const packageRelative = relative(root, packageRoot).replace(/\\/g, '/')
  for (const suffix of ['test', 'spec']) {
    const names = [
      `${stem}.${suffix}${extension}`,
      `${stem}.${suffix}.ts`,
      `${stem}.${suffix}.tsx`,
      `${stem}.${suffix}.js`,
      `${stem}.${suffix}.jsx`,
    ]
    for (const name of names) {
      for (const dir of [
        siblingDir,
        `${siblingDir}/__tests__`,
        `${siblingDir}/test`,
        `${siblingDir}/tests`,
        'test',
        'tests',
        '__tests__',
      ]) {
        const candidate = `${dir}/${name}`.replace(/^\.\//, '').replace(/\/+/g, '/')
        if (existsSync(resolve(root, candidate))) candidates.add(candidate)
      }
    }
  }
  // Keep all known test siblings from the containing package without walking unrelated packages.
  try {
    const pattern = new Glob(`**/${stem}.{test,spec}.{ts,tsx,js,jsx}`)
    for (const file of pattern.scanSync({ cwd: packageRoot, onlyFiles: true })) {
      if (GRAPH_IGNORE_RE.test(file)) continue
      const full = packageRelative ? `${packageRelative}/${file}` : file
      if (candidates.size < 30) candidates.add(full.replace(/\\/g, '/'))
    }
  } catch {}
  return [...candidates].sort().slice(0, 30)
}

function dispositionItem(
  kind: ReviewItem['kind'],
  path: string,
  sourcePath: string | undefined,
  provenance: ReviewItem['provenance'],
  detail?: string,
): ReviewItem {
  return {
    id: itemId(kind, path, sourcePath),
    kind,
    path,
    ...(sourcePath ? { sourcePath } : {}),
    ...(provenance ? { provenance } : {}),
    ...(detail ? { detail } : {}),
    disposition: 'pending',
    evidenceRefs: [],
  }
}

async function collectSourceCount(root: string): Promise<number> {
  const files = new Set<string>()
  for (const pattern of SOURCE_GLOBS) {
    const glob = new Glob(pattern)
    for await (const file of glob.scan({ cwd: root, onlyFiles: true })) {
      if (!GRAPH_IGNORE_RE.test(file)) files.add(file.replace(/\\/g, '/'))
    }
  }
  return files.size
}

export interface BuildReviewManifestOptions {
  cwd: string
  sessionID: string
  baseRef?: string
  headRef?: string
  now?: number
}

export async function buildReviewCoverageManifest(
  options: BuildReviewManifestOptions,
): Promise<ReviewCoverageManifest> {
  const root = repositoryRoot(resolve(options.cwd))
  const baseRef = options.baseRef ?? defaultBaseRef(root)
  const headRef = options.headRef ?? 'WORKTREE'
  const baseSha = resolveCommit(root, baseRef)
  const headSha =
    headRef === 'WORKTREE' ? resolveCommit(root, 'HEAD') : resolveCommit(root, headRef)
  const comparison = headRef === 'WORKTREE' ? baseSha : `${baseSha}...${headSha}`
  const changed = gitOutput(root, [
    'diff',
    '--name-status',
    '-z',
    '--no-ext-diff',
    '--no-renames',
    comparison,
    '--',
  ])
  const changedEntries = parseNameStatus(changed)
  let files = changedEntries
  if (headRef === 'WORKTREE') {
    const untrackedText = gitOutput(root, ['ls-files', '--others', '--exclude-standard', '-z'])
    const untracked = untrackedText
      .split('\0')
      .filter(Boolean)
      .map((path) => ({ path: normalizeRepoPath(path), status: 'A' }))
    const byPath = new Map(files.map((entry) => [entry.path, entry]))
    for (const entry of untracked) if (!byPath.has(entry.path)) byPath.set(entry.path, entry)
    files = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path))
  }
  const diffTruncated = files.length > MAX_CHANGED_FILES
  files = files.slice(0, MAX_CHANGED_FILES)
  const changedPaths = files.map((file) => file.path)

  const items: ReviewItem[] = []
  for (const file of files)
    items.push(
      dispositionItem('changed_file', file.path, undefined, 'diff', `Git status ${file.status}`),
    )
  // This graph is intentionally a partial AST index; never imply complete impact coverage.
  let graphComplete = false
  let graphTruncated = false
  let indexedFiles = 0
  let discoveredSourceFiles = 0
  const caveats = [...GRAPH_CAVEATS]
  const itemKeys = new Set(items.map((item) => item.id))
  const addItem = (item: ReviewItem) => {
    if (items.length >= MAX_ITEMS) {
      graphTruncated = true
      return
    }
    if (itemKeys.has(item.id)) return
    itemKeys.add(item.id)
    items.push(item)
  }

  let graphDb: ReturnType<typeof createDatabase> | undefined
  try {
    discoveredSourceFiles = await collectSourceCount(root)
    graphDb = createDatabase(':memory:')
    const graph = new CodeGraph({ db: graphDb, rootDir: root })
    const built = await graph.buildGraph(root)
    indexedFiles = built.files
    if (indexedFiles < discoveredSourceFiles) {
      graphComplete = false
      caveats.push(
        `AST graph indexed ${indexedFiles} of ${discoveredSourceFiles} discoverable source files; some files were unreadable or skipped.`,
      )
    }
    for (const path of changedPaths) {
      const dependents = graph.findDependents(path, MAX_DEPENDENTS_PER_FILE + 1)
      if (dependents.length > MAX_DEPENDENTS_PER_FILE) {
        graphComplete = false
        graphTruncated = true
        caveats.push(
          `Direct dependent candidates for ${path} exceeded ${MAX_DEPENDENTS_PER_FILE}; the list is truncated.`,
        )
      }
      for (const dependent of dependents.slice(0, MAX_DEPENDENTS_PER_FILE)) {
        addItem(
          dispositionItem(
            'dependent',
            dependent,
            path,
            'reverse_import',
            'Direct reverse-import edge in the partial AST graph.',
          ),
        )
      }
      const dependencies = graph.findDependencies(path, MAX_DEPENDENCIES_PER_FILE + 1)
      if (dependencies.length > MAX_DEPENDENCIES_PER_FILE) {
        graphComplete = false
        graphTruncated = true
        caveats.push(
          `Direct dependency candidates for ${path} exceeded ${MAX_DEPENDENCIES_PER_FILE}; the list is truncated.`,
        )
      }
      for (const dependency of dependencies.slice(0, MAX_DEPENDENCIES_PER_FILE)) {
        addItem(
          dispositionItem(
            'dependent',
            dependency,
            path,
            'import',
            'Direct dependency imported by the changed file.',
          ),
        )
      }
      const declarations = graph.findDeclarationsInFile(path, MAX_SYMBOLS_PER_FILE + 1)
      if (declarations.length > MAX_SYMBOLS_PER_FILE) {
        graphComplete = false
        graphTruncated = true
        caveats.push(
          `Declarations in ${path} exceeded ${MAX_SYMBOLS_PER_FILE}; symbol-call candidates may be truncated.`,
        )
      }
      for (const symbol of declarations
        .filter((item) => item.isExported)
        .slice(0, MAX_SYMBOLS_PER_FILE)) {
        const callers = graph.findCallers(symbol.name, MAX_CALLERS_PER_SYMBOL + 1)
        if (callers.length > MAX_CALLERS_PER_SYMBOL) {
          graphComplete = false
          graphTruncated = true
          caveats.push(
            `Call sites for exported symbol ${symbol.name} in ${path} exceeded ${MAX_CALLERS_PER_SYMBOL}; candidates are truncated.`,
          )
        }
        for (const caller of callers.slice(0, MAX_CALLERS_PER_SYMBOL)) {
          const colon = caller.lastIndexOf(':')
          const callerPath = colon >= 0 ? caller.slice(0, colon) : caller
          const callerLine = colon >= 0 ? caller.slice(colon + 1) : ''
          if (callerPath === path) continue
          addItem(
            dispositionItem(
              'dependent',
              callerPath,
              path,
              'symbol_call_candidate',
              `Possible call to ${symbol.name}${callerLine ? ` at line ${callerLine}` : ''}; confirm symbol identity and relevance.`,
            ),
          )
        }
      }
    }
  } catch (error) {
    graphComplete = false
    caveats.push(`AST dependency graph could not be built: ${String(error).slice(0, 300)}`)
  } finally {
    try {
      graphDb?.sqlite.close()
    } catch {}
  }
  if (diffTruncated) {
    graphComplete = false
    caveats.push(
      `Git diff exceeded ${MAX_CHANGED_FILES} changed files; only the first ${MAX_CHANGED_FILES} are listed.`,
    )
  }
  if (graphTruncated) graphComplete = false

  const testPaths = new Set<string>()
  for (const changedPath of changedPaths) {
    for (const testPath of expectedTestCandidates(root, changedPath)) testPaths.add(testPath)
  }
  const allEvidencePaths = [
    ...new Set([
      ...changedPaths,
      ...items.filter((item) => item.kind === 'dependent').map((item) => item.path),
    ]),
  ]
  const sections = REVIEW_SECTION_IDS.map((id) => ({
    id,
    candidatePaths: sectionCandidatePaths(id, changedPaths, items, caveats).slice(0, 200),
    disposition: 'pending' as const,
    evidenceRefs: [],
  }))
  const testsSection = sections.find((section) => section.id === 'expected_tests')!
  testsSection.candidatePaths = [...testPaths].sort().slice(0, 200)
  const changedSection = sections.find((section) => section.id === 'changed_files')!
  changedSection.candidatePaths = changedPaths
  const dependentsSection = sections.find((section) => section.id === 'callers_dependents')!
  dependentsSection.candidatePaths = [
    ...new Set(items.filter((item) => item.kind === 'dependent').map((item) => item.path)),
  ]
    .sort()
    .slice(0, 200)
  // Avoid a manifest implying that empty heuristics establish absence. Every domain remains pending.
  const now = options.now ?? Date.now()
  const manifest: ReviewCoverageManifest = {
    version: 1,
    id: randomUUID(),
    sessionID: options.sessionID,
    baseRef,
    baseSha,
    headRef,
    headSha,
    generatedAt: now,
    updatedAt: now,
    state: changedPaths.length ? 'in_progress' : 'blocked',
    diff: { changedFiles: files, truncated: diffTruncated },
    graph: {
      complete: graphComplete,
      indexedFiles,
      discoveredSourceFiles,
      truncated: graphTruncated,
      caveats: [...new Set(caveats)],
    },
    requiredSectionIds: [...REVIEW_SECTION_IDS],
    sections,
    requiredItemIds: [...items.map((item) => item.id)],
    items,
    requiredFindingIds: [],
    findings: [],
    blockers: changedPaths.length
      ? []
      : ['The selected base/head range contains no changed or untracked files.'],
  }
  // Use this read to keep the graph scope explicit: all candidate paths stay repository-relative.
  if (allEvidencePaths.some((path) => path.startsWith('../') || isAbsolute(path))) {
    manifest.graph.complete = false
    manifest.graph.caveats.push(
      'The dependency graph returned an out-of-root path; inspect manually before finalizing.',
    )
  }
  return ReviewCoverageManifestSchema.parse(manifest)
}

export function applyItemDisposition(
  manifest: ReviewCoverageManifest,
  itemId: string,
  disposition: Exclude<ReviewDisposition, 'pending'>,
  options: { evidenceRefs?: string[]; reason?: string; testCommand?: string },
): ReviewCoverageManifest {
  const item = manifest.items.find((candidate) => candidate.id === itemId)
  if (!item) throw new Error(`Coverage item not found: ${itemId}`)
  const evidenceRefs = [
    ...new Set((options.evidenceRefs ?? []).map((ref) => ref.trim()).filter(Boolean)),
  ]
  if (disposition === 'not_applicable' && (options.reason?.trim().length ?? 0) < 10) {
    throw new Error('not_applicable requires a concrete reason of at least 10 characters')
  }
  if (disposition === 'unresolved' && (options.reason?.trim().length ?? 0) < 10) {
    throw new Error('unresolved requires a reason of at least 10 characters')
  }
  if (disposition === 'inspected' && evidenceRefs.length === 0) {
    throw new Error(
      'inspected requires at least one evidence reference (path:line, symbol, or search)',
    )
  }
  if (disposition === 'tested' && (evidenceRefs.length === 0 || !options.testCommand?.trim())) {
    throw new Error('tested requires evidence references and a test command')
  }
  const updated: ReviewCoverageManifest = {
    ...manifest,
    state: 'in_progress',
    updatedAt: Date.now(),
    blockers: [],
    items: manifest.items.map((candidate) =>
      candidate.id === itemId
        ? {
            ...candidate,
            disposition,
            evidenceRefs,
            ...(options.reason?.trim() ? { reason: options.reason.trim() } : {}),
            ...(options.testCommand?.trim() ? { testCommand: options.testCommand.trim() } : {}),
          }
        : candidate,
    ),
  }
  return ReviewCoverageManifestSchema.parse(updated)
}

export function applySectionDisposition(
  manifest: ReviewCoverageManifest,
  sectionId: ReviewSectionId,
  disposition: Exclude<ReviewDisposition, 'pending'>,
  options: { evidenceRefs?: string[]; reason?: string; testCommand?: string },
): ReviewCoverageManifest {
  const section = manifest.sections.find((candidate) => candidate.id === sectionId)
  if (!section) throw new Error(`Required coverage section missing: ${sectionId}`)
  if (
    sectionId === 'analysis_limitations' &&
    !manifest.graph.complete &&
    disposition === 'not_applicable'
  ) {
    throw new Error(
      'Incomplete graph coverage requires inspected/tested evidence showing how the review was widened; it cannot be waived as not applicable.',
    )
  }
  const evidenceRefs = [
    ...new Set((options.evidenceRefs ?? []).map((ref) => ref.trim()).filter(Boolean)),
  ]
  if (disposition === 'not_applicable' && (options.reason?.trim().length ?? 0) < 10) {
    throw new Error('not_applicable requires a concrete reason of at least 10 characters')
  }
  if (disposition === 'unresolved' && (options.reason?.trim().length ?? 0) < 10) {
    throw new Error('unresolved requires a reason of at least 10 characters')
  }
  if (disposition === 'inspected' && evidenceRefs.length === 0) {
    throw new Error('inspected requires at least one evidence reference')
  }
  if (disposition === 'tested' && (evidenceRefs.length === 0 || !options.testCommand?.trim())) {
    throw new Error('tested requires evidence references and a test command')
  }
  return ReviewCoverageManifestSchema.parse({
    ...manifest,
    state: 'in_progress',
    updatedAt: Date.now(),
    blockers: [],
    sections: manifest.sections.map((candidate) =>
      candidate.id === sectionId
        ? {
            ...candidate,
            disposition,
            evidenceRefs,
            ...(options.reason?.trim() ? { reason: options.reason.trim() } : {}),
            ...(options.testCommand?.trim() ? { testCommand: options.testCommand.trim() } : {}),
          }
        : candidate,
    ),
  })
}

export interface AddReviewFindingInput {
  id?: string
  sourceFindingId?: string
  title: string
  severity: ReviewFinding['severity']
  disposition: ReviewFinding['disposition']
  changedFiles?: string[]
  testRefs?: string[]
  testCommand?: string
  testOutcome?: ReviewFinding['testOutcome']
  testNotFeasibleReason?: string
  rationale?: string
  duplicateOf?: string
}

export function addReviewFinding(
  manifest: ReviewCoverageManifest,
  input: AddReviewFindingInput,
): ReviewCoverageManifest {
  const id = input.id ?? randomUUID()
  if (manifest.findings.some((finding) => finding.id === id))
    throw new Error(`Review finding already recorded: ${id}`)
  const changedFiles = [...new Set(input.changedFiles ?? [])]
  const testRefs = [...new Set((input.testRefs ?? []).map((ref) => ref.trim()).filter(Boolean))]
  const rationale = input.rationale?.trim()
  if (input.disposition === 'fixed') {
    if (
      !changedFiles.length ||
      changedFiles.some((path) => !manifest.diff.changedFiles.some((file) => file.path === path))
    ) {
      throw new Error('fixed finding must map to at least one file in the reviewed diff')
    }
    if (input.testOutcome === 'passed') {
      if (!input.testCommand?.trim() || !testRefs.length)
        throw new Error('fixed finding with passed tests requires testCommand and testRefs')
    } else if (input.testOutcome === 'not_feasible') {
      if ((input.testNotFeasibleReason?.trim().length ?? 0) < 10)
        throw new Error('not_feasible requires a documented reason of at least 10 characters')
    } else {
      throw new Error(
        'fixed finding must record a passing regression test or explain why a test is not feasible',
      )
    }
  } else if (input.disposition === 'duplicate') {
    if (
      !input.duplicateOf ||
      !manifest.findings.some((finding) => finding.id === input.duplicateOf)
    ) {
      throw new Error('duplicate finding must reference an already recorded finding')
    }
    if ((rationale?.length ?? 0) < 10)
      throw new Error('duplicate finding requires a concrete rationale')
  } else if (input.disposition === 'unresolved') {
    if ((rationale?.length ?? 0) < 10)
      throw new Error('unresolved finding requires a reason of at least 10 characters')
  } else if ((rationale?.length ?? 0) < 10) {
    throw new Error(
      `${input.disposition} finding requires a documented rationale of at least 10 characters`,
    )
  }
  const finding = ReviewFindingSchema.parse({
    id,
    sourceFindingId: input.sourceFindingId,
    title: input.title.trim(),
    severity: input.severity,
    disposition: input.disposition,
    changedFiles,
    testRefs,
    testCommand: input.testCommand?.trim(),
    testOutcome: input.testOutcome,
    testNotFeasibleReason: input.testNotFeasibleReason?.trim(),
    rationale,
    duplicateOf: input.duplicateOf,
  })
  return ReviewCoverageManifestSchema.parse({
    ...manifest,
    state: 'in_progress',
    updatedAt: Date.now(),
    blockers: [],
    requiredFindingIds: [...manifest.requiredFindingIds, id],
    findings: [...manifest.findings, finding],
  })
}

export function reviewCoverageBlockers(manifest: ReviewCoverageManifest): string[] {
  const blockers: string[] = []
  const requiredSections = new Set(manifest.requiredSectionIds)
  for (const id of REVIEW_SECTION_IDS) {
    if (!requiredSections.has(id)) blockers.push(`Required section ${id} is not declared.`)
    if (!manifest.sections.some((section) => section.id === id))
      blockers.push(`Required section ${id} is missing.`)
  }
  for (const section of manifest.sections) {
    if (!requiredSections.has(section.id))
      blockers.push(`Unexpected section ${section.id} is not in the required checklist.`)
    if (section.disposition === 'pending' || section.disposition === 'unresolved')
      blockers.push(`Section ${section.id} is ${section.disposition}.`)
    if (section.disposition === 'not_applicable' && (section.reason?.trim().length ?? 0) < 10)
      blockers.push(`Section ${section.id} needs a not-applicable reason.`)
    if (['inspected', 'tested'].includes(section.disposition) && section.evidenceRefs.length === 0)
      blockers.push(`Section ${section.id} needs evidence references.`)
    if (section.disposition === 'tested' && !section.testCommand?.trim())
      blockers.push(`Section ${section.id} needs a test command.`)
  }
  const listedItems = new Set(manifest.items.map((item) => item.id))
  for (const id of manifest.requiredItemIds)
    if (!listedItems.has(id)) blockers.push(`Required coverage item ${id} is missing.`)
  for (const item of manifest.items) {
    if (item.disposition === 'pending' || item.disposition === 'unresolved')
      blockers.push(`Item ${item.id} (${item.path}) is ${item.disposition}.`)
    if (item.disposition === 'not_applicable' && (item.reason?.trim().length ?? 0) < 10)
      blockers.push(`Item ${item.id} needs a not-applicable reason.`)
    if (item.disposition === 'inspected' && item.evidenceRefs.length === 0)
      blockers.push(`Item ${item.id} needs evidence references.`)
    if (
      item.disposition === 'tested' &&
      (!item.testCommand?.trim() || item.evidenceRefs.length === 0)
    )
      blockers.push(`Item ${item.id} needs test command and evidence references.`)
  }
  const listedFindings = new Set(manifest.findings.map((finding) => finding.id))
  for (const id of manifest.requiredFindingIds)
    if (!listedFindings.has(id)) blockers.push(`Required finding disposition ${id} is missing.`)
  for (const finding of manifest.findings) {
    if (finding.disposition === 'unresolved')
      blockers.push(`Finding ${finding.id} remains unresolved.`)
    if (finding.disposition === 'fixed') {
      if (
        !finding.changedFiles.length ||
        finding.changedFiles.some(
          (path) => !manifest.diff.changedFiles.some((file) => file.path === path),
        )
      )
        blockers.push(`Fixed finding ${finding.id} does not map to a changed file.`)
      const hasTestEvidence =
        finding.testOutcome === 'passed' &&
        !!finding.testCommand?.trim() &&
        finding.testRefs.length > 0
      const hasTestException =
        finding.testOutcome === 'not_feasible' &&
        (finding.testNotFeasibleReason?.trim().length ?? 0) >= 10
      if (!hasTestEvidence && !hasTestException)
        blockers.push(
          `Fixed finding ${finding.id} needs regression-test evidence or a documented feasibility exception.`,
        )
    }
    if (
      finding.disposition === 'duplicate' &&
      (!finding.duplicateOf || !listedFindings.has(finding.duplicateOf))
    )
      blockers.push(`Duplicate finding ${finding.id} needs a valid duplicateOf reference.`)
    if (
      finding.disposition !== 'fixed' &&
      finding.disposition !== 'unresolved' &&
      (finding.rationale?.trim().length ?? 0) < 10
    )
      blockers.push(`Finding ${finding.id} needs a documented disposition rationale.`)
  }
  if (!manifest.diff.changedFiles.length)
    blockers.push('Cannot complete a review manifest with an empty diff.')
  return [...new Set(blockers)]
}

export function finalizeReviewCoverage(manifest: ReviewCoverageManifest): ReviewCoverageManifest {
  const blockers = reviewCoverageBlockers(manifest)
  const state = blockers.length
    ? blockers.some((item) => /unresolved|missing|empty diff|pending/i.test(item))
      ? 'blocked'
      : 'in_progress'
    : 'complete'
  return ReviewCoverageManifestSchema.parse({
    ...manifest,
    state,
    updatedAt: Date.now(),
    blockers,
  })
}

export function validateReviewCoverage(value: unknown): ReviewCoverageManifest {
  return ReviewCoverageManifestSchema.parse(value)
}

export function resolveReviewPath(root: string, filePath: string): string {
  const normalized = normalizeRepoPath(filePath)
  const absolute = resolve(root, normalized)
  const rel = relative(root, absolute)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error('Review path escapes repository root')
  return absolute
}

export function getReviewDiff(
  root: string,
  manifest: ReviewCoverageManifest,
  filePath: string,
): { diff: string; truncated: boolean } {
  const path = normalizeRepoPath(filePath)
  if (!manifest.diff.changedFiles.some((file) => file.path === path))
    throw new Error('Path is not part of this review manifest')
  const absolute = resolveReviewPath(root, path)
  let result: GitResult
  if (manifest.headRef === 'WORKTREE' && !existsSync(absolute)) {
    throw new Error(
      'The changed file is deleted or unavailable in the worktree; inspect its recorded diff from Git history.',
    )
  }
  if (
    manifest.headRef === 'WORKTREE' &&
    manifest.diff.changedFiles.find((file) => file.path === path)?.status === 'A' &&
    runGit(root, ['ls-files', '--error-unmatch', '--', path]).status !== 0
  ) {
    result = runGit(root, [
      'diff',
      '--no-index',
      '--no-ext-diff',
      '--no-color',
      '--unified=5',
      '--',
      '/dev/null',
      absolute,
    ])
    if (result.status !== 1)
      throw new Error(`Could not read untracked-file diff: ${String(result.error ?? '')}`)
  } else {
    const comparison =
      manifest.headRef === 'WORKTREE'
        ? manifest.baseSha
        : `${manifest.baseSha}...${manifest.headSha}`
    result = runGit(root, [
      'diff',
      '--no-ext-diff',
      '--no-color',
      '--unified=5',
      comparison,
      '--',
      path,
    ])
    if (result.error || result.status !== 0) throw new Error(`Could not read Git diff for ${path}`)
  }
  const diff = result.stdout
  return { diff: diff.slice(0, MAX_DIFF_CHARS), truncated: diff.length > MAX_DIFF_CHARS }
}
