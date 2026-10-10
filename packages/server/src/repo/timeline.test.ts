import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { analyzeTimeline, analyzeTimelineToWorkspace, isGitRepo } from './timeline.js'
import {
  createWorkspaceIntelligence,
  type WorkspaceIntelligence,
} from '../workspace/intelligence.js'
import { createDatabase, migrate, type MiraDB } from '../storage/db.js'

function git(dir: string, args: string[]): void {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf-8' })
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`)
}

let dir: string
let ws: WorkspaceIntelligence
let db: MiraDB
const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0

beforeEach(async () => {
  if (!gitAvailable) return
  dir = mkdtempSync(join(tmpdir(), 'mira-timeline-'))
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'test@mira.local'])
  git(dir, ['config', 'user.name', 'Test'])
  git(dir, ['config', 'commit.gpgsign', 'false'])
  db = createDatabase(':memory:')
  await migrate(db)
  ws = createWorkspaceIntelligence({ db })
})

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
  try {
    db.sqlite.close()
  } catch {}
})

function commit(dir: string, files: Record<string, string>, subject: string): void {
  for (const [p, content] of Object.entries(files)) {
    const abs = join(dir, p)
    mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true })
    writeFileSync(abs, content)
  }
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', subject])
}

describe('repo timeline', () => {
  test('isGitRepo detects real repos and rejects non-repos', () => {
    if (!gitAvailable) return
    expect(isGitRepo(dir)).toBe(true)
    expect(isGitRepo(join(tmpdir(), '..')) === isGitRepo(join(tmpdir(), '..'))).toBe(true)
    const nongit = mkdtempSync(join(tmpdir(), 'mira-nogit-'))
    expect(isGitRepo(nongit)).toBe(false)
    rmSync(nongit, { recursive: true, force: true })
  })

  test('analyzeTimeline extracts commits, churn hotspots, and regression signals', () => {
    if (!gitAvailable) return
    commit(dir, { 'src/a.ts': 'export const a = 1' }, 'add a')
    commit(dir, { 'src/a.ts': 'export const a = 2' }, 'change a again')
    commit(
      dir,
      { 'src/b.ts': 'export const b = 1', 'src/a.ts': 'export const a = 3' },
      'revert broken flag',
    )
    commit(dir, { 'src/c.ts': '// c' }, 'add c')

    const t = analyzeTimeline(dir)
    expect(t.ok).toBe(true)
    expect(t.commits.length).toBe(4)
    const a = t.hotspots.find((h) => h.file === 'src/a.ts')
    expect(a).toBeDefined()
    expect(a!.commits).toBe(3)
    expect(t.regressionSignals.length).toBe(1)
    expect(t.regressionSignals[0]).toContain('revert broken flag')
  })

  test('respects the commit limit', () => {
    if (!gitAvailable) return
    for (let i = 0; i < 10; i++) commit(dir, { 'src/x.ts': `// ${i}` }, `change ${i}`)
    const t = analyzeTimeline(dir, { limit: 4 })
    expect(t.commits.length).toBe(4)
  })

  test('non-repo returns not-ok instead of throwing', () => {
    const nongit = mkdtempSync(join(tmpdir(), 'mira-nogit-'))
    const t = analyzeTimeline(nongit)
    expect(t.ok).toBe(false)
    expect(t.reason).toContain('git')
    rmSync(nongit, { recursive: true, force: true })
  })

  test('hotspots mirror into workspace as tech-debt items', () => {
    if (!gitAvailable) return
    commit(dir, { 'src/a.ts': 'export const a = 1' }, 'a1')
    commit(dir, { 'src/a.ts': 'export const a = 2' }, 'a2')
    const t = analyzeTimelineToWorkspace(dir, ws)
    expect(t.ok).toBe(true)
    const items = ws.query({ kind: 'tech-debt' })
    expect(items.length).toBe(1)
    expect(items[0]!.title).toContain('src/a.ts')
    expect(items[0]!.metadata.churn).toBe(2)
    // idempotent: second run does not duplicate
    analyzeTimelineToWorkspace(dir, ws)
    expect(ws.query({ kind: 'tech-debt' }).length).toBe(1)
  })
})
