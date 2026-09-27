import { describe, test, expect } from 'bun:test'
import {
  classifyToolRisk,
  classifyBashArity,
  bashArityDecision,
  PermissionManager,
} from './index.js'
import type { PermissionRequest } from '../types/index.js'

describe('classifyToolRisk', () => {
  test('bash destructive command → high/destructive/irreversible', () => {
    for (const command of ['rm -rf /', 'sudo apt purge x', 'DROP TABLE users']) {
      const risk = classifyToolRisk('bash', { command })
      expect(risk).toEqual({ riskLevel: 'high', sideEffect: 'destructive', isReversible: false })
    }
  })

  test('bash read-only command → medium/none/reversible', () => {
    const risk = classifyToolRisk('bash', { command: 'ls -la' })
    expect(risk).toEqual({ riskLevel: 'medium', sideEffect: 'none', isReversible: true })
  })

  test('bash write command (non-destructive) → medium/none/reversible', () => {
    const risk = classifyToolRisk('bash', { command: 'npm install' })
    expect(risk).toEqual({ riskLevel: 'medium', sideEffect: 'none', isReversible: true })
  })

  test('bash with missing command arg → medium/none/reversible', () => {
    const risk = classifyToolRisk('bash', {})
    expect(risk).toEqual({ riskLevel: 'medium', sideEffect: 'none', isReversible: true })
  })

  test('write/edit/patch → medium/write/reversible', () => {
    for (const tool of ['write', 'edit', 'patch']) {
      expect(classifyToolRisk(tool, { path: '/x' })).toEqual({
        riskLevel: 'medium',
        sideEffect: 'write',
        isReversible: true,
      })
    }
  })

  test('read/glob/grep → low/read/reversible', () => {
    for (const tool of ['read', 'glob', 'grep']) {
      expect(classifyToolRisk(tool, { path: '/x' })).toEqual({
        riskLevel: 'low',
        sideEffect: 'read',
        isReversible: true,
      })
    }
  })

  test('unknown tool → medium/none/reversible', () => {
    expect(classifyToolRisk('mcp_firecrawl_scrape', { url: 'x' })).toEqual({
      riskLevel: 'medium',
      sideEffect: 'none',
      isReversible: true,
    })
  })

  test('tool name matching is case-insensitive', () => {
    expect(classifyToolRisk('BASH', { command: 'rm x' }).riskLevel).toBe('high')
    expect(classifyToolRisk('Read', {}).riskLevel).toBe('low')
  })
})

describe('augmentDecision (via PermissionManager.check)', () => {
  test('approvalPayload attached when action=ask AND risk high (bash rm)', async () => {
    const pm = new PermissionManager({ bash: 'ask' })
    const d = await pm.check({ sessionID: 'test-sess', tool: 'bash', args: { command: 'rm -rf build' } })
    expect(d.action).toBe('ask')
    expect(d.approvalPayload).toBeDefined()
    expect(d.approvalPayload!.whatWillChange).toBe('rm -rf build')
    expect(d.approvalPayload!.blastRadius).toBe('bash')
    expect(d.approvalPayload!.canUndo).toBe(false)
  })

  test('no approvalPayload when action=ask but risk not high/destructive (edit)', async () => {
    const pm = new PermissionManager({ edit: 'ask' })
    const d = await pm.check({ sessionID: 'test-sess', tool: 'edit', args: { path: 'src/a.ts' } })
    expect(d.action).toBe('ask')
    expect(d.risk).toEqual({ riskLevel: 'medium', sideEffect: 'write', isReversible: true })
    expect(d.approvalPayload).toBeUndefined()
  })

  test('no approvalPayload when risk high but action != ask (explicit allow)', async () => {
    const pm = new PermissionManager({ bash: 'allow' })
    const d = await pm.check({ sessionID: 'test-sess', tool: 'bash', args: { command: 'rm -rf build' } })
    expect(d.action).toBe('allow')
    expect(d.risk!.riskLevel).toBe('high')
    expect(d.approvalPayload).toBeUndefined()
  })

  test('canUndo reflects isReversible (deny on destructive bash still carries risk)', async () => {
    const pm = new PermissionManager({ bash: 'deny' })
    const d = await pm.check({ sessionID: 'test-sess', tool: 'bash', args: { command: 'sudo rm -rf /' } })
    expect(d.action).toBe('deny')
    expect(d.risk!.isReversible).toBe(false)
  })

  test('PermissionDecision fields (action, reason, matchedPattern, arity) preserved through augmentation', async () => {
    const pm = new PermissionManager({ edit: { 'src/secret/*': 'deny', '*': 'allow' } })
    const deny = await pm.check({ sessionID: 'test-sess', tool: 'edit', args: { path: 'src/secret/key.txt' } })
    expect(deny.action).toBe('deny')
    expect(deny.matchedPattern).toBe('src/secret/*')
    expect(deny.reason).toContain('src/secret/*')
    expect(deny.risk).toBeDefined()

    // arity preserved when BashArity layer falls through (ask + destructive)
    const pm2 = new PermissionManager({})
    const arity = await pm2.check({ sessionID: 'test-sess', tool: 'bash', args: { command: 'rm -rf x' } })
    expect(arity.action).toBe('ask')
    expect(arity.arity).toBe(2)
    expect(arity.reason).toContain('BashArity')
    expect(arity.approvalPayload).toBeDefined()
  })
})

describe('classifyBashArity / bashArityDecision', () => {
  test('read-only level 0 auto-allow', () => {
    expect(classifyBashArity('git status').level).toBe(0)
    const d = bashArityDecision('ls -la')
    expect(d.action).toBe('allow')
    expect(d.arity).toBe(0)
  })

  test('write level 1 → ask', () => {
    const d = bashArityDecision('npm install')
    expect(d.action).toBe('ask')
    expect(d.arity).toBe(1)
  })

  test('destructive level 2 → ask with warning reason', () => {
    const d = bashArityDecision('rm -rf node_modules')
    expect(d.action).toBe('ask')
    expect(d.arity).toBe(2)
    expect(d.reason).toContain('destructive')
  })

  test('unknown command defaults to level 1 (ask)', () => {
    expect(classifyBashArity('someunknownbin --flag').level).toBe(1)
  })
})

describe('PermissionManager end-to-end (5 layers)', () => {
  test('explicit deny rule wins', async () => {
    const pm = new PermissionManager({ bash: 'deny' })
    const d = await pm.check({ sessionID: 'test-sess', tool: 'bash', args: { command: 'ls' } })
    expect(d.action).toBe('deny')
    expect(d.reason).toContain('explicit')
  })

  test('explicit allow rule wins', async () => {
    const pm = new PermissionManager({ read: 'allow' })
    const d = await pm.check({ sessionID: 'test-sess', tool: 'read', args: { path: '/etc/passwd' } })
    expect(d.action).toBe('allow')
  })

  test('wildcard key rule matches (mcp_*)', async () => {
    const pm = new PermissionManager({ 'mcp_*': 'ask' })
    const d = await pm.check({ sessionID: 'test-sess', tool: 'mcp_firecrawl_scrape', args: {} })
    expect(d.action).toBe('ask')
    expect(d.reason).toContain('explicit')
  })

  test('pattern record matched against command/path value', async () => {
    const pm = new PermissionManager({ bash: { 'git *': 'allow', '*': 'ask' } })
    const allow = await pm.check({ sessionID: 'test-sess', tool: 'bash', args: { command: 'git push' } })
    expect(allow.action).toBe('allow')
    expect(allow.matchedPattern).toBe('git *')
    const ask = await pm.check({ sessionID: 'test-sess', tool: 'bash', args: { command: 'make clean' } })
    expect(ask.action).toBe('ask')
  })

  test('BashArity fallback when no rule for bash', async () => {
    const pm = new PermissionManager({ read: 'allow' })
    const d = await pm.check({ sessionID: 'test-sess', tool: 'bash', args: { command: 'ls' } })
    expect(d.action).toBe('allow')
    expect(d.arity).toBe(0)
  })

  test('explicit bash rule overrides BashArity', async () => {
    const pm = new PermissionManager({ bash: 'deny' })
    const d = await pm.check({ sessionID: 'test-sess', tool: 'bash', args: { command: 'ls' } })
    expect(d.action).toBe('deny')
    expect(d.arity).toBeUndefined()
  })

  test('default ask when nothing matches', async () => {
    const pm = new PermissionManager({})
    const d = await pm.check({ sessionID: 'test-sess', tool: 'webfetch' as PermissionRequest['tool'], args: {} })
    expect(d.action).toBe('ask')
    expect(d.reason).toContain('default ask')
    expect(d.approvalPayload).toBeUndefined()
  })

  test('global "*" wildcard rule used before default ask', async () => {
    const pm = new PermissionManager({ '*': 'allow' })
    const d = await pm.check({ sessionID: 'test-sess', tool: 'webfetch' as PermissionRequest['tool'], args: {} })
    expect(d.action).toBe('allow')
  })

  test('setRules updates config at runtime', async () => {
    const pm = new PermissionManager({ bash: 'deny' })
    pm.setRules({ bash: 'allow' })
    const d = await pm.check({ sessionID: 'test-sess', tool: 'bash', args: { command: 'ls' } })
    expect(d.action).toBe('allow')
    expect(pm.listRules()).toEqual({ bash: 'allow' })
  })
})
