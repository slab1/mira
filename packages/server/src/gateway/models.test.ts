import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { listModels, clearModelsCache } from './models.js'

// Mock fetch to avoid network calls
const originalFetch = globalThis.fetch

function mockFetchJson(response: unknown, ok = true, status = 200) {
  globalThis.fetch = mock(() =>
    Promise.resolve({
      ok,
      status,
      json: () => Promise.resolve(response),
    } as Response),
  ) as unknown as typeof fetch
}

beforeEach(() => {
  clearModelsCache()
  globalThis.fetch = originalFetch
})

describe('listModels', () => {
  test('returns models from openrouter /models endpoint', async () => {
    mockFetchJson({
      data: [
        { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', context_length: 200000 },
        { id: 'openai/gpt-4o', name: 'GPT-4o', context_length: 128000 },
      ],
    })
    const models = await listModels({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: 'test-key',
      headers: {},
      providerKey: 'openrouter',
    })
    expect(models.length).toBe(2)
    expect(models[0].id).toBe('openrouter/anthropic/claude-sonnet-4')
    expect(models[0].name).toBe('Claude Sonnet 4')
    expect(models[0].context).toBe(200000)
    expect(models[1].id).toBe('openrouter/openai/gpt-4o')
  })

  test('caches results within TTL', async () => {
    mockFetchJson({
      data: [{ id: 'test-model', name: 'Test', context_length: 128000 }],
    })
    const models1 = await listModels({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: 'test-key',
      headers: {},
      providerKey: 'openrouter',
    })
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    const models2 = await listModels({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: 'test-key',
      headers: {},
      providerKey: 'openrouter',
    })
    // Should still be 1 call (cached)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    expect(models2).toEqual(models1)
  })

  test('returns stale cache on fetch failure', async () => {
    mockFetchJson({
      data: [{ id: 'cached-model', name: 'Cached', context_length: 128000 }],
    })
    await listModels({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: 'test-key',
      headers: {},
      providerKey: 'openrouter',
    })

    // Now make fetch fail
    globalThis.fetch = mock(() =>
      Promise.reject(new Error('network error')),
    ) as unknown as typeof fetch
    const models = await listModels({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: 'test-key',
      headers: {},
      providerKey: 'openrouter',
    })
    expect(models.length).toBe(1)
    expect(models[0].id).toBe('openrouter/cached-model')
  })

  test('throws when both openrouter and native fetch fail and no cache', async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error('network error')),
    ) as unknown as typeof fetch
    await expect(
      listModels({
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: 'test-key',
        headers: {},
        providerKey: 'openrouter',
      }),
    ).rejects.toThrow('Failed to list models')
  })

  test('for non-openrouter, tries native /models endpoint', async () => {
    mockFetchJson({
      data: [{ id: 'gpt-4o', name: 'GPT-4o', context_length: 128000 }],
    })
    const models = await listModels({
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      headers: {},
      providerKey: 'openai',
    })
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    expect(models.length).toBe(1)
    expect(models[0].id).toBe('openai/gpt-4o')
  })

  test('handles missing context_length with default 128000', async () => {
    mockFetchJson({
      data: [{ id: 'model', name: 'Model' }], // no context_length
    })
    const models = await listModels({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: 'test-key',
      headers: {},
      providerKey: 'openrouter',
    })
    expect(models[0].context).toBe(128_000)
  })

  test('handles contextLength field (alternative naming)', async () => {
    mockFetchJson({
      data: [{ id: 'model', name: 'Model', contextLength: 64000 }],
    })
    const models = await listModels({
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      headers: {},
      providerKey: 'openai',
    })
    expect(models[0].context).toBe(64000)
  })

  test('limits to 100 models', async () => {
    const manyModels = Array.from({ length: 150 }, (_, i) => ({
      id: `model-${i}`,
      name: `Model ${i}`,
      context_length: 128000,
    }))
    mockFetchJson({ data: manyModels })
    const models = await listModels({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: 'test-key',
      headers: {},
      providerKey: 'openrouter',
    })
    expect(models.length).toBe(100)
  })

  test('clearModelsCache resets state', async () => {
    mockFetchJson({
      data: [{ id: 'model', name: 'Model', context_length: 128000 }],
    })
    const firstFetch = globalThis.fetch
    await listModels({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: 'test-key',
      headers: {},
      providerKey: 'openrouter',
    })
    clearModelsCache()
    // After clearing, fetch should be called again
    mockFetchJson({
      data: [{ id: 'model2', name: 'Model 2', context_length: 64000 }],
    })
    const secondFetch = globalThis.fetch
    const models = await listModels({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: 'test-key',
      headers: {},
      providerKey: 'openrouter',
    })
    expect(firstFetch).toHaveBeenCalledTimes(1)
    expect(secondFetch).toHaveBeenCalledTimes(1)
    expect(models[0].id).toBe('openrouter/model2')
  })
})
