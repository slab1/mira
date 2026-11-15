import { createRoot } from 'solid-js'
import { describe, expect, mock, test } from 'bun:test'

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const messages = new Map<string, Deferred<unknown[]>[]>()
const todos = new Map<string, Deferred<unknown[]>[]>()
const queues = new Map<string, Deferred<string[]>[]>()
function pending<T>(map: Map<string, Deferred<T>[]>, id: string): Deferred<T> {
  const item = deferred<T>()
  map.set(id, [...(map.get(id) ?? []), item])
  return item
}
function next<T>(map: Map<string, Deferred<T>[]>, id: string): Deferred<T> {
  const item = map.get(id)?.shift()
  if (!item) throw new Error(`No pending request for ${id}`)
  return item
}
const mockRpc = {
  getMessages: (id: string) => pending(messages, id).promise,
  getTodos: (id: string) => pending(todos, id).promise,
  getQueue: (id: string) => pending(queues, id).promise,
  devHealth: async () => ({}),
  getConfig: async () => ({}),
}
const mockSocket = { ws: undefined, connect: mock(() => {}), send: mock(() => {}) }
mock.module('../src/rpc/client', () => ({ rpc: mockRpc, createSocket: () => mockSocket }))
const { createSessionStore } = await import('../src/stores/session')

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('TUI session selection loads', () => {
  test('ignores stale message, todo, and queue results after changing selection', async () => {
    let store!: ReturnType<typeof createSessionStore>
    let dispose!: () => void
    createRoot((d) => {
      dispose = d
      store = createSessionStore()
    })

    try {
      const firstVisit = store.selectSession('A')
      const secondVisit = store.selectSession('B')
      next(messages, 'B').resolve([{ id: 'message-B' }])
      next(todos, 'B').resolve([{ id: 'todo-B' }])
      await flushPromises()
      next(queues, 'B').resolve(['queue-B'])
      await secondVisit

      // The older A requests complete only after B has become current.
      next(messages, 'A').resolve([{ id: 'message-A' }])
      next(todos, 'A').resolve([{ id: 'todo-A' }])
      await firstVisit
      expect(store.state.messages.map((item) => item.id)).toEqual(['message-B'])
      expect(store.state.todos.map((item) => item.id)).toEqual(['todo-B'])
      expect(store.state.queued).toEqual(['queue-B'])

      // Also cover the later queue await: A's messages may load while selected,
      // but its queue response must be ignored if the user switches meanwhile.
      const thirdVisit = store.selectSession('C')
      next(messages, 'C').resolve([{ id: 'message-C' }])
      next(todos, 'C').resolve([{ id: 'todo-C' }])
      await flushPromises()
      const fourthVisit = store.selectSession('D')
      next(messages, 'D').resolve([{ id: 'message-D' }])
      next(todos, 'D').resolve([{ id: 'todo-D' }])
      await flushPromises()
      next(queues, 'D').resolve(['queue-D'])
      await fourthVisit
      next(queues, 'C').resolve(['queue-C'])
      await thirdVisit

      expect(store.state.messages.map((item) => item.id)).toEqual(['message-D'])
      expect(store.state.todos.map((item) => item.id)).toEqual(['todo-D'])
      expect(store.state.queued).toEqual(['queue-D'])
    } finally {
      dispose()
    }
  })
})
