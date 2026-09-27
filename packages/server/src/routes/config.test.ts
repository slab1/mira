import { describe, expect, test } from 'bun:test'
import type { MiraConfig } from '../types/index.js'
import { redactConfig } from './config.js'

describe('redactConfig', () => {
  test('redacts every rotated key and secret-bearing provider header', () => {
    const config = {
      provider: {
        test: {
          name: 'Test provider',
          options: {
            baseURL: 'https://api.example.test',
            apiKey: ['first-secret', 'second-secret'],
            headers: {
              Authorization: 'Bearer header-secret',
              'X-API-Key': 'header-api-key',
              'HTTP-Referer': 'https://mira.example.test',
            },
          },
          models: {},
        },
      },
    } as unknown as MiraConfig

    const redacted = redactConfig(config)
    const options = redacted.provider.test!.options

    expect(options.apiKey).toEqual(['***', '***'])
    expect(options.headers).toEqual({
      Authorization: '***',
      'X-API-Key': '***',
      'HTTP-Referer': 'https://mira.example.test',
    })
    expect(JSON.stringify(redacted)).not.toContain('secret')
    expect(JSON.stringify(config)).toContain('first-secret')
  })
})
