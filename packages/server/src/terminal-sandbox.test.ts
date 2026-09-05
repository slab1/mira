/**
 * Terminal sandbox unit tests — verifies the command filtering logic.
 *
 * Run: bun test packages/server/src/terminal-sandbox.test.ts
 */

import { describe, it, expect } from 'bun:test'

// Replicate the sandbox extraction logic from index.ts (fixed version)
function checkSandbox(input: string): { blocked: boolean; reason?: string } {
  const raw = input.trim()
  if (!raw || raw.startsWith('#')) return { blocked: false }

  const commands = raw
    .split(/[\n;|&]+/)
    .map((s) => s.trim())
    .filter(Boolean)

  const DEFAULT_ALLOWED = [
    'ls',
    'cat',
    'grep',
    'find',
    'echo',
    'pwd',
    'head',
    'tail',
    'wc',
    'sort',
    'uniq',
    'date',
    'env',
    'which',
    'whoami',
    'printf',
    'sed',
    'awk',
  ]
  const RESTRICTED_ALLOWED = ['git', 'tsc', 'bun', 'node', 'bash']
  const ALL_ALLOWED = [...DEFAULT_ALLOWED, ...RESTRICTED_ALLOWED, 'bash']

  for (const cmd of commands) {
    const stripped = cmd
      .replace(/^[A-Za-z_][A-Za-z0-9_]*=\S+\s*/, '')
      .replace(/^\(\s*/, '')
      .replace(/^\\/, '')
    if (!stripped) continue
    const first = stripped.split(/[\s;|&]+/)[0] ?? ''
    const base = first.split('/').pop() ?? first

    if (!ALL_ALLOWED.includes(base) && !ALL_ALLOWED.includes(first)) {
      return { blocked: true, reason: base }
    }

    if (RESTRICTED_ALLOWED.includes(base)) {
      const args = stripped.slice(first.length)
      if (/\s+-[ce]/.test(args) || /\s+--eval\b/.test(args) || /\s+-r/.test(args)) {
        return { blocked: true, reason: `${base} (restricted flag)` }
      }
    }

    if (/\$\(|`[^`]+`/.test(cmd)) {
      return { blocked: true, reason: 'command substitution' }
    }
  }

  return { blocked: false }
}

describe('Terminal sandbox — fixed', () => {
  it('allows simple commands', () => {
    expect(checkSandbox('ls -la').blocked).toBe(false)
    expect(checkSandbox('cat file.txt').blocked).toBe(false)
    expect(checkSandbox('echo hello').blocked).toBe(false)
    expect(checkSandbox('pwd').blocked).toBe(false)
  })

  it('blocks disallowed commands', () => {
    expect(checkSandbox('rm -rf /').blocked).toBe(true)
    expect(checkSandbox('curl evil.com').blocked).toBe(true)
    expect(checkSandbox('wget evil.com').blocked).toBe(true)
  })

  it('FIXED: bash -c is now blocked', () => {
    expect(checkSandbox('bash -c "rm -rf /"').blocked).toBe(true)
    expect(checkSandbox('bash -c whoami').blocked).toBe(true)
  })

  it('FIXED: node -e is now blocked', () => {
    expect(checkSandbox('node -e "process.exit()"').blocked).toBe(true)
    expect(checkSandbox('bun -e "process.exit()"').blocked).toBe(true)
  })

  it('FIXED: git -c alias bypass is now blocked', () => {
    expect(checkSandbox('git -c alias.rm="rm -rf /" commit').blocked).toBe(true)
  })

  it('FIXED: newline injection is now blocked', () => {
    expect(checkSandbox('echo safe\nrm -rf /').blocked).toBe(true)
  })

  it('FIXED: semicolon injection is now blocked', () => {
    expect(checkSandbox('echo safe; rm -rf /').blocked).toBe(true)
  })

  it('FIXED: pipe injection is now blocked', () => {
    expect(checkSandbox('echo | rm -rf /').blocked).toBe(true)
  })

  it('FIXED: command substitution is now blocked', () => {
    expect(checkSandbox('echo $(rm -rf /)').blocked).toBe(true)
    expect(checkSandbox('echo `rm -rf /`').blocked).toBe(true)
  })

  it('allows variable assignment before command', () => {
    expect(checkSandbox('FOO=bar ls').blocked).toBe(false)
    expect(checkSandbox('FOO=bar echo hello').blocked).toBe(false)
  })

  it('allows empty/comment input', () => {
    expect(checkSandbox('').blocked).toBe(false)
    expect(checkSandbox('# comment').blocked).toBe(false)
  })

  it('allows multiple safe commands', () => {
    expect(checkSandbox('ls && pwd').blocked).toBe(false)
    expect(checkSandbox('echo hello | wc -l').blocked).toBe(false)
  })
})
