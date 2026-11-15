// @ts-nocheck
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { clearTokenOn401, ensureToken, getToken, setToken } from '../api/client'

class MemoryStorage {
  values = new Map<string, string>()
  getItem(key: string) {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.values.set(key, String(value))
  }
  removeItem(key: string) {
    this.values.delete(key)
  }
  clear() {
    this.values.clear()
  }
}

const originalFetch = globalThis.fetch
const originalSessionStorage = globalThis.sessionStorage
const originalLocalStorage = globalThis.localStorage

beforeEach(() => {
  globalThis.sessionStorage = new MemoryStorage()
  globalThis.localStorage = new MemoryStorage()
  setToken('')
})

afterEach(() => {
  globalThis.fetch = originalFetch
  globalThis.sessionStorage = originalSessionStorage
  globalThis.localStorage = originalLocalStorage
})

describe('token clear marker', () => {
  test('401 prevents a rejected VITE_MIRA_TOKEN fallback from being reused', async () => {
    expect(import.meta.env.VITE_MIRA_TOKEN).toBe('rejected-env-token')
    setToken('rejected-env-token')
    clearTokenOn401()

    expect(getToken()).toBe('')
    globalThis.fetch = async () => ({ json: async () => ({}) }) as Response
    expect(await ensureToken()).toBe('')
    expect(getToken()).toBe('')
  })

  test('explicit token replacement clears the marker and becomes active', () => {
    clearTokenOn401()
    setToken('replacement-token')
    expect(getToken()).toBe('replacement-token')
  })

  test('discovered token replaces the rejected fallback and clears the marker', async () => {
    clearTokenOn401()
    globalThis.fetch = async (input: RequestInfo | URL) =>
      ({
        json: async () =>
          String(input).includes('/auth/token') ? { token: 'discovered-token' } : {},
      }) as Response

    expect(await ensureToken()).toBe('discovered-token')
    expect(getToken()).toBe('discovered-token')
  })
})
