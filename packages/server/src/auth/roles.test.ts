import { describe, test, expect } from 'bun:test'
import { parseKeyPair, roleForOwner, roleAtLeast, isRole, type Role } from './roles.js'

describe('parseKeyPair (MIRA_API_KEYS=key:owner[:role])', () => {
  test('two segments — backward compatible, no role', () => {
    const p = parseKeyPair('abc123:alice')
    expect(p).toEqual({ key: 'abc123', owner: 'alice', role: undefined })
  })

  test('three segments — role parsed', () => {
    const p = parseKeyPair('abc123:alice:viewer')
    expect(p).toEqual({ key: 'abc123', owner: 'alice', role: 'viewer' })
  })

  test('trailing segment that is not a role stays part of the owner', () => {
    // owner with a colon in its name — the tail is not a role keyword
    const p = parseKeyPair('abc123:team:frontend')
    expect(p).toEqual({ key: 'abc123', owner: 'team:frontend', role: undefined })
  })

  test('admin role parsed', () => {
    expect(parseKeyPair('k:boss:admin').role).toBe('admin')
    expect(parseKeyPair('k:boss:admin').owner).toBe('boss')
  })

  test('no colon — degenerate pair keys itself', () => {
    const p = parseKeyPair('justakey')
    expect(p.owner).toBe('justakey')
    expect(p.role).toBeUndefined()
  })
})

describe('roleForOwner', () => {
  const roles = new Map<string, Role>([
    ['alice', 'viewer'],
    ['boss', 'admin'],
  ])

  test("'default' owner is always admin", () => {
    expect(roleForOwner('default', roles)).toBe('admin')
    expect(roleForOwner('default', new Map())).toBe('admin')
  })

  test('explicit roles win', () => {
    expect(roleForOwner('alice', roles)).toBe('viewer')
    expect(roleForOwner('boss', roles)).toBe('admin')
  })

  test('unknown owners default to operator', () => {
    expect(roleForOwner('unknown', roles)).toBe('operator')
    expect(roleForOwner(undefined, roles)).toBe('operator')
  })
})

describe('roleAtLeast + isRole', () => {
  test('ranking: viewer < operator < admin', () => {
    expect(roleAtLeast('viewer', 'viewer')).toBe(true)
    expect(roleAtLeast('viewer', 'operator')).toBe(false)
    expect(roleAtLeast('operator', 'viewer')).toBe(true)
    expect(roleAtLeast('admin', 'operator')).toBe(true)
    expect(roleAtLeast('operator', 'admin')).toBe(false)
  })

  test('isRole validates keywords', () => {
    expect(isRole('viewer')).toBe(true)
    expect(isRole('operator')).toBe(true)
    expect(isRole('admin')).toBe(true)
    expect(isRole('superuser')).toBe(false)
    expect(isRole('')).toBe(false)
  })
})
