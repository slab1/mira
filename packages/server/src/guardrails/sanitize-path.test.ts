import { describe, test, expect } from 'bun:test'
import { sanitizePath } from './index.js'

describe('sanitizePath — encoding bypass (review #4, #27)', () => {
  test('blocks double-encoded traversal %252e%252e%252f', () => {
    const r = sanitizePath('%252e%252e%252f')
    expect(r.ok).toBe(false)
  })

  test('blocks single-encoded traversal %2e%2e%2f', () => {
    const r = sanitizePath('%2e%2e%2f')
    expect(r.ok).toBe(false)
  })

  test('blocks mixed encoding ..%2f..%2fetc%2fpasswd', () => {
    const r = sanitizePath('..%2f..%2fetc%2fpasswd')
    expect(r.ok).toBe(false)
  })

  test('blocks triple-encoded traversal %25252e%25252e%25252f', () => {
    const r = sanitizePath('%25252e%25252e%25252f')
    expect(r.ok).toBe(false)
  })

  test('blocks encoded backslash %255c%255c (double-encoded ..\\)', () => {
    const r = sanitizePath('%255c%255c..%255c..%255cetc')
    expect(r.ok).toBe(false)
  })

  test('allows normal absolute path', () => {
    const r = sanitizePath('/normal/path/file.txt')
    expect(r.ok).toBe(true)
  })

  test('allows normal relative path', () => {
    const r = sanitizePath('src/index.ts')
    expect(r.ok).toBe(true)
  })

  test('blocks null byte injection', () => {
    const r = sanitizePath('/path\0/etc/passwd')
    expect(r.ok).toBe(false)
  })

  test('blocks sensitive file /etc/passwd', () => {
    const r = sanitizePath('/etc/passwd')
    expect(r.ok).toBe(false)
  })

  test('blocks sensitive file .ssh', () => {
    const r = sanitizePath('/project/.ssh/id_rsa')
    expect(r.ok).toBe(false)
  })
})
