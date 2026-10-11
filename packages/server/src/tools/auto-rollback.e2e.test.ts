import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDatabase, migrate } from '../storage/db.js'
import { taskTool } from './task.js'
import type { ToolContext } from './registry.js'
import { resetConfigCache, saveConfig } from '../config/index.js'

// P3.6 groundwork — auto-rollback end to end through the real task pipeline:
// a subagent run that edits a file, leaves failing verification evidence, and
// settles as FAILED_VERIFICATION has its edits reverted when the toggle is on.

let dir: string
let projectDir: string
let db: ReturnType<typeof createDatabase>

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mira-ar-e2e-'))
  projectDir = mkdtempSync(join(tmpdir(), 'mira-ar-cfg-'))
  db = createDatabase(':memory:')
  await migrate(db)
  resetConfigCache()
  delete process.env.MIRA_AUTO_ROLLBACK
  db.sqlite
    .prepare(
      'INSERT OR IGNORE INTO sessions (id, title, model, provider, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    )
    .run('parent-sess', 'parent', 'm', 'p', Date.now(), Date.now())
})

afterEach(() => {
  delete process.env.MIRA_AUTO_ROLLBACK
  resetConfigCache()
  try {
    rmSync(dir, { recursive: true, force: true })
    rmSync(projectDir, { recursive: true, force: true })
  } catch {}
})

/**
 * Stub subagent: edits `target`, records a snapshot (as the tool registry
 * would), then records a failing `bash` part so verification settles FAILED.
 */
function failingRunner(target: string) {
  return async () => {
    const childID = 'child-sess'
    db.sqlite
      .prepare(
        'INSERT OR IGNORE INTO sessions (id, title, model, provider, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      )
      .run(childID, 'child', 'm', 'p', Date.now(), Date.now())
    db.sqlite
      .prepare('INSERT OR IGNORE INTO messages (id, session_id, role, created_at) VALUES (?,?,?,?)')
      .run('child-msg', childID, 'assistant', Date.now())
    // snapshot the pre-edit content, then break the file
    db.sqlite
      .prepare(
        'INSERT INTO file_snapshots (id, session_id, message_id, path, content, created_at) VALUES (?,?,?,?,?,?)',
      )
      .run('sn-1', childID, 'child-msg', target, 'ORIGINAL', Date.now())
    writeFileSync(target, 'BROKEN BY SUBAGENT', 'utf-8')
    // Failing verification evidence: a bash tool-result with a classifiable
    // command and a non-zero exit code (computeVerification: ok = exitCode===0).
    db.sqlite
      .prepare(
        'INSERT INTO parts (id, message_id, session_id, type, tool, tool_call_id, result, created_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(
        'pt-1',
        'child-msg',
        childID,
        'tool-result',
        'bash',
        'tc-1',
        JSON.stringify({ command: 'bun test', exitCode: 1, stderr: '1 test failed' }),
        Date.now(),
      )
    return { sessionID: childID, text: 'done (badly)' }
  }
}

const runTask = async (target: string) => {
  const ctx = {
    sessionID: 'parent-sess',
    messageID: 'pm-1',
    cwd: dir,
    db,
    subagentRunner: failingRunner(target) as never,
  } as unknown as ToolContext
  const res = (await taskTool.execute(
    { description: 'break it', prompt: 'edit the file', subagent_type: 'coder' } as never,
    ctx,
  )) as { jobID?: string }
  return { jobID: res.jobID ?? '' }
}

describe('auto-rollback through the task pipeline', () => {
  test('toggle OFF: failed verification leaves the file as the agent left it', async () => {
    const target = join(dir, 'off.ts')
    writeFileSync(target, 'ORIGINAL', 'utf-8')
    await runTask(target)
    expect(readFileSync(target, 'utf-8')).toBe('BROKEN BY SUBAGENT')
  })

  test('toggle ON via env: failed verification restores the file', async () => {
    process.env.MIRA_AUTO_ROLLBACK = '1'
    const target = join(dir, 'on-env.ts')
    writeFileSync(target, 'ORIGINAL', 'utf-8')
    await runTask(target)
    expect(readFileSync(target, 'utf-8')).toBe('ORIGINAL')
  })

  test('toggle ON via config: failed verification restores the file', async () => {
    await saveConfig({ compliance: { autoRollback: true } }, 'project', projectDir)
    const target = join(dir, 'on-cfg.ts')
    writeFileSync(target, 'ORIGINAL', 'utf-8')
    await runTask(target)
    expect(readFileSync(target, 'utf-8')).toBe('ORIGINAL')
  })

  test('the job row still records the failed verification', async () => {
    process.env.MIRA_AUTO_ROLLBACK = '1'
    const target = join(dir, 'recorded.ts')
    writeFileSync(target, 'ORIGINAL', 'utf-8')
    const { jobID } = await runTask(target)
    const row = db.sqlite
      .prepare('SELECT verification_state FROM jobs WHERE id = ?')
      .get(jobID) as { verification_state: string }
    expect(row.verification_state).toBe('FAILED_VERIFICATION')
  })

  test('rollback consumes the snapshot so the change is not undone twice', async () => {
    process.env.MIRA_AUTO_ROLLBACK = '1'
    const target = join(dir, 'once.ts')
    writeFileSync(target, 'ORIGINAL', 'utf-8')
    await runTask(target)
    const left = db.sqlite.prepare('SELECT COUNT(*) AS c FROM file_snapshots').get() as {
      c: number
    }
    expect(left.c).toBe(0)
  })
})
