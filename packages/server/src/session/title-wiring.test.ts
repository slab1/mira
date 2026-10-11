import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { createDatabase, migrate } from '../storage/db.js'
import { SessionPrompt } from './prompt.js'
import { Bus } from '../bus/index.js'
import { PermissionManager } from '../permission/index.js'
import { ToolRegistry } from '../tools/registry.js'
import type { Gateway } from '../gateway/index.js'

// Wiring check: a session created with the default title takes its name from
// the first user prompt, through the real streamResponse path.

const stubGateway: Gateway = {
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
}

let db: ReturnType<typeof createDatabase>
let prompt!: SessionPrompt

beforeEach(async () => {
  db = createDatabase(':memory:')
  await migrate(db)
  const bus = new Bus()
  const permissions = new PermissionManager({})
  const tools = new ToolRegistry({ db, bus: new Bus(), permissions, gateway: stubGateway })
  await tools.registerAll()
  prompt = new SessionPrompt({ db, bus, gateway: stubGateway, tools, permissions })
})

afterAll(() => {
  try {
    db.sqlite.close()
  } catch {}
})

describe('streamResponse → auto-title wiring', () => {
  test('first prompt titles a default session', async () => {
    const s = await prompt.createSession({ title: 'New Session' })
    await prompt.streamResponse(s.id, 'fix the login bug in the auth module\nsteps: 1. reproduce')
    const row = (await prompt.getSession(s.id)) as { title: string }
    expect(row.title).toBe('fix the login bug in the auth module')
  })

  test('a session created with an explicit title keeps it', async () => {
    const s = await prompt.createSession({ title: 'release prep' })
    await prompt.streamResponse(s.id, 'do the thing')
    const row = (await prompt.getSession(s.id)) as { title: string }
    expect(row.title).toBe('release prep')
  })

  test('second prompt does not retitle', async () => {
    const s = await prompt.createSession({ title: 'New Session' })
    await prompt.streamResponse(s.id, 'first task')
    await prompt.streamResponse(s.id, 'a completely different second task that is long')
    const row = (await prompt.getSession(s.id)) as { title: string }
    expect(row.title).toBe('first task')
  })
})
