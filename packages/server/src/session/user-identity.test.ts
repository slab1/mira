import { describe, test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Hono } from 'hono'
import { createDatabase, migrate } from '../storage/db.js'
import { getUserByOwner, setUserNameForOwner } from '../storage/users.js'
import { SessionPrompt, extractIntroducedUserName } from './prompt.js'
import { Bus } from '../bus/index.js'
import { PermissionManager } from '../permission/index.js'
import { ToolRegistry } from '../tools/registry.js'
import { mountMeRoutes } from '../routes/me.js'
import { mountSessionRoutes } from '../routes/session.js'
import { mountSessionExtrasRoutes } from '../routes/session-extras.js'
import type { Gateway, GatewayChunk } from '../gateway/index.js'
import type { BusEvent } from '../types/index.js'

describe('User identity memory across sessions & chat', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mira-user-id-'))

  afterAll(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })

  test('extractIntroducedUserName handles natural self-introductions and skips non-names', () => {
    expect(extractIntroducedUserName('My name is Saheed')).toBe('Saheed')
    expect(extractIntroducedUserName('Hi Mira, my name is Ada Lovelace.')).toBe('Ada Lovelace')
    expect(extractIntroducedUserName('Remember my name is Alex!')).toBe('Alex')
    expect(extractIntroducedUserName('Please call me Jordan')).toBe('Jordan')
    expect(extractIntroducedUserName('My name is Sam, what can you do?')).toBe('Sam')

    // Negatives / code / ordinary commands
    expect(extractIntroducedUserName('Call me back later')).toBeUndefined()
    expect(extractIntroducedUserName('Call me when it is ready')).toBeUndefined()
    expect(extractIntroducedUserName('My name is a variable')).toBeUndefined()
    expect(extractIntroducedUserName('```\nMy name is Foo\n```')).toBeUndefined()
    expect(extractIntroducedUserName('What is my name?')).toBeUndefined()
  })

  test('injects /me name into system prompt even when session.ownerID is null (single-user MIRA_TOKEN mode)', async () => {
    const db = createDatabase(join(dir, 'single-user.db'))
    await migrate(db)
    const bus = new Bus()
    const capturedSystems: string[] = []

    const gateway: Gateway = {
      stream: async (opts) => {
        capturedSystems.push(typeof opts?.system === 'string' ? opts.system : '')
        return (async function* () {
          yield { type: 'text-delta', text: 'Hello!' } as GatewayChunk
          yield { type: 'finish', finishReason: 'stop' } as GatewayChunk
        })()
      },
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

    const permissions = new PermissionManager({})
    const tools = new ToolRegistry({ db, bus, permissions, gateway })
    const prompt = new SessionPrompt({ db, bus, gateway, tools, permissions })

    const API_KEY_OWNERS = new Map<string, string>()
    const bearerOf = (h?: string) => (h?.startsWith('Bearer ') ? h.slice(7) : '')
    const resolveOwner = (t: string) => (t === 'master-tok' ? 'default' : undefined)

    const app = new Hono<{ Variables: { requestId: string } }>()
    mountMeRoutes(app, { db, bus, resolveOwner, bearerOf })
    mountSessionRoutes(app, {
      db,
      bus,
      prompt,
      authorizedSession: async (id) => (await prompt.getSession(id)) ?? null,
      ownerOfSession: async () => null,
      orgOfOwner: () => undefined,
      orgOfSession: async () => null,
      resolveOwner,
      bearerOf,
      OWNERSHIP_ENABLED: () => false,
      sessionOwnerCache: new Map(),
    })
    mountSessionExtrasRoutes(app, {
      db,
      bus,
      prompt,
      authorizedSession: async (id) => (await prompt.getSession(id)) ?? null,
      ownerOfSession: async () => null,
      orgOfOwner: () => undefined,
      orgOfSession: async () => null,
      resolveOwner,
      bearerOf,
      API_KEY_OWNERS,
      sessionOwnerCache: new Map(),
    })

    const headers = { Authorization: 'Bearer master-tok', 'Content-Type': 'application/json' }

    // 1. Set name via PATCH /me
    const meRes = await app.request('http://localhost/me', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ name: 'Saheed', profile: { bio: 'Builds Mira' } }),
    })
    expect(meRes.status).toBe(200)

    // 2. Create session in single-user mode (ownerID is null)
    const sessRes = await app.request('http://localhost/session', {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Name check' }),
    })
    expect(sessRes.status).toBe(201)
    const sess = (await sessRes.json()) as { id: string; ownerID?: string | null }
    expect(sess.ownerID).toBeNull()

    // 3. Prompt in that session — system prompt must include Saheed + bio
    const promptRes = await app.request(`http://localhost/session/${sess.id}/prompt`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ prompt: 'What is my name?' }),
    })
    expect(promptRes.status).toBe(200)
    await promptRes.text()

    expect(capturedSystems.length).toBe(1)
    expect(capturedSystems[0]).toContain('You are assisting Saheed.')
    expect(capturedSystems[0]).toContain('User profile note: Builds Mira')
  })

  test('remembers self-introduced name in chat across a brand new session and subagents', async () => {
    const db = createDatabase(join(dir, 'chat-intro.db'))
    await migrate(db)
    const bus = new Bus()
    const events: BusEvent[] = []
    bus.subscribeAll((e) => events.push(e))
    const capturedSystems: string[] = []

    const gateway: Gateway = {
      stream: async (opts) => {
        capturedSystems.push(typeof opts?.system === 'string' ? opts.system : '')
        return (async function* () {
          yield { type: 'text-delta', text: 'Nice to meet you!' } as GatewayChunk
          yield { type: 'finish', finishReason: 'stop' } as GatewayChunk
        })()
      },
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

    const permissions = new PermissionManager({})
    const tools = new ToolRegistry({ db, bus, permissions, gateway })
    const prompt = new SessionPrompt({ db, bus, gateway, tools, permissions })

    const s1 = await prompt.createSession({ title: 'Session 1' })
    const r1 = await prompt.streamResponse(s1.id, 'Hi Mira, my name is Jordan.', undefined, {
      callerOwner: 'default',
    })
    await r1.text()

    const userRow = await getUserByOwner(db, 'default')
    expect(userRow.name).toBe('Jordan')
    expect(events.some((e) => e.type === 'me.updated')).toBe(true)
    expect(capturedSystems[0]).toContain('You are assisting Jordan.')

    // Brand new session later asks "What is my name?"
    const s2 = await prompt.createSession({ title: 'Session 2' })
    const r2 = await prompt.streamResponse(s2.id, 'What is my name?')
    await r2.text()
    expect(capturedSystems[1]).toContain('You are assisting Jordan.')

    // Subagent also knows user's name
    await prompt.runSubagent({ prompt: 'Say hi to the user', parentID: s2.id })
    expect(capturedSystems[2]).toContain('You are assisting Jordan.')

    // Explicitly resetting name via helper works too
    await setUserNameForOwner(db, 'default', 'Ada')
    expect((await getUserByOwner(db, 'default')).name).toBe('Ada')
  })
})
