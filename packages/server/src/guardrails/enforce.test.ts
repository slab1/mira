import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  GuardrailsManager,
  isEnforceEnabled,
  isProductionEnvironment,
  parseEnforceEnv,
  getEffectiveEnforce,
  warnIfEnforcementOffInProduction,
} from './index.js'

const ENV_KEYS = ['NODE_ENV', 'HOST', 'MIRA_STRICT_AUTH', 'MIRA_GUARDRAILS_ENFORCE'] as const
let saved: Record<string, string | undefined>
let auditPath: string

function clearProdEnv() {
  for (const k of ENV_KEYS) delete process.env[k]
}

beforeEach(() => {
  saved = {}
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  clearProdEnv()
  auditPath = join(mkdtempSync(join(tmpdir(), 'mira-guard-')), 'audit.log')
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('guardrails prod-default enforcement (P0-3)', () => {
  test('prod-default-on: NODE_ENV=production enforces without explicit config', async () => {
    process.env.NODE_ENV = 'production'
    expect(isProductionEnvironment()).toBe(true)
    expect(parseEnforceEnv()).toBeUndefined()
    expect(isEnforceEnabled()).toBe(true)
    expect(getEffectiveEnforce()).toBe(true)
    const g = new GuardrailsManager({ auditLogPath: auditPath })
    const d = await g.check('read', { path: '../evil' }, { sessionID: 'prod-default' })
    expect(d.decision).toBe('deny')
  })

  test('explicit env opt-out wins over prod default (MIRA_GUARDRAILS_ENFORCE=0)', async () => {
    process.env.NODE_ENV = 'production'
    process.env.MIRA_GUARDRAILS_ENFORCE = '0'
    expect(isEnforceEnabled()).toBe(false)
    expect(getEffectiveEnforce()).toBe(false)
    const g = new GuardrailsManager({ auditLogPath: auditPath })
    const d = await g.check('read', { path: '../evil' }, { sessionID: 'env-optout' })
    expect(d.decision).toBe('warn')
  })

  test('explicit config opt-out wins over prod default (enforce:false)', async () => {
    process.env.NODE_ENV = 'production'
    const g = new GuardrailsManager({ enforce: false, auditLogPath: auditPath })
    const d = await g.check('read', { path: '../evil' }, { sessionID: 'cfg-optout' })
    expect(d.decision).toBe('warn')
  })

  test('dev unchanged: fail-open with warn when not production', async () => {
    process.env.NODE_ENV = 'development'
    expect(isProductionEnvironment()).toBe(false)
    expect(isEnforceEnabled()).toBe(false)
    const g = new GuardrailsManager({ auditLogPath: auditPath })
    const d = await g.check('read', { path: '../evil' }, { sessionID: 'dev-open' })
    expect(d.decision).toBe('warn')
  })

  test('boot warns (never silent) when enforcement is off in production', () => {
    process.env.NODE_ENV = 'production'
    const lines: string[] = []
    const orig = console.warn
    console.warn = (...a: unknown[]) => {
      lines.push(a.map(String).join(' '))
    }
    try {
      warnIfEnforcementOffInProduction(false)
      expect(lines.length).toBe(1)
      expect(lines[0]).toMatch(/guardrails/i)
      lines.length = 0
      warnIfEnforcementOffInProduction(true)
      expect(lines.length).toBe(0)
    } finally {
      console.warn = orig
    }
  })
})
