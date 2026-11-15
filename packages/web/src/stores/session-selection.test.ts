import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test'
import { createRoot } from 'solid-js'

mock.module('../components/Toast', () => ({
  toast: {
    info: () => {},
    warn: () => {},
    error: () => {},
    success: () => {},
  },
}))

import { api, type Session, type Message, type Todo } from '../api/client'
const { createAppStore } = await import('./app')

function deferred<T>() {
  let resolve!: (val: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('AppStore session selection integrity', () => {
  const storageMap = new Map<string, string>()
  const prevStorage = globalThis.localStorage
  const spies: Array<{ mockRestore: () => void }> = []

  beforeEach(() => {
    storageMap.clear()
    globalThis.localStorage = {
      getItem: (k: string) => storageMap.get(k) ?? null,
      setItem: (k: string, v: string) => {
        storageMap.set(k, v)
      },
      removeItem: (k: string) => {
        storageMap.delete(k)
      },
      clear: () => storageMap.clear(),
      key: (i: number) => [...storageMap.keys()][i] ?? null,
      get length() {
        return storageMap.size
      },
    } as Storage

    spies.push(
      spyOn(api, 'devHealth').mockResolvedValue({ ok: true } as never),
      spyOn(api, 'getConfig').mockResolvedValue({} as never),
      spyOn(api, 'getSession').mockResolvedValue(null as never),
      spyOn(api, 'getQueue').mockResolvedValue([]),
      spyOn(api, 'listPendingPermissions').mockResolvedValue({ pending: [] }),
    )
  })

  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore()
    globalThis.localStorage = prevStorage
  })

  test('stale loadMessages/loadTodos from an earlier session never overwrite a newer selection', async () => {
    const slowMsgsA = deferred<Message[]>()
    const slowTodosA = deferred<Todo[]>()

    spies.push(
      spyOn(api, 'getMessages').mockImplementation((id: string) => {
        if (id === 'sess-a') return slowMsgsA.promise
        return Promise.resolve([
          {
            id: 'msg-b1',
            sessionId: 'sess-b',
            role: 'assistant',
            content: 'Session B reply',
            createdAt: '2026-11-15T00:00:00Z',
          },
        ])
      }),
      spyOn(api, 'getTodos').mockImplementation((id: string) => {
        if (id === 'sess-a') return slowTodosA.promise
        return Promise.resolve([{ id: 'tb', content: 'Todo B', status: 'pending', priority: 'high' }])
      }),
    )

    await createRoot(async (dispose) => {
      const store = createAppStore()
      const pA = store.selectSession('sess-a')
      const pB = store.selectSession('sess-b')
      await pB

      // Resolve slow Session A fetches AFTER Session B is active
      slowMsgsA.resolve([
        {
          id: 'msg-a1',
          sessionId: 'sess-a',
          role: 'assistant',
          content: 'STALE A MESSAGE',
          createdAt: '2026-11-15T00:00:00Z',
        },
      ])
      slowTodosA.resolve([{ id: 'ta', content: 'STALE TODO A', status: 'pending', priority: 'low' }])
      await pA

      expect(store.state.currentId).toBe('sess-b')
      expect(store.state.messages.map((m) => m.content)).toEqual(['Session B reply'])
      expect(store.state.todos.map((t) => t.content)).toEqual(['Todo B'])
      dispose()
    })
  })

  test('loadSessions restores persisted currentSessionId instead of jumping to sessions[0]', async () => {
    storageMap.set('mira.currentSessionId', 'sess-2')
    const sessions: Session[] = [
      { id: 'sess-1', title: 'First', createdAt: '2026-11-15T01:00:00Z', updatedAt: '2026-11-15T01:00:00Z' },
      { id: 'sess-2', title: 'Second', createdAt: '2026-11-15T00:00:00Z', updatedAt: '2026-11-15T00:00:00Z' },
    ]
    spies.push(
      spyOn(api, 'listSessions').mockResolvedValue(sessions),
      spyOn(api, 'getMessages').mockResolvedValue([]),
      spyOn(api, 'getTodos').mockResolvedValue([]),
    )

    await createRoot(async (dispose) => {
      const store = createAppStore()
      await store.loadSessions()
      expect(store.state.currentId).toBe('sess-2')
      dispose()
    })
  })

  test('loadSessions recovers cleanly when currentId disappears from server list', async () => {
    const sessions: Session[] = [
      { id: 'sess-fresh', title: 'Fresh', createdAt: '2026-11-15T01:00:00Z', updatedAt: '2026-11-15T01:00:00Z' },
    ]
    spies.push(
      spyOn(api, 'listSessions').mockResolvedValue(sessions),
      spyOn(api, 'getMessages').mockResolvedValue([]),
      spyOn(api, 'getTodos').mockResolvedValue([]),
    )

    await createRoot(async (dispose) => {
      const store = createAppStore()
      await store.selectSession('sess-deleted')
      expect(store.state.currentId).toBe('sess-deleted')

      await store.loadSessions()
      expect(store.state.currentId).toBe('sess-fresh')
      dispose()
    })
  })
})
