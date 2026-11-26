import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseSandboxedCommand,
  resolveSandboxCwd,
  terminalExecutionAllowed,
  terminalRoleAllowed,
} from './terminal-security.js'

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

  test('parseSandboxedCommand permits safe allowlisted commands and parses quotes', () => {
    expect(parseSandboxedCommand('  git status -s  ')).toEqual({
      ok: true,
      kind: 'exec',
      cmd: 'git',
      args: ['status', '-s'],
      allowed: expect.arrayContaining(['git', 'bun']),
    })
    expect(parseSandboxedCommand('grep "hello world" src/index.ts')).toEqual({
      ok: true,
      kind: 'exec',
      cmd: 'grep',
      args: ['hello world', 'src/index.ts'],
      allowed: expect.arrayContaining(['grep']),
    })
    expect(parseSandboxedCommand('cd packages/web')).toEqual({
      ok: true,
      kind: 'builtin',
      cmd: 'cd',
      args: ['packages/web'],
    })
  })

  test('parseSandboxedCommand blocks shell operators, shells, paths, and dangerous flags', () => {
    expect(parseSandboxedCommand('ls; rm -rf /').ok).toBe(false)
    expect(parseSandboxedCommand('ls | cat').ok).toBe(false)
    expect(parseSandboxedCommand('echo $(whoami)').ok).toBe(false)
    expect(parseSandboxedCommand('bash -c "id"').ok).toBe(false)
    expect(parseSandboxedCommand('/bin/ls').ok).toBe(false)
    expect(parseSandboxedCommand('rm -rf .').ok).toBe(false)
    expect(parseSandboxedCommand('node -e "process.exit(1)"').ok).toBe(false)
    expect(parseSandboxedCommand('find . -exec sh {} ;').ok).toBe(false)
    expect(parseSandboxedCommand('git -c core.fsmonitor=evil status').ok).toBe(false)
    expect(parseSandboxedCommand('bash', ['bash', 'ls']).ok).toBe(false)
  })

  test('resolveSandboxCwd keeps cd inside workspace root', () => {
    const root = mkdtempSync(join(tmpdir(), 'mira-term-cwd-'))
    try {
      const sub = join(root, 'sub')
      mkdirSync(sub)
      const okSub = resolveSandboxCwd(root, root, 'sub')
      expect(okSub.ok).toBe(true)
      const escaped = resolveSandboxCwd(root, root, '..')
      expect(escaped.ok).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
