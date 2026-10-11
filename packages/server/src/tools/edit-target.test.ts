import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDatabase, migrate } from '../storage/db.js'
import { ToolRegistry } from './registry.js'
import { PermissionManager } from '../permission/index.js'
import { Bus } from '../bus/index.js'
import { analyzeEditTarget, strictEditTarget } from './edit-target.js'
import type { Gateway } from '../gateway/index.js'

// Wrong-file detection: advisory by default, blocking only on the
// high-confidence signal in strict mode.

const stubGateway = {
  stream: () => Promise.resolve((async function* () {})()),
  complete: async () => ({ text: '' }),
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
} as unknown as Gateway

let dir: string
let db: ReturnType<typeof createDatabase>

const write = (rel: string, content = 'x\n') => {
  const p = join(dir, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content, 'utf-8')
  return p
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mira-target-'))
  db = createDatabase(':memory:')
  await migrate(db)
  delete process.env.MIRA_STRICT_EDIT_TARGET
})

afterEach(() => {
  delete process.env.MIRA_STRICT_EDIT_TARGET
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
})

describe('analyzeEditTarget', () => {
  test('flags a same-basename file already read this session', () => {
    // packages/server/src/foo.ts vs packages/web/src/foo.ts — the classic
    // "edited the sibling package's copy" mistake.
    const intended = write('packages/server/src/foo.ts')
    const wrong = write('packages/web/src/foo.ts')
    const res = analyzeEditTarget({
      target: wrong,
      cwd: dir,
      sessionReads: new Set([intended]),
    })
    expect(res.warnings.length).toBeGreaterThan(0)
    expect(res.nearMiss?.kind).toBe('same-basename-read')
    expect(res.nearMiss?.path).toBe(intended)
  })

  test('stays silent when the session read several same-named files', () => {
    // index.ts is everywhere; an agent legitimately works across sibling modules.
    const a = write('src/auth/index.ts')
    const b = write('src/cache/index.ts')
    const target = write('src/db/index.ts')
    const res = analyzeEditTarget({
      target,
      cwd: dir,
      sessionReads: new Set([a, b]),
    })
    expect(res.warnings).toEqual([])
    expect(res.nearMiss).toBeUndefined()
  })

  test('silent when the target is the file the session was working on', () => {
    const p = write('src/foo.ts')
    const res = analyzeEditTarget({ target: p, cwd: dir, sessionReads: new Set([p]) })
    expect(res.warnings).toEqual([])
    expect(res.nearMiss).toBeUndefined()
  })

  test('flags creating a file that duplicates an existing one', () => {
    const existing = write('packages/server/src/foo.ts')
    const other = join(dir, 'packages/web/src/foo.ts')
    mkdirSync(dirname(other), { recursive: true })
    const res = analyzeEditTarget({ target: other, cwd: dir, sessionReads: new Set() })
    expect(res.warnings.length).toBeGreaterThan(0)
    expect(res.nearMiss?.kind).toBe('existing-twin')
    expect(res.nearMiss?.path).toBe(existing)
  })

  test('advisory signal for a target outside the session focus', () => {
    const focus = write('src/a.ts')
    const outside = write('other/b.ts')
    const res = analyzeEditTarget({ target: outside, cwd: dir, sessionReads: new Set([focus]) })
    expect(res.warnings.length).toBe(1)
    // weak signal only — never blocking
    expect(res.nearMiss).toBeUndefined()
  })

  test('no signals for the first file in a session', () => {
    const p = write('src/first.ts')
    const res = analyzeEditTarget({ target: p, cwd: dir, sessionReads: new Set() })
    expect(res.warnings).toEqual([])
  })

  test('ignores node_modules when scanning for twins', () => {
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'pkg', 'dup.ts'), 'vendored', 'utf-8')
    const target = join(dir, 'src', 'dup.ts')
    mkdirSync(dirname(target), { recursive: true })
    const res = analyzeEditTarget({ target, cwd: dir, sessionReads: new Set() })
    expect(res.warnings).toEqual([])
  })
})

describe('strictEditTarget', () => {
  test('off by default, on with MIRA_STRICT_EDIT_TARGET=1', () => {
    expect(strictEditTarget()).toBe(false)
    process.env.MIRA_STRICT_EDIT_TARGET = '1'
    expect(strictEditTarget()).toBe(true)
  })
})

describe('registry integration', () => {
  const makeRegistry = async () => {
    const r = new ToolRegistry({
      db,
      bus: new Bus(),
      permissions: new PermissionManager({}),
      gateway: stubGateway,
    })
    await r.registerAll()
    return r
  }
  const seedSession = (id: string) =>
    db.sqlite
      .prepare(
        'INSERT OR IGNORE INTO sessions (id, title, model, provider, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      )
      .run(id, id, 'm', 'p', Date.now(), Date.now())
  const ctx = (sessionID: string) => ({ sessionID, messageID: 'm1', cwd: dir, db }) as never

  test('a wrong-file edit succeeds but returns a warning the agent can act on', async () => {
    seedSession('s-warn')
    const intended = write('packages/server/src/foo.ts', 'original\n')
    write('packages/web/src/foo.ts', 'original\n')
    const reg = await makeRegistry()

    await reg.execute('read', { path: 'packages/server/src/foo.ts' }, ctx('s-warn'))
    // read-guard requires a read of the wrong file too; read it so we isolate
    // the relevance signal from the read guard
    await reg.execute('read', { path: 'packages/web/src/foo.ts' }, ctx('s-warn'))
    const res = (await reg.execute(
      'edit',
      { path: 'packages/web/src/foo.ts', oldString: 'original', newString: 'changed' },
      ctx('s-warn'),
    )) as { editTargetWarnings?: string[] }

    expect(res.editTargetWarnings?.length).toBeGreaterThan(0)
    expect(readFileSync(intended, 'utf-8')).toBe('original\n')
  })

  test('strict mode blocks the high-confidence wrong-file edit', async () => {
    seedSession('s-strict')
    write('packages/server/src/foo.ts', 'original\n')
    write('packages/web/src/foo.ts', 'original\n')
    process.env.MIRA_STRICT_EDIT_TARGET = '1'
    const reg = await makeRegistry()

    await reg.execute('read', { path: 'packages/server/src/foo.ts' }, ctx('s-strict'))
    await reg.execute('read', { path: 'packages/web/src/foo.ts' }, ctx('s-strict'))

    let err: Error | null = null
    try {
      await reg.execute(
        'edit',
        { path: 'packages/web/src/foo.ts', oldString: 'original', newString: 'changed' },
        ctx('s-strict'),
      )
    } catch (e) {
      err = e as Error
    }
    expect(err).toBeTruthy()
    expect(err!.message).toContain('Edit-target guard')
    // nothing written
    expect(readFileSync(join(dir, 'packages/web/src/foo.ts'), 'utf-8')).toBe('original\n')
  })

  test('no warnings on a normal single-file edit', async () => {
    seedSession('s-normal')
    const p = write('src/app.ts', 'alpha\n')
    const reg = await makeRegistry()
    await reg.execute('read', { path: 'src/app.ts' }, ctx('s-normal'))
    const res = (await reg.execute(
      'edit',
      { path: 'src/app.ts', oldString: 'alpha', newString: 'beta' },
      ctx('s-normal'),
    )) as { editTargetWarnings?: string[] }
    expect(res.editTargetWarnings).toBeUndefined()
    expect(readFileSync(p, 'utf-8')).toBe('beta\n')
  })
})
