import { describe, test, expect } from 'bun:test'
import { ProviderError } from './errors.js'

describe('ProviderError', () => {
  test('sets name to ProviderError', () => {
    const e = new ProviderError({ message: 'test' })
    expect(e.name).toBe('ProviderError')
  })

  test('defaults code to PROVIDER_ERROR', () => {
    const e = new ProviderError({ message: 'test' })
    expect(e.code).toBe('PROVIDER_ERROR')
  })

  test('sets code explicitly', () => {
    const e = new ProviderError({ message: 'test', code: 'RATE_LIMITED' })
    expect(e.code).toBe('RATE_LIMITED')
  })

  test('sets provider', () => {
    const e = new ProviderError({ message: 'test', provider: 'openrouter' })
    expect(e.provider).toBe('openrouter')
  })

  test('sets status', () => {
    const e = new ProviderError({ message: 'test', status: 429 })
    expect(e.status).toBe(429)
  })

  test('sets custom remediation', () => {
    const e = new ProviderError({ message: 'test', remediation: 'do this' })
    expect(e.remediation).toBe('do this')
  })

  test('auto-generates remediation for NO_API_KEY', () => {
    const e = new ProviderError({ message: 'test', code: 'NO_API_KEY', provider: 'openrouter' })
    expect(e.remediation).toContain('OPENROUTER_API_KEY')
  })

  test('auto-generates remediation for ANTHROPIC NO_API_KEY', () => {
    const e = new ProviderError({ message: 'test', code: 'NO_API_KEY', provider: 'anthropic' })
    expect(e.remediation).toContain('ANTHROPIC_API_KEY')
  })

  test('auto-generates remediation for RATE_LIMITED', () => {
    const e = new ProviderError({ message: 'test', code: 'RATE_LIMITED' })
    expect(e.remediation).toContain('Rate limited')
  })

  test('auto-generates remediation for TIMEOUT', () => {
    const e = new ProviderError({ message: 'test', code: 'TIMEOUT' })
    expect(e.remediation).toContain('timed out')
  })

  test('auto-generates remediation for ABORTED', () => {
    const e = new ProviderError({ message: 'test', code: 'ABORTED' })
    expect(e.remediation).toContain('aborted')
  })

  test('retryable defaults for RATE_LIMITED', () => {
    const e = new ProviderError({ message: 'test', code: 'RATE_LIMITED' })
    expect(e.retryable).toBe(true)
  })

  test('retryable defaults for CIRCUIT_OPEN', () => {
    const e = new ProviderError({ message: 'test', code: 'CIRCUIT_OPEN' })
    expect(e.retryable).toBe(true)
  })

  test('retryable defaults for 500 status', () => {
    const e = new ProviderError({ message: 'test', status: 500 })
    expect(e.retryable).toBe(true)
  })

  test('retryable defaults for 502 status', () => {
    const e = new ProviderError({ message: 'test', status: 502 })
    expect(e.retryable).toBe(true)
  })

  test('retryable defaults for 408 status', () => {
    const e = new ProviderError({ message: 'test', status: 408 })
    expect(e.retryable).toBe(true)
  })

  test('retryable defaults for timeout message', () => {
    const e = new ProviderError({ message: 'ETIMEDOUT connection' })
    expect(e.retryable).toBe(true)
  })

  test('not retryable for 400', () => {
    const e = new ProviderError({ message: 'bad request', status: 400 })
    expect(e.retryable).toBe(false)
  })

  test('not retryable for 401', () => {
    const e = new ProviderError({ message: 'unauthorized', status: 401 })
    expect(e.retryable).toBe(false)
  })

  test('not retryable for 404', () => {
    const e = new ProviderError({ message: 'not found', status: 404 })
    expect(e.retryable).toBe(false)
  })

  test('explicit retryable overrides auto-detection', () => {
    const e = new ProviderError({ message: 'test', status: 500, retryable: false })
    expect(e.retryable).toBe(false)
  })

  test('is an instance of Error', () => {
    const e = new ProviderError({ message: 'test' })
    expect(e).toBeInstanceOf(Error)
  })

  test('is an instance of ProviderError', () => {
    const e = new ProviderError({ message: 'test' })
    expect(e).toBeInstanceOf(ProviderError)
  })
})
