import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDatabase, migrate } from '../storage/db.js'
import { ToolRegistry } from './registry.js'
import { PermissionManager } from '../permission/index.js'
import { Bus } from '../bus/index.js'
import type { Gateway } from '../gateway/index.js'

// Open-findings sweep: blast-radius advisories, per-session map eviction, and
// (in companion files) knowledge-delete persistence + audit error column.

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
let bus: Bus

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mira-openfindings-'))
  db = createDatabase(':memory:')
  await migrate(db)
  bus = new Bus()
})

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
})

const registry = async () => {
  const r = new ToolRegistry({
    db,
    bus,
    permissions: new PermissionManager({}),
    gateway: stubGateway,
  })
  await r.registerAll()
  return r
}
const seedSession = (id: string) =>
  db.sqlite
    .prepare(
      'INSERT OR IGNORE INTO sessions (id,title,model,provider,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    )
    .run(id, id, 'm', 'p', Date.now(), Date.now())
const ctx = (sessionID: string) => ({ sessionID, messageID: 'm1', cwd: dir, db }) as never

describe('blast-radius advisory (edit only, graph already built)', () => {
  test('warns when other files import the edited file', async () => {
    // consumer imports the module that will be edited
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'lib.ts'), 'export const one = 1\n')
    writeFileSync(
      join(dir, 'src', 'consumer.ts'),
      'import { one } from "./lib"\nexport const use = one\n',
    )
    seedSession('s1')
    const reg = await registry()
    // build the graph ONCE (as startup does) so the edit path never pays for it
    const { codeGraphFor } = await import('../codegraph/index.js')
    await codeGraphFor(db).buildGraph(dir)
    expect(codeGraphFor(db).stats().files).toBeGreaterThan(0)

    await reg.execute('read', { path: 'src/lib.ts' }, ctx('s1'))
    const res = (await reg.execute(
      'edit',
      { path: 'src/lib.ts', oldString: 'one', newString: 'uno' },
      ctx('s1'),
    )) as { editTargetWarnings?: string[] }

    const blast = (res.editTargetWarnings ?? []).find((w) => w.startsWith('Blast radius'))
    expect(blast).toBeTruthy()
    expect(blast).toContain('consumer.ts')
  })

  test('no blast-radius warning for an unimported file', async () => {
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'lonely.ts'), 'export const x = 1\n')
    seedSession('s2')
    const reg = await registry()
    const { codeGraphFor } = await import('../codegraph/index.js')
    await codeGraphFor(db).buildGraph(dir)

    await reg.execute('read', { path: 'src/lonely.ts' }, ctx('s2'))
    const res = (await reg.execute(
      'edit',
      { path: 'src/lonely.ts', oldString: 'const x = 1', newString: 'const x = 2' },
      ctx('s2'),
    )) as { editTargetWarnings?: string[] }
    expect((res.editTargetWarnings ?? []).some((w) => w.startsWith('Blast radius'))).toBe(false)
  })

  test('strict mode blocks a high fan-in edit (and writes nothing)', async () => {
    process.env.MIRA_STRICT_EDIT_TARGET = '1'
    process.env.MIRA_BLAST_RADIUS_BLOCK = '3'
    try {
      mkdirSync(join(dir, 'src'), { recursive: true })
      writeFileSync(join(dir, 'src', 'hub.ts'), 'export const hub = 1\n')
      for (let i = 0; i < 4; i++)
        writeFileSync(
          join(dir, 'src', `consumer${i}.ts`),
          `import { hub } from "./hub"\nexport const use${i} = hub\n`,
        )
      seedSession('s3')
      const reg = await registry()
      const { codeGraphFor } = await import('../codegraph/index.js')
      await codeGraphFor(db).buildGraph(dir)
      expect(codeGraphFor(db).stats().files).toBeGreaterThan(0)

      await reg.execute('read', { path: 'src/hub.ts' }, ctx('s3'))
      await expect(
        reg.execute(
          'edit',
          { path: 'src/hub.ts', oldString: 'hub = 1', newString: 'hub = 2' },
          ctx('s3'),
        ),
      ).rejects.toThrow(/Blast-radius guard/)
      // the block happens before any write
      expect(readFileSync(join(dir, 'src', 'hub.ts'), 'utf-8')).toContain('export const hub = 1')
    } finally {
      delete process.env.MIRA_STRICT_EDIT_TARGET
      delete process.env.MIRA_BLAST_RADIUS_BLOCK
    }
  })

  test('strict mode still only WARNS below the fan-in threshold', async () => {
    process.env.MIRA_STRICT_EDIT_TARGET = '1'
    process.env.MIRA_BLAST_RADIUS_BLOCK = '10'
    try {
      mkdirSync(join(dir, 'src'), { recursive: true })
      writeFileSync(join(dir, 'src', 'small.ts'), 'export const small = 1\n')
      writeFileSync(
        join(dir, 'src', 'one-consumer.ts'),
        'import { small } from "./small"\nexport const use = small\n',
      )
      seedSession('s4')
      const reg = await registry()
      const { codeGraphFor } = await import('../codegraph/index.js')
      await codeGraphFor(db).buildGraph(dir)

      await reg.execute('read', { path: 'src/small.ts' }, ctx('s4'))
      const res = (await reg.execute(
        'edit',
        { path: 'src/small.ts', oldString: 'small = 1', newString: 'small = 2' },
        ctx('s4'),
      )) as { editTargetWarnings?: string[] }
      const blast = (res.editTargetWarnings ?? []).find((w) => w.startsWith('Blast radius'))
      expect(blast).toBeTruthy()
      expect(readFileSync(join(dir, 'src', 'small.ts'), 'utf-8')).toContain('small = 2')
    } finally {
      delete process.env.MIRA_STRICT_EDIT_TARGET
      delete process.env.MIRA_BLAST_RADIUS_BLOCK
    }
  })

  test('a broken code graph never blocks an edit', async () => {
    // Blast-radius runs inside a try/catch; a cold graph must skip silently.
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'x.ts'), 'export const x = 1\n')
    seedSession('s5')
    const reg = await registry()
    // no buildGraph() — graph is empty/cold
    await reg.execute('read', { path: 'src/x.ts' }, ctx('s5'))
    const res = (await reg.execute(
      'edit',
      { path: 'src/x.ts', oldString: 'x = 1', newString: 'x = 2' },
      ctx('s5'),
    )) as { editTargetWarnings?: string[] }
    expect((res.editTargetWarnings ?? []).some((w) => w.startsWith('Blast radius'))).toBe(false)
    expect(readFileSync(join(dir, 'src', 'x.ts'), 'utf-8')).toContain('x = 2')
  })
})

describe('per-session state eviction', () => {
  test('session.deleted clears the read whitelist — read-guard re-arms', async () => {
    seedSession('s-del')
    const p = join(dir, 'guarded.ts')
    writeFileSync(p, 'original\n', 'utf-8')
    const reg = await registry()
    await reg.execute('read', { path: 'guarded.ts' }, ctx('s-del'))
    await reg.execute(
      'edit',
      { path: 'guarded.ts', oldString: 'original', newString: 'first' },
      ctx('s-del'),
    )

    // simulate session deletion
    bus.publish({ type: 'session.deleted', sessionID: 's-del', payload: {}, timestamp: Date.now() })

    // the read whitelist is gone: a further edit must hit the read guard again
    let threw = false
    try {
      await reg.execute(
        'edit',
        { path: 'guarded.ts', oldString: 'first', newString: 'second' },
        ctx('s-del'),
      )
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(readFileSync(p, 'utf-8')).toBe('first\n')
  })
})

describe('knowledge delete persists', () => {
  test('tombstone survives in the DB row (no resurrection on reload)', async () => {
    const { createLearningSystem } = await import('../learning/index.js')
    const system = createLearningSystem({ db, bus })
    const entry = await system.knowledge.store({
      tier: 'semantic',
      source: 'user',
      title: 'delete me',
      content: 'evidence of a real delete',
    })
    expect(system.knowledge.get(entry.id)).toBeDefined()

    expect(system.knowledge.remove(entry.id)).toBe(true)
    expect(system.knowledge.remove(entry.id)).toBe(false)
    expect(system.knowledge.get(entry.id)).toBeUndefined()

    // the persisted row is tombstoned — a reload cannot resurrect it
    const row = db.sqlite
      .prepare('SELECT metadata FROM knowledge_entries WHERE id = ?')
      .get(entry.id) as { metadata: string }
    expect(row.metadata).toContain('tombstone')
  })
})
