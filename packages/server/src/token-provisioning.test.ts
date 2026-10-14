/**
 * MIRA_TOKEN precedence tests.
 *
 * Regression: provisionFirstRunToken() overwrote an explicitly-passed
 * MIRA_TOKEN with the value from ~/.mira/mira.env, so `MIRA_TOKEN=x bun start`
 * silently ran with a different token than the operator set. The env now wins.
 */
import { describe, test, expect } from 'bun:test'
import { ENV_OVERRIDES_FILE_WARNING, resolveTokenPrecedence } from './token-provisioning.js'

describe('resolveTokenPrecedence', () => {
  test('explicit env token wins over a different file token', () => {
    const r = resolveTokenPrecedence({ envToken: 'from-env', fileToken: 'from-file' })
    expect(r.token).toBe('from-env')
    expect(r.source).toBe('env')
    expect(r.conflicted).toBe(true)
  })

  test('the file supplies the token when env is unset', () => {
    const r = resolveTokenPrecedence({ fileToken: 'from-file' })
    expect(r.token).toBe('from-file')
    expect(r.source).toBe('file')
    expect(r.conflicted).toBe(false)
  })

  test('matching env and file tokens are not a conflict', () => {
    const r = resolveTokenPrecedence({ envToken: 'same', fileToken: 'same' })
    expect(r.token).toBe('same')
    expect(r.source).toBe('env')
    expect(r.conflicted).toBe(false)
  })

  test('empty env values are treated as absent so the file can supply one', () => {
    expect(resolveTokenPrecedence({ envToken: '', fileToken: 'from-file' }).token).toBe('from-file')
    expect(resolveTokenPrecedence({ envToken: '   ', fileToken: 'from-file' }).token).toBe(
      'from-file',
    )
  })

  test('no sources at all signals that a token must be generated', () => {
    const r = resolveTokenPrecedence({})
    expect(r.token).toBe('')
    expect(r.apiKeys).toBe('')
    expect(r.source).toBe('none')
  })

  test('MIRA_API_KEYS follows the same env-wins rule independently', () => {
    expect(resolveTokenPrecedence({ envApiKeys: 'k1:alice', fileApiKeys: 'k2:bob' }).apiKeys).toBe(
      'k1:alice',
    )
    expect(resolveTokenPrecedence({ fileApiKeys: 'k2:bob' }).apiKeys).toBe('k2:bob')
  })

  test('token and api keys resolve independently', () => {
    const r = resolveTokenPrecedence({
      envToken: 'env-tok',
      fileToken: 'file-tok',
      fileApiKeys: 'k2:bob',
    })
    expect(r.token).toBe('env-tok')
    expect(r.apiKeys).toBe('k2:bob')
  })

  test('surrounding whitespace is trimmed', () => {
    expect(resolveTokenPrecedence({ envToken: '  tok  ' }).token).toBe('tok')
  })
})

describe('ENV_OVERRIDES_FILE_WARNING', () => {
  test('names the env var, the file, and the way to opt back into the file', () => {
    expect(ENV_OVERRIDES_FILE_WARNING).toContain('MIRA_TOKEN env differs')
    expect(ENV_OVERRIDES_FILE_WARNING).toContain('mira.env')
    expect(ENV_OVERRIDES_FILE_WARNING).toContain('Unset MIRA_TOKEN')
  })
})
