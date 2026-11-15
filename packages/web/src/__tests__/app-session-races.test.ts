// @ts-nocheck
import { afterEach, describe, expect, test } from 'bun:test'
import { createAppStore } from '../stores/app'

const api = {
  getMessages: async (id: string) => messageLoads.get(id)?.() ?? [],
  getTodos: async (id: string) => todoLoads.get(id)?.() ?? [],
  getQueue: async (id: string) => [`queue-${id}`],
  queuePrompt: async (id: string, prompt: string) => {
    queuedRequests.push({ id, prompt })
    return { position: 1 }
  },
  streamPrompt: (id: string, prompt: string, options: unknown) => {
    streamedRequests.push({ id, prompt, options })
    return new Promise<void>((resolve) => streamResolvers.set(id, resolve))
  },
  abortPrompt: async () => {},
  devHealth: async () => ({}),
  getConfig: async () => ({}),
  getSession: async () => null,
}

const messageLoads = new Map<string, () => Promise<unknown> | unknown>()
const todoLoads = new Map<string, () => Promise<unknown> | unknown>()
const streamedRequests: Array<{ id: string; prompt: string; options: any }> = []
const streamResolvers = new Map<string, () => void>()
const queuedRequests: Array<{ id: string; prompt: string }> = []
const socketFactory = () => ({ ws: null, connect() {}, disconnect() {}, send() {} })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

function message(id: string) {
  return [{ id: `message-${id}`, sessionId: id, role: 'user', content: id, createdAt: 'now' }]
}

function todo(id: string) {
  return [{ id: `todo-${id}`, content: id, status: 'pending' }]
}

function reset() {
  messageLoads.clear()
  todoLoads.clear()
  streamedRequests.length = 0
  streamResolvers.clear()
  queuedRequests.length = 0
  api.getQueue = async (id: string) => [`queue-${id}`]
}

afterEach(reset)

describe('app store session race regressions', () => {
  test('late messages, todos, and queue results from a previous selection are ignored', async () => {
    const messagesA = deferred<any>()
    const todosA = deferred<any>()
    const queueA = deferred<any>()
    const messagesB = deferred<any>()
    const todosB = deferred<any>()

    messageLoads.set('A', () => messagesA.promise)
    todoLoads.set('A', () => todosA.promise)
    messageLoads.set('B', () => messagesB.promise)
    todoLoads.set('B', () => todosB.promise)
    api.getQueue = async (id: string) => (id === 'A' ? queueA.promise : [`queue-${id}`])

    const store = createAppStore(api as any, socketFactory as any)
    const selectA = store.selectSession('A')
    const selectB = store.selectSession('B')

    messagesB.resolve(message('B'))
    todosB.resolve(todo('B'))
    await selectB
    expect(store.state.messages.map((m) => m.sessionId)).toEqual(['B'])
    expect(store.state.todos.map((t) => t.id)).toEqual(['todo-B'])
    expect(store.state.queued).toEqual(['queue-B'])

    messagesA.resolve(message('A'))
    todosA.resolve(todo('A'))
    await Promise.resolve()
    queueA.resolve(['queue-A'])
    await selectA
    expect(store.state.currentId).toBe('B')
    expect(store.state.messages.map((m) => m.sessionId)).toEqual(['B'])
    expect(store.state.todos.map((t) => t.id)).toEqual(['todo-B'])
    expect(store.state.queued).toEqual(['queue-B'])
  })

  test('a stream remains scoped to its starting session when switching and sending elsewhere', async () => {
    const store = createAppStore(api as any, socketFactory as any)
    await store.selectSession('A')

    const sendA = store.sendPrompt('prompt A')
    expect(store.state.streaming).toBe(true)
    const streamA = streamedRequests.find((request) => request.id === 'A')!
    streamA.options.onChunk('A output')

    await store.selectSession('B')
    expect(store.state.streaming).toBe(false)
    expect(store.state.streamText).toBe('')

    const sendB = store.sendPrompt('prompt B')
    expect(streamedRequests.map((request) => request.id)).toEqual(['A', 'B'])
    expect(queuedRequests).toEqual([])
    expect(store.state.streaming).toBe(true)

    streamA.options.onChunk(' ignored while B is selected')
    streamA.options.onEvent({ type: 'error', payload: 'A failed' })
    expect(store.state.streamText).toBe('')
    expect(store.state.error).toBeNull()

    streamResolvers.get('A')!()
    await sendA
    expect(store.state.currentId).toBe('B')
    expect(store.state.streaming).toBe(true)

    const streamB = streamedRequests.find((request) => request.id === 'B')!
    streamB.options.onChunk('B output')
    expect(store.state.streamText).toBe('B output')
    streamResolvers.get('B')!()
    await sendB
    expect(store.state.streaming).toBe(false)
  })

  test('queueing is limited to the selected session that is actively streaming', async () => {
    const store = createAppStore(api as any, socketFactory as any)
    await store.selectSession('A')
    const sendA = store.sendPrompt('first')
    await store.selectSession('B')

    const sendB = store.sendPrompt('second')
    expect(queuedRequests).toEqual([])
    expect(streamedRequests.map((request) => request.id)).toEqual(['A', 'B'])

    await store.selectSession('A')
    await store.sendPrompt('queue for A')
    expect(queuedRequests).toEqual([{ id: 'A', prompt: 'queue for A' }])

    streamResolvers.get('A')!()
    streamResolvers.get('B')!()
    await Promise.all([sendA, sendB])
  })

  test('stopping a stream aborts its request and clears transient stream state', async () => {
    const store = createAppStore(api as any, socketFactory as any)
    await store.selectSession('A')
    const sendA = store.sendPrompt('stop this stream')
    const stream = streamedRequests.find((request) => request.id === 'A')!
    stream.options.onChunk('partial output')
    stream.options.onEvent({ type: 'status', payload: { text: 'working' } })

    store.stopStream()

    expect(stream.options.signal.aborted).toBe(true)
    expect(store.state.streaming).toBe(false)
    expect(store.state.streamText).toBe('')
    expect(store.state.liveStreamEvents).toEqual([])
    streamResolvers.get('A')!()
    await sendA
  })
})
