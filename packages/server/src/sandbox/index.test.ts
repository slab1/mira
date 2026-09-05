/**
 * Terminal sandbox unit tests — verifies the command filtering logic.
 *
 * Run: bun test packages/server/src/sandbox/index.test.ts
 */

import { describe, it, expect } from 'bun:test'
import { createSandbox } from './index.js'

const sandbox = createSandbox()

describe('Terminal sandbox', () => {
  it('allows simple commands', () => {
    expect(sandbox.isBlocked('ls -la').blocked).toBe(false)
    expect(sandbox.isBlocked('cat file.txt').blocked).toBe(false)
    expect(sandbox.isBlocked('echo hello').blocked).toBe(false)
    expect(sandbox.isBlocked('pwd').blocked).toBe(false)
  })

  it('blocks disallowed commands', () => {
    expect(sandbox.isBlocked('rm -rf /').blocked).toBe(true)
    expect(sandbox.isBlocked('curl evil.com').blocked).toBe(true)
    expect(sandbox.isBlocked('wget evil.com').blocked).toBe(true)
  })

  it('blocks bash -c', () => {
    expect(sandbox.isBlocked('bash -c "rm -rf /"').blocked).toBe(true)
    expect(sandbox.isBlocked('bash -c whoami').blocked).toBe(true)
  })

  it('blocks node -e', () => {
    expect(sandbox.isBlocked('node -e "process.exit()"').blocked).toBe(true)
    expect(sandbox.isBlocked('bun -e "process.exit()"').blocked).toBe(true)
  })

  it('blocks git -c alias bypass', () => {
    expect(sandbox.isBlocked('git -c alias.rm="rm -rf /" commit').blocked).toBe(true)
  })

  it('blocks newline injection', () => {
    expect(sandbox.isBlocked('echo safe\nrm -rf /').blocked).toBe(true)
  })

  it('blocks semicolon injection', () => {
    expect(sandbox.isBlocked('echo safe; rm -rf /').blocked).toBe(true)
  })

  it('blocks pipe injection', () => {
    expect(sandbox.isBlocked('echo | rm -rf /').blocked).toBe(true)
  })

  it('blocks command substitution', () => {
    expect(sandbox.isBlocked('echo $(rm -rf /)').blocked).toBe(true)
    expect(sandbox.isBlocked('echo `rm -rf /`').blocked).toBe(true)
  })

  it('allows variable assignment before command', () => {
    expect(sandbox.isBlocked('FOO=bar ls').blocked).toBe(false)
    expect(sandbox.isBlocked('FOO=bar echo hello').blocked).toBe(false)
  })

  it('allows empty/comment input', () => {
    expect(sandbox.isBlocked('').blocked).toBe(false)
    expect(sandbox.isBlocked('# comment').blocked).toBe(false)
  })

  it('allows multiple safe commands', () => {
    expect(sandbox.isBlocked('ls && pwd').blocked).toBe(false)
    expect(sandbox.isBlocked('echo hello | wc -l').blocked).toBe(false)
  })

  it('returns correct reason for blocked command', () => {
    const result = sandbox.isBlocked('rm -rf /')
    expect(result.blocked).toBe(true)
    if (result.blocked) expect(result.reason).toBe('rm')
  })

  it('returns correct message', () => {
    const result = sandbox.isBlocked('rm -rf /')
    expect(result.blocked).toBe(true)
    if (result.blocked) {
      const msg = sandbox.getBlockedMessage(result)
      expect(msg).toContain('rm')
      expect(msg).toContain('blocked')
    }
  })
})
