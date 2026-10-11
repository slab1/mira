import { describe, test, expect, beforeEach } from 'bun:test'
import { createDatabase, migrate } from '../storage/db.js'
import { Bus } from '../bus/index.js'
import { isDefaultTitle, maybeAutoTitle, titleFromPrompt } from './title.js'
import type { MiraDB } from '../storage/db.js'

// Session auto-titling — main sessions take their name from the first user
// prompt; user-chosen titles are never clobbered.

let db: MiraDB
let events: Array<{ type: string; payload: unknown }>

beforeEach(async () => {
  db = createDatabase(':memory:')
  await migrate(db)
  events = []
})

const busWithCapture = () => {
  const bus = new Bus()
  bus.subscribe('session.updated', (e) => events.push({ type: e.type, payload: e.payload }))
  return bus
}

const seedSession = (id: string, title: string | null) => {
  db.sqlite
    .prepare(
      'INSERT OR IGNORE INTO sessions (id, title, model, provider, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    )
    .run(id, title, 'm', 'p', Date.now(), Date.now())
}
const rowTitle = (id: string) =>
  (db.sqlite.prepare('SELECT title FROM sessions WHERE id = ?').get(id) as { title: string }).title

describe('titleFromPrompt', () => {
  test('uses the first non-empty line, whitespace collapsed', () => {
    expect(titleFromPrompt('\n  fix the   login bug \nmore detail')).toBe('fix the login bug')
  })

  test('truncates long prompts with an ellipsis at 60 chars', () => {
    const long = 'a'.repeat(100)
    const t = titleFromPrompt(long)
    expect(t.length).toBe(60)
    expect(t.endsWith('…')).toBe(true)
  })

  test('empty prompt → empty title (caller skips)', () => {
    expect(titleFromPrompt('   \n  ')).toBe('')
  })
})

describe('isDefaultTitle', () => {
  test('recognizes placeholders', () => {
    expect(isDefaultTitle('New Session')).toBe(true)
    expect(isDefaultTitle('Imported Session')).toBe(true)
    expect(isDefaultTitle('')).toBe(true)
    expect(isDefaultTitle(null)).toBe(true)
    expect(isDefaultTitle('coder session')).toBe(true) // legacy agent default
  })

  test('user-chosen titles are protected', () => {
    expect(isDefaultTitle('My refactor plan')).toBe(false)
    expect(isDefaultTitle('fix the login bug')).toBe(false)
    expect(isDefaultTitle('session')).toBe(false) // needs the " session" suffix pattern with a name
  })
})

describe('maybeAutoTitle', () => {
  test('titles a default session from the first prompt and publishes the event', async () => {
    seedSession('s1', 'New Session')
    const bus = busWithCapture()
    await maybeAutoTitle(db, bus, 's1', 'New Session', 'fix the login bug\nsteps: 1...')
    expect(rowTitle('s1')).toBe('fix the login bug')
    expect(events.length).toBe(1)
    expect((events[0].payload as { title: string }).title).toBe('fix the login bug')
  })

  test('never clobbers a user-chosen title', async () => {
    seedSession('s1', 'My refactor plan')
    await maybeAutoTitle(db, busWithCapture(), 's1', 'My refactor plan', 'fix the login bug')
    expect(rowTitle('s1')).toBe('My refactor plan')
  })

  test('agent-default titles are replaced too (legacy child sessions)', async () => {
    seedSession('s1', 'coder session')
    await maybeAutoTitle(
      db,
      busWithCapture(),
      's1',
      'coder session',
      'write the failing test first',
    )
    expect(rowTitle('s1')).toBe('write the failing test first')
  })

  test('fires once — after apply the title is no longer default', async () => {
    seedSession('s1', 'New Session')
    const bus = busWithCapture()
    await maybeAutoTitle(db, bus, 's1', 'New Session', 'first prompt')
    await maybeAutoTitle(db, bus, 's1', rowTitle('s1'), 'second prompt changes nothing')
    expect(rowTitle('s1')).toBe('first prompt')
    expect(events.length).toBe(1)
  })

  test('empty prompt → no-op', async () => {
    seedSession('s1', 'New Session')
    await maybeAutoTitle(db, busWithCapture(), 's1', 'New Session', '   ')
    expect(rowTitle('s1')).toBe('New Session')
  })

  test('unknown session → never throws', async () => {
    await expect(
      maybeAutoTitle(db, busWithCapture(), 'missing', 'New Session', 'hello'),
    ).resolves.toBeUndefined()
  })
})
