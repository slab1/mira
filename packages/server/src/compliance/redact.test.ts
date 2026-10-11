import { describe, test, expect } from 'bun:test'
import {
  containsSecret,
  isSecretKey,
  redactPayload,
  redactText,
  redactValue,
  REDACTED,
} from './redact.js'

// P3.5 compliance redaction — what survives a write to evidence stores.
// Pure unit tests: no DB, no server.

describe('secret key detection', () => {
  test('recognizes secret-ish key names across casings and separators', () => {
    for (const k of [
      'apiKey',
      'api_key',
      'API-KEY',
      'token',
      'accessToken',
      'password',
      'passwd',
      'credential',
      'authorization',
      'cookie',
      'privateKey',
      'awsSecretAccessKey',
      'client_secret',
    ]) {
      expect(isSecretKey(k)).toBe(true)
    }
  })

  test('leaves ordinary keys alone', () => {
    for (const k of [
      'command',
      'path',
      'content',
      'url',
      'sessionID',
      'keyword',
      'author',
      'name',
    ]) {
      expect(isSecretKey(k)).toBe(false)
    }
  })
})

describe('redactText', () => {
  test('masks high-signal token shapes', () => {
    const cases: Array<[string, string]> = [
      ['sk-abcdefghijklmnopqrstuvwxyz012345', 'OpenAI'],
      ['sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', 'Anthropic'],
      ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'GitHub PAT'],
      ['AKIAIOSFODNN7EXAMPLE', 'AWS'],
      ['xoxb-123456789012-abcdefghij', 'Slack'],
    ]
    for (const [token] of cases) {
      const out = redactText(`token is ${token} done`)
      expect(out).not.toContain(token)
      expect(out).toContain(REDACTED)
    }
  })

  test('masks private key blocks', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----'
    const out = redactText(pem)
    expect(out).not.toContain('MIIabc')
    expect(out).toContain(REDACTED)
  })

  test('masks bearer tokens', () => {
    const out = redactText('Authorization: Bearer abcdef0123456789xyz')
    expect(out).not.toContain('abcdef0123456789xyz')
  })

  test('masks shell/env assignment form', () => {
    const out = redactText('export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG')
    expect(out).not.toContain('wJalrXUtnFEMI')
    expect(out).toContain(REDACTED)
  })

  test('redacts PII by default', () => {
    const out = redactText('contact ada@example.com or +1 (415) 555-0132')
    expect(out).toContain('[REDACTED_EMAIL]')
    expect(out).not.toContain('ada@example.com')
  })

  test('pii:false keeps emails', () => {
    const out = redactText('mail ada@example.com', { pii: false })
    expect(out).toContain('ada@example.com')
  })

  test('truncates beyond maxChars with a marker', () => {
    const out = redactText('x'.repeat(500), { maxChars: 100 })
    expect(out.startsWith('x'.repeat(100))).toBe(true)
    expect(out).toContain('truncated')
    expect(out.length).toBeLessThan(200)
  })

  test('leaves benign text untouched', () => {
    const text = 'read the file and summarise the diff'
    expect(redactText(text)).toBe(text)
  })

  test('redaction is fast on large blobs (no catastrophic backtracking)', () => {
    // Unbounded quantifiers in the secret/PII patterns cost ~6.5s on 50KB of
    // alphanumerics before they were bounded; this guards the audit hot path.
    const blob = 'x'.repeat(50_000)
    const t0 = Date.now()
    redactText(blob, { maxChars: 4000 })
    const elapsed = Date.now() - t0
    expect(elapsed).toBeLessThan(1000)
  })

  test('still redacts env assignments inside a large blob', () => {
    const blob = `${'x'.repeat(10_000)} AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENG`
    const out = redactText(blob, { maxChars: 50_000 })
    expect(out).not.toContain('wJalrXUtnFEMIK7MDENG')
  })
})

describe('redactValue', () => {
  test('replaces secret-named keys wholesale, keeps siblings', () => {
    const out = redactValue({
      command: 'ls -la',
      apiKey: 'sk-abcdefghijklmnopqrstuvwxyz012345',
      nested: { token: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', path: '/tmp/x' },
    })
    expect(out.command).toBe('ls -la')
    expect(out.apiKey).toBe(REDACTED)
    expect(out.nested.token).toBe(REDACTED)
    expect(out.nested.path).toBe('/tmp/x')
  })

  test('walks arrays', () => {
    const out = redactValue([{ password: 'hunter2' }, { note: 'fine' }])
    expect(out[0].password).toBe(REDACTED)
    expect(out[1].note).toBe('fine')
  })

  test('passes through primitives and nullish', () => {
    expect(redactValue(null)).toBeNull()
    expect(redactValue(undefined)).toBeUndefined()
    expect(redactValue(42)).toBe(42)
    expect(redactValue(true)).toBe(true)
  })
})

describe('redactPayload', () => {
  test('reports whether anything changed', () => {
    const clean = redactPayload({ command: 'ls' })
    expect(clean.redacted).toBe(false)
    expect(JSON.parse(clean.json)).toEqual({ command: 'ls' })

    const dirty = redactPayload({ apiKey: 'sk-abcdefghijklmnopqrstuvwxyz012345' })
    expect(dirty.redacted).toBe(true)
    expect(dirty.json).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345')
  })

  test('never throws on circular structures', () => {
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular
    const out = redactPayload(circular)
    expect(typeof out.json).toBe('string')
    expect(out.redacted).toBe(true)
  })
})

describe('containsSecret', () => {
  test('detects token values and secret keys', () => {
    expect(containsSecret({ note: 'sk-abcdefghijklmnopqrstuvwxyz012345' })).toBe(true)
    expect(containsSecret({ apiKey: 'anything-at-all' })).toBe(true)
  })

  test('false for benign payloads', () => {
    expect(containsSecret({ command: 'git status', path: 'src/index.ts' })).toBe(false)
  })
})
