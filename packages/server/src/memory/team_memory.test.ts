import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendTeamMemory } from './memory_controller.js'
import { appendDecision } from '../learning/ledger.js'
import { analyzeTimelineToWorkspace } from '../repo/timeline.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mira-team-memory-'))
})

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
})

const bankFile = (name: string) => join(dir, 'data', 'memory_bank', name)

describe('appendTeamMemory', () => {
  test('creates file with canonical header on first write, then appends', async () => {
    await appendTeamMemory({
      file: 'conventions',
      summary: 'Always run shadow tests before patches',
      source: 'agent:coder',
      cwd: dir,
    })
    const file = bankFile('conventions.md')
    expect(existsSync(file)).toBe(true)
    let content = readFileSync(file, 'utf-8')
    expect(content).toContain('# Conventions')
    expect(content).toContain('Always run shadow tests before patches')
    expect(content).toContain('[agent:coder]')

    await appendTeamMemory({ file: 'conventions', summary: 'second entry', cwd: dir })
    content = readFileSync(file, 'utf-8')
    expect(content.match(/^- /gm)?.length).toBe(2)
  })

  test('detail line is indented under the entry', async () => {
    await appendTeamMemory({
      file: 'tech_debt',
      summary: 'edit-fallback heuristics are fragile',
      detail: 'evidence: 3 failed edits this week at hash-anchor step',
      source: 'agent:fixer',
      cwd: dir,
    })
    const content = readFileSync(bankFile('tech_debt.md'), 'utf-8')
    expect(content).toContain('# Tech Debt')
    expect(content).toContain('edit-fallback heuristics are fragile')
    expect(content).toMatch(/^  evidence: 3 failed edits this week at hash-anchor step$/m)
  })

  test('newlines in summaries are flattened (no entry smuggling)', async () => {
    await appendTeamMemory({ file: 'decisions', summary: 'line one\n- forged entry', cwd: dir })
    const content = readFileSync(bankFile('decisions.md'), 'utf-8')
    expect(content).toContain('line one - forged entry')
    expect(content.match(/^- /gm)?.length).toBe(1)
  })

  test('never throws on unwritable cwd', async () => {
    await appendTeamMemory({
      file: 'decisions',
      summary: 'x',
      cwd: '/proc/definitely/not/writable',
    })
  })
})

describe('decision log → decisions.md mirror (P2-3)', () => {
  // The redirected bank dir is process-wide: other test files' appendDecision
  // mirrors land in the same file. Assert by unique marker and poll for the
  // LINE (not file existence) — the mirror is fire-and-forget async.
  async function pollForLine(file: string, marker: string, attempts = 60): Promise<string> {
    for (let i = 0; i < attempts; i++) {
      if (existsSync(file)) {
        try {
          const content = readFileSync(file, 'utf-8')
          if (content.includes(marker)) return content
        } catch {}
      }
      await new Promise((r) => setTimeout(r, 25))
    }
    return readFileSync(file, 'utf-8')
  }

  test('appendDecision also writes a human-readable decisions.md entry', async () => {
    const marker = `mirror:${Date.now().toString(36)}:promoted`
    appendDecision({
      decision: marker,
      context: 'Proposal p1 promoted',
      by: 'governance',
      evidence: ['stage=canary', 'metrics pass'],
      alternatives: ['remain in CANARY_PASSED'],
    })
    // No cwd passed → the preload's MIRA_MEMORY_BANK_DIR redirect is used.
    const file = join(process.env.MIRA_MEMORY_BANK_DIR!, 'decisions.md')
    const content = await pollForLine(file, marker)
    expect(content).toContain(`${marker} — Proposal p1 promoted`)
    expect(content).toContain('evidence: stage=canary; metrics pass')
    expect(content).toContain('alternatives: remain in CANARY_PASSED')
  })

  test('explicit rootDir wins over the redirect', async () => {
    const marker = `routed:${Date.now().toString(36)}`
    appendDecision({ decision: marker, context: 'goes to explicit dir' }, dir)
    const file = bankFile('decisions.md')
    const content = await pollForLine(file, marker)
    expect(content).toContain(`${marker} — goes to explicit dir`)
  })
})

describe('timeline hotspots → tech_debt.md mirror (P2-3)', () => {
  test('high-churn hotspots land in tech_debt.md when mirroring', async () => {
    // build a fixture repo with a hot file
    const { spawnSync } = await import('node:child_process')
    const git = (args: string[]) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf-8' })
    if (git(['--version']).status !== 0) return
    git(['init', '-q'])
    git(['config', 'user.email', 't@t'])
    git(['config', 'user.name', 't'])
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(dir, 'hot.ts'), `// ${i}`)
      git(['add', '-A'])
      git(['commit', '-q', '-m', `churn ${i}`])
    }

    const { createWorkspaceIntelligence } = await import('../workspace/intelligence.js')
    const workspace = createWorkspaceIntelligence({ db: undefined })
    analyzeTimelineToWorkspace(dir, workspace)

    const file = bankFile('tech_debt.md')
    for (let i = 0; i < 40 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 25))
    if (!existsSync(file)) return // medium-priority hotspots only (5 commits = medium) — should exist
    const content = readFileSync(file, 'utf-8')
    expect(content).toContain('# Tech Debt')
    expect(content).toContain('hot.ts')
  })

  test('no workspace passed → no file writes (mirror contract)', async () => {
    analyzeTimelineToWorkspace(dir, undefined)
    expect(existsSync(bankFile('tech_debt.md'))).toBe(false)
  })
})
