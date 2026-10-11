import { describe, test, expect, beforeEach } from 'bun:test'
import { createDatabase, migrate } from '../storage/db.js'
import { writeFinding, openFindingsForContext } from './findings.js'
import { ToolRegistry } from './registry.js'
import { PermissionManager } from '../permission/index.js'
import { Bus } from '../bus/index.js'
import type { Gateway } from '../gateway/index.js'

// Think + observe: a reasoning scratchpad with zero side effects, and critic
// feedback that arrives with an instruction instead of as raw log noise.

let db: ReturnType<typeof createDatabase>

beforeEach(async () => {
  db = createDatabase(':memory:')
  await migrate(db)
})

describe('think tool', () => {
  test('registered in the registry', async () => {
    const reg = new ToolRegistry({
      db,
      bus: new Bus(),
      permissions: new PermissionManager({}),
      gateway: { complete: async () => ({ text: '' }) } as unknown as Gateway,
    })
    await reg.registerAll()
    expect(reg.get('think')).toBeDefined()
  })

  test('executes with no side effects and reports the thought length', async () => {
    // Through the registry — the same path agent calls take (schema + ctx).
    const reg = new ToolRegistry({
      db,
      bus: new Bus(),
      permissions: new PermissionManager({}),
      gateway: { complete: async () => ({ text: '' }) } as unknown as Gateway,
    })
    await reg.registerAll()
    const res = (await reg.execute(
      'think',
      { thought: 'I will edit src/auth.ts, function target()' },
      {
        sessionID: 's',
        messageID: 'm',
      } as never,
    )) as { ok: boolean; thoughtLength: number }
    expect(res.ok).toBe(true)
    expect(res.thoughtLength).toBe('I will edit src/auth.ts, function target()'.length)
  })

  test('rejects an empty thought (the structure is the point)', async () => {
    // Validation lives in the registry path — the same way agent calls arrive.
    const reg = new ToolRegistry({
      db,
      bus: new Bus(),
      permissions: new PermissionManager({}),
      gateway: { complete: async () => ({ text: '' }) } as unknown as Gateway,
    })
    await reg.registerAll()
    let threw = false
    try {
      await reg.execute('think', { thought: '' }, {
        sessionID: 's',
        messageID: 'm',
      } as never)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })
})

describe('critic feedback observation', () => {
  test('critic findings get an explicit act-on-it instruction in the context', async () => {
    await writeFinding(db, {
      title: 'Edit critic: logout.ts may not match the task',
      severity: 'minor',
      source: 'tool',
      evidence: 'task names login.ts but this change touches logout.ts',
    })
    const ctx = await openFindingsForContext(db)
    expect(ctx).toContain('CRITIC FEEDBACK on your recent edits')
    expect(ctx).toContain('fix or revert it')
    expect(ctx).toContain('Edit critic: logout.ts')
  })

  test('ordinary findings keep the original framing', async () => {
    await writeFinding(db, {
      title: 'retry loop masks real errors',
      severity: 'minor',
      source: 'agent',
    })
    const ctx = await openFindingsForContext(db)
    expect(ctx).toContain('Known findings (avoid repeating solved problems)')
    expect(ctx).not.toContain('CRITIC FEEDBACK')
  })

  test('no findings → empty context, no header', async () => {
    expect(await openFindingsForContext(db)).toBe('')
  })
})
