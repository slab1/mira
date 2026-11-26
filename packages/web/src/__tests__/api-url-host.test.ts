// @ts-nocheck
import { afterEach, describe, expect, test } from 'bun:test'
import { getApiUrl, resolveServerHost } from '../api/client'

const originalWindow = globalThis.window

afterEach(() => {
  globalThis.window = originalWindow
  const env = import.meta.env as Record<string, string | undefined>
  delete env.VITE_API_URL
})

describe('VITE_API_URL normalization and resolveServerHost()', () => {
  test('VITE_API_URL="/" normalizes to empty same-origin base and resolves window.location.host', () => {
    const env = import.meta.env as Record<string, string | undefined>
    env.VITE_API_URL = '/'
    globalThis.window = {
      location: {
        origin: 'https://mira.example.com',
        host: 'mira.example.com',
        protocol: 'https:',
        hostname: 'mira.example.com',
        search: '',
      },
      localStorage: { getItem: () => null, removeItem: () => {} },
    } as unknown as Window & typeof globalThis

    expect(getApiUrl()).toBe('')
    expect(resolveServerHost()).toBe('mira.example.com')
  })

  test('relative VITE_API_URL="/api" resolves host against window.location.origin instead of "unknown"', () => {
    const env = import.meta.env as Record<string, string | undefined>
    env.VITE_API_URL = '/api/'
    globalThis.window = {
      location: {
        origin: 'https://mira.example.com:8443',
        host: 'mira.example.com:8443',
        protocol: 'https:',
        hostname: 'mira.example.com',
        search: '',
      },
      localStorage: { getItem: () => null, removeItem: () => {} },
    } as unknown as Window & typeof globalThis

    expect(getApiUrl()).toBe('/api')
    expect(resolveServerHost()).toBe('mira.example.com:8443')
  })

  test('absolute VITE_API_URL resolves its explicit host', () => {
    const env = import.meta.env as Record<string, string | undefined>
    env.VITE_API_URL = 'https://api.mira.dev/'
    globalThis.window = {
      location: {
        origin: 'https://web.mira.dev',
        host: 'web.mira.dev',
        protocol: 'https:',
        hostname: 'web.mira.dev',
        search: '',
      },
      localStorage: { getItem: () => null, removeItem: () => {} },
    } as unknown as Window & typeof globalThis

    expect(getApiUrl()).toBe('https://api.mira.dev')
    expect(resolveServerHost()).toBe('api.mira.dev')
  })
})
