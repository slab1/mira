import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDatabase, migrate } from '../storage/db.js'
import { reviewEdit, editCriticEnabled } from './edit-critic.js'
import type { Gateway } from '../gateway/types.js'
import { resetConfigCache, saveConfig } from '../config/index.js'

// Edit critic — a second model judges whether a completed edit serves the
// task. Opt-in; verdict 'unrelated' writes a finding and (if autoRollback is
// also on) reverts the edit via its snapshot.

let dir: string
let projectDir: string
let db: ReturnType<typeof createDatabase>
let criticCalls: Array<{ prompt: string }>

const gatewayWith = (text: string): Gateway =>
  ({
    complete: async (opts: { prompt: string }) => {
      criticCalls.push({ prompt: opts.prompt })
      return { text }
    },
    stream: () => Promise.resolve((async function* () {})()),
    summarize: async () => '',
    listModels: async () => [],
    stats: () => ({
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUSD: 0,
      avgLatencyMs: 0,
      byModel: {},
    }),
  }) as unknown as Gateway

const UNRELATED =
  '{"verdict":"unrelated","reason":"task names login.ts but this change touches logout.ts"}'
const OK = '{"verdict":"ok","reason":"change matches the task"}'

const seedSession = (id: string, prompt: string) => {
  const now = Date.now()
  db.sqlite
    .prepare(
      'INSERT OR IGNORE INTO sessions (id,title,model,provider,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    )
    .run(id, id, 'm', 'p', now, now)
  db.sqlite
    .prepare('INSERT INTO messages (id, session_id, role, created_at) VALUES (?,?,?,?)')
    .run(`${id}-msg`, id, 'user', now)
  db.sqlite
    .prepare(
      'INSERT INTO parts (id, message_id, session_id, type, text, created_at) VALUES (?,?,?,?,?,?)',
    )
    .run(`${id}-part`, `${id}-msg`, id, 'text', prompt, now)
}

const snapshot = (sessionID: string, path: string, before: string | null) =>
  db.sqlite
    .prepare(
      'INSERT INTO file_snapshots (id, session_id, message_id, path, content, created_at) VALUES (?,?,?,?,?,?)',
    )
    .run(`sn_${Math.random().toString(36).slice(2)}`, sessionID, null, path, before, Date.now())

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mira-critic-'))
  projectDir = mkdtempSync(join(tmpdir(), 'mira-critic-cfg-'))
  db = createDatabase(':memory:')
  await migrate(db)
  criticCalls = []
  delete process.env.MIRA_EDIT_CRITIC
  delete process.env.MIRA_AUTO_ROLLBACK
  resetConfigCache()
})

afterEach(() => {
  delete process.env.MIRA_EDIT_CRITIC
  delete process.env.MIRA_AUTO_ROLLBACK
  resetConfigCache()
  try {
    rmSync(dir, { recursive: true, force: true })
    rmSync(projectDir, { recursive: true, force: true })
  } catch {}
})

const writeFile = (rel: string, content: string) => {
  const p = join(dir, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content, 'utf-8')
  return p
}

describe('editCriticEnabled — both modes', () => {
  test('defaults OFF (a model call per edit is an operator decision)', () => {
    expect(editCriticEnabled()).toBe(false)
  })
  test('env enables', () => {
    process.env.MIRA_EDIT_CRITIC = '1'
    expect(editCriticEnabled()).toBe(true)
  })
  test('config enables', async () => {
    await saveConfig({ compliance: { editCritic: true } }, 'project', projectDir)
    expect(editCriticEnabled()).toBe(true)
  })
  test('explicit config false wins over enabling env', async () => {
    await saveConfig({ compliance: { editCritic: false } }, 'project', projectDir)
    process.env.MIRA_EDIT_CRITIC = '1'
    expect(editCriticEnabled()).toBe(false)
  })
})

describe('reviewEdit', () => {
  test('skipped when disabled — no model call', async () => {
    seedSession('s1', 'fix login.ts')
    const p = writeFile('login.ts', 'BROKEN')
    snapshot('s1', p, 'ORIGINAL')
    const res = await reviewEdit(db, gatewayWith(UNRELATED), { sessionID: 's1', path: p, cwd: dir })
    expect(res?.verdict).toBe('skipped')
    expect(criticCalls.length).toBe(0)
  })

  test('skipped when there is no task text (cannot judge intent)', async () => {
    process.env.MIRA_EDIT_CRITIC = '1'
    seedSession('s1', '')
    const p = writeFile('login.ts', 'BROKEN')
    snapshot('s1', p, 'ORIGINAL')
    const res = await reviewEdit(db, gatewayWith(UNRELATED), { sessionID: 's1', path: p, cwd: dir })
    expect(res?.verdict).toBe('skipped')
    expect(criticCalls.length).toBe(0)
  })

  test('skipped when the session has no snapshot for the path', async () => {
    process.env.MIRA_EDIT_CRITIC = '1'
    seedSession('s1', 'fix login.ts')
    const p = writeFile('login.ts', 'BROKEN')
    const res = await reviewEdit(db, gatewayWith(UNRELATED), { sessionID: 's1', path: p, cwd: dir })
    expect(res?.verdict).toBe('skipped')
    expect(criticCalls.length).toBe(0)
  })

  test('verdict ok → nothing happens', async () => {
    process.env.MIRA_EDIT_CRITIC = '1'
    seedSession('s1', 'fix login.ts')
    const p = writeFile('login.ts', 'FIXED')
    snapshot('s1', p, 'ORIGINAL')
    const res = await reviewEdit(db, gatewayWith(OK), { sessionID: 's1', path: p, cwd: dir })
    expect(res?.verdict).toBe('ok')
    expect(criticCalls.length).toBe(1)
    expect(readFileSync(p, 'utf-8')).toBe('FIXED')
    const findings = db.sqlite.prepare('SELECT COUNT(*) AS c FROM findings').get() as { c: number }
    expect(findings.c).toBe(0)
  })

  test('verdict unrelated → finding written, file untouched (autoRollback off)', async () => {
    process.env.MIRA_EDIT_CRITIC = '1'
    seedSession('s1', 'fix login.ts')
    const p = writeFile('login.ts', 'BROKEN')
    snapshot('s1', p, 'ORIGINAL')
    const res = await reviewEdit(db, gatewayWith(UNRELATED), { sessionID: 's1', path: p, cwd: dir })
    expect(res?.verdict).toBe('unrelated')
    expect(res?.reverted).toBeFalsy()
    expect(readFileSync(p, 'utf-8')).toBe('BROKEN')
    const finding = db.sqlite
      .prepare('SELECT title, evidence FROM findings ORDER BY created_at DESC LIMIT 1')
      .get() as { title: string; evidence: string }
    expect(finding.title).toContain('login.ts')
    expect(finding.evidence).toContain('logout.ts')
  })

  test('verdict unrelated + autoRollback on → edit reverted via snapshot', async () => {
    process.env.MIRA_EDIT_CRITIC = '1'
    process.env.MIRA_AUTO_ROLLBACK = '1'
    seedSession('s1', 'fix login.ts')
    const p = writeFile('login.ts', 'BROKEN')
    snapshot('s1', p, 'ORIGINAL')
    const res = await reviewEdit(db, gatewayWith(UNRELATED), { sessionID: 's1', path: p, cwd: dir })
    expect(res?.verdict).toBe('unrelated')
    expect(res?.reverted).toBe(true)
    expect(readFileSync(p, 'utf-8')).toBe('ORIGINAL')
  })

  test('task text and both file states reach the critic prompt', async () => {
    process.env.MIRA_EDIT_CRITIC = '1'
    seedSession('s1', 'fix the login expiry bug')
    const p = writeFile('login.ts', 'AFTER-STATE')
    snapshot('s1', p, 'BEFORE-STATE')
    await reviewEdit(db, gatewayWith(OK), { sessionID: 's1', path: p, cwd: dir })
    const prompt = criticCalls[0]?.prompt ?? ''
    expect(prompt).toContain('fix the login expiry bug')
    expect(prompt).toContain('BEFORE-STATE')
    expect(prompt).toContain('AFTER-STATE')
    expect(prompt).toContain('login.ts')
  })

  test('unparseable critic output degrades to error, no crash, no revert', async () => {
    process.env.MIRA_EDIT_CRITIC = '1'
    process.env.MIRA_AUTO_ROLLBACK = '1'
    seedSession('s1', 'fix login.ts')
    const p = writeFile('login.ts', 'BROKEN')
    snapshot('s1', p, 'ORIGINAL')
    const res = await reviewEdit(db, gatewayWith('I think this is fine, honestly.'), {
      sessionID: 's1',
      path: p,
      cwd: dir,
    })
    expect(res?.verdict).toBe('error')
    expect(readFileSync(p, 'utf-8')).toBe('BROKEN')
  })

  test('critic failure (throwing gateway) never propagates', async () => {
    process.env.MIRA_EDIT_CRITIC = '1'
    seedSession('s1', 'fix login.ts')
    const p = writeFile('login.ts', 'BROKEN')
    snapshot('s1', p, 'ORIGINAL')
    const bad = {
      complete: async () => {
        throw new Error('provider down')
      },
    } as unknown as Gateway
    const res = await reviewEdit(db, bad, { sessionID: 's1', path: p, cwd: dir })
    expect(res?.verdict).toBe('error')
  })

  test('one review in flight per session (burst dedupe)', async () => {
    process.env.MIRA_EDIT_CRITIC = '1'
    seedSession('s1', 'fix login.ts')
    const p = writeFile('login.ts', 'BROKEN')
    snapshot('s1', p, 'ORIGINAL')
    const gw = gatewayWith(UNRELATED)
    const [a, b] = await Promise.all([
      reviewEdit(db, gw, { sessionID: 's1', path: p, cwd: dir }),
      reviewEdit(db, gw, { sessionID: 's1', path: p, cwd: dir }),
    ])
    const verdicts = [a?.verdict, b?.verdict]
    expect(verdicts.filter((v) => v === 'unrelated').length).toBe(1)
    expect(verdicts.filter((v) => v === 'skipped').length).toBe(1)
  })
})
