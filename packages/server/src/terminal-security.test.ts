import { describe, expect, test } from 'bun:test'
import { terminalExecutionAllowed, terminalRoleAllowed } from './terminal-security.js'

describe('terminal security policy', () => {
  test('viewer role is denied while operator and admin are accepted', () => {
    expect(terminalRoleAllowed('viewer')).toBe(false)
    expect(terminalRoleAllowed('operator')).toBe(true)
    expect(terminalRoleAllowed('admin')).toBe(true)
  })

  test('sandboxed persistent-shell terminal fails closed', () => {
    expect(terminalExecutionAllowed(true)).toBe(false)
    expect(terminalExecutionAllowed(false)).toBe(true)
  })
})
