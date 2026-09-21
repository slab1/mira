import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  loadConfig,
  getConfig,
  saveConfig,
  removeMcpFromConfig,
  removeProviderFromConfig,
  getLoopLimits,
  resetConfigCache,
} from './index.js'

let testDir: string

beforeEach(() => {
  resetConfigCache()
  testDir = mkdtempSync(join(tmpdir(), 'mira-config-test-'))
})

afterEach(() => {
  try {
    rmSync(testDir, { recursive: true, force: true })
  } catch {}
})

describe('loadConfig', () => {
  test('returns defaults when no mira.json exists', async () => {
    const config = await loadConfig(testDir)
    expect(config).toBeDefined()
    expect(config.model).toBeDefined()
    expect(config.provider).toBeDefined()
    expect(config.mcp).toBeDefined()
  })

  test('loads from mira.json and merges with defaults', async () => {
    writeFileSync(join(testDir, 'mira.json'), JSON.stringify({ model: 'custom-model-xyz' }))
    const config = await loadConfig(testDir)
    expect(config.model).toBe('custom-model-xyz')
    // Should still have provider defaults
    expect(config.provider).toBeDefined()
    expect(config.provider.anthropic).toBeDefined()
  })

  test('deep-merges permission section', async () => {
    writeFileSync(join(testDir, 'mira.json'), JSON.stringify({ permission: { bash: 'allow' } }))
    const config = await loadConfig(testDir)
    expect(config.permission).toBeDefined()
    expect((config.permission as Record<string, string>).bash).toBe('allow')
  })

  test('deep-merges mcp section', async () => {
    writeFileSync(
      join(testDir, 'mira.json'),
      JSON.stringify({
        mcp: {
          myserver: { type: 'local', command: ['node', 'server.js'], enabled: true },
        },
      }),
    )
    const config = await loadConfig(testDir)
    expect(config.mcp.myserver).toBeDefined()
    // Should still have default MCP servers
    expect(config.mcp.firecrawl).toBeDefined()
  })

  test('loads from .mira/config.json as fallback', async () => {
    const miraDir = join(testDir, '.mira')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(miraDir, { recursive: true })
    writeFileSync(join(miraDir, 'config.json'), JSON.stringify({ model: 'from-mira-dir' }))
    const config = await loadConfig(testDir)
    expect(config.model).toBe('from-mira-dir')
  })
})

describe('getConfig', () => {
  test('returns cached config after loadConfig', async () => {
    await loadConfig(testDir)
    const config = getConfig()
    expect(config).toBeDefined()
    expect(config.model).toBeDefined()
  })

  test('returns defaults if loadConfig not called', () => {
    // getConfig should not throw even if no prior loadConfig
    const config = getConfig()
    expect(config).toBeDefined()
  })
})

describe('saveConfig', () => {
  test('writes patch to mira.json and invalidates cache', async () => {
    const result = await saveConfig({ model: 'saved-model' }, 'project', testDir)
    expect(result.model).toBe('saved-model')
    // File should exist
    const { readFileSync } = await import('node:fs')
    const written = JSON.parse(readFileSync(join(testDir, 'mira.json'), 'utf-8'))
    expect(written.model).toBe('saved-model')
  })

  test('deep-merges with existing file content', async () => {
    writeFileSync(
      join(testDir, 'mira.json'),
      JSON.stringify({ model: 'existing-model', debug: true }),
    )
    await saveConfig({ smallModel: 'small-v2' }, 'project', testDir)
    const { readFileSync } = await import('node:fs')
    const written = JSON.parse(readFileSync(join(testDir, 'mira.json'), 'utf-8'))
    expect(written.model).toBe('existing-model') // preserved
    expect(written.smallModel).toBe('small-v2') // added
    expect(written.debug).toBe(true) // preserved
  })

  test('saves to local layer in .mira/local.json', async () => {
    await saveConfig({ model: 'local-model' }, 'local', testDir)
    const { readFileSync } = await import('node:fs')
    const written = JSON.parse(readFileSync(join(testDir, '.mira', 'local.json'), 'utf-8'))
    expect(written.model).toBe('local-model')
  })

  test('created config is reloadable', async () => {
    await saveConfig({ model: 'reloadable' }, 'project', testDir)
    const config = await loadConfig(testDir)
    expect(config.model).toBe('reloadable')
  })
})

describe('removeMcpFromConfig', () => {
  test('removes MCP server from config', async () => {
    writeFileSync(
      join(testDir, 'mira.json'),
      JSON.stringify({
        mcp: {
          myserver: { type: 'local', command: ['node', 's.js'], enabled: true },
          other: { type: 'remote', url: 'https://example.com', enabled: true },
        },
      }),
    )
    await removeMcpFromConfig('myserver', testDir)
    const { readFileSync } = await import('node:fs')
    const written = JSON.parse(readFileSync(join(testDir, 'mira.json'), 'utf-8'))
    expect(written.mcp.myserver).toBeUndefined()
    expect(written.mcp.other).toBeDefined()
  })

  test('no-op when MCP name not in config', async () => {
    writeFileSync(
      join(testDir, 'mira.json'),
      JSON.stringify({ mcp: { existing: { type: 'local', command: [], enabled: true } } }),
    )
    await removeMcpFromConfig('nonexistent', testDir)
    const { readFileSync } = await import('node:fs')
    const written = JSON.parse(readFileSync(join(testDir, 'mira.json'), 'utf-8'))
    expect(written.mcp.existing).toBeDefined()
  })
})

describe('removeProviderFromConfig', () => {
  test('removes provider from config', async () => {
    writeFileSync(
      join(testDir, 'mira.json'),
      JSON.stringify({
        provider: {
          openrouter: {
            name: 'OR',
            options: { baseURL: 'x', apiKey: 'k', headers: {} },
            models: {},
          },
          custom: {
            name: 'Custom',
            options: { baseURL: 'y', apiKey: 'k', headers: {} },
            models: {},
          },
        },
      }),
    )
    await removeProviderFromConfig('custom', testDir)
    const { readFileSync } = await import('node:fs')
    const written = JSON.parse(readFileSync(join(testDir, 'mira.json'), 'utf-8'))
    expect(written.provider.custom).toBeUndefined()
    expect(written.provider.openrouter).toBeDefined()
  })

  test('no-op when provider name not in config', async () => {
    writeFileSync(
      join(testDir, 'mira.json'),
      JSON.stringify({
        provider: {
          openrouter: {
            name: 'OR',
            options: { baseURL: 'x', apiKey: 'k', headers: {} },
            models: {},
          },
        },
      }),
    )
    await removeProviderFromConfig('nonexistent', testDir)
    const { readFileSync } = await import('node:fs')
    const written = JSON.parse(readFileSync(join(testDir, 'mira.json'), 'utf-8'))
    expect(written.provider.openrouter).toBeDefined()
  })
})

describe('getLoopLimits', () => {
  test('returns defaults when no config', () => {
    const limits = getLoopLimits()
    expect(limits.maxSteps).toBeGreaterThan(0)
    expect(limits.contextLimit).toBeGreaterThan(0)
    expect(limits.compactionThreshold).toBeGreaterThan(0)
    expect(limits.compactionThreshold).toBeLessThanOrEqual(1)
    expect(typeof limits.smallModel).toBe('string')
  })

  test('respects loop config from file', async () => {
    writeFileSync(
      join(testDir, 'mira.json'),
      JSON.stringify({
        loop: {
          maxSteps: 10,
          contextLimit: 64000,
          compactionThreshold: 0.5,
          smallModel: 'test-model',
        },
      }),
    )
    await loadConfig(testDir)
    const limits = getLoopLimits()
    expect(limits.maxSteps).toBe(10)
    expect(limits.contextLimit).toBe(64000)
    expect(limits.compactionThreshold).toBe(0.5)
    expect(limits.smallModel).toBe('test-model')
  })

  test('handles string contextLimit like "128k"', async () => {
    writeFileSync(join(testDir, 'mira.json'), JSON.stringify({ loop: { contextLimit: '256k' } }))
    await loadConfig(testDir)
    const limits = getLoopLimits()
    expect(limits.contextLimit).toBe(256_000)
  })
})

describe('config validation warnings', () => {
  let warns: string[]
  const origWarn = console.warn

  beforeEach(() => {
    warns = []
    console.warn = (...args: unknown[]) => warns.push(args.map(String).join(' '))
  })
  afterEach(() => {
    console.warn = origWarn
  })

  test('malformed JSON → warning + defaults loaded', async () => {
    writeFileSync(join(testDir, 'mira.json'), '{ broken json !!!')
    const config = await loadConfig(testDir)
    // Should still return defaults
    expect(config).toBeDefined()
    expect(config.model).toBeDefined()
    // Should have warned about JSON parse error
    const jsonWarn = warns.find((w) => w.includes('invalid JSON'))
    expect(jsonWarn).toBeDefined()
    expect(jsonWarn).toContain('mira.json')
  })

  test('unknown top-level keys → warning', async () => {
    writeFileSync(
      join(testDir, 'mira.json'),
      JSON.stringify({ model: 'test', moedl: 'typo', provder: 'typo2' }),
    )
    await loadConfig(testDir)
    const keyWarns = warns.filter((w) => w.includes('unknown key'))
    expect(keyWarns.length).toBeGreaterThanOrEqual(2)
    expect(keyWarns.some((w) => w.includes('moedl'))).toBe(true)
    expect(keyWarns.some((w) => w.includes('provder'))).toBe(true)
  })

  test('bad MCP config → warnings for missing type/command/url', async () => {
    writeFileSync(
      join(testDir, 'mira.json'),
      JSON.stringify({
        mcp: {
          noType: { command: ['node'] },
          localNoCmd: { type: 'local' },
          remoteNoUrl: { type: 'remote' },
          badType: { type: 'docker' },
        },
      }),
    )
    await loadConfig(testDir)
    const mcpWarns = warns.filter((w) => w.includes('mcp.'))
    expect(mcpWarns.length).toBeGreaterThanOrEqual(3)
    expect(mcpWarns.some((w) => w.includes('noType') && w.includes('missing'))).toBe(true)
    expect(mcpWarns.some((w) => w.includes('localNoCmd') && w.includes('command'))).toBe(true)
    expect(mcpWarns.some((w) => w.includes('remoteNoUrl') && w.includes('url'))).toBe(true)
  })

  test('bad provider config → warnings', async () => {
    writeFileSync(
      join(testDir, 'mira.json'),
      JSON.stringify({
        provider: {
          bad: {
            npm: 123,
            options: { baseURL: true, timeout: -5 },
          },
        },
      }),
    )
    await loadConfig(testDir)
    const provWarns = warns.filter((w) => w.includes('provider.bad'))
    expect(provWarns.length).toBeGreaterThanOrEqual(2)
  })

  test('bad agent config → warnings', async () => {
    writeFileSync(
      join(testDir, 'mira.json'),
      JSON.stringify({
        agents: {
          noSystem: { description: 'missing system' },
          badPerm: { system: 'prompt', permissions: 'superadmin' },
        },
      }),
    )
    await loadConfig(testDir)
    const agentWarns = warns.filter((w) => w.includes('agents.'))
    expect(agentWarns.length).toBeGreaterThanOrEqual(2)
    expect(agentWarns.some((w) => w.includes('noSystem') && w.includes('system'))).toBe(true)
    expect(agentWarns.some((w) => w.includes('badPerm') && w.includes('permissions'))).toBe(true)
  })

  test('bad loop config → warnings', async () => {
    writeFileSync(
      join(testDir, 'mira.json'),
      JSON.stringify({
        loop: { maxSteps: -1, compactionThreshold: 5 },
      }),
    )
    await loadConfig(testDir)
    const loopWarns = warns.filter((w) => w.includes('loop.'))
    expect(loopWarns.length).toBeGreaterThanOrEqual(1)
  })

  test('bad theme → warning', async () => {
    writeFileSync(join(testDir, 'mira.json'), JSON.stringify({ theme: 'rainbow' }))
    await loadConfig(testDir)
    const themeWarn = warns.find((w) => w.includes('theme') && w.includes('rainbow'))
    expect(themeWarn).toBeDefined()
  })

  test('bad features → warnings', async () => {
    writeFileSync(
      join(testDir, 'mira.json'),
      JSON.stringify({ features: { injectTodos: 'yes', enforce: 1 } }),
    )
    await loadConfig(testDir)
    const featWarns = warns.filter((w) => w.includes('features.'))
    expect(featWarns.length).toBeGreaterThanOrEqual(1)
  })

  test('valid config → no warnings', async () => {
    writeFileSync(
      join(testDir, 'mira.json'),
      JSON.stringify({
        model: 'openrouter/test',
        loop: { maxSteps: 16, contextLimit: 64000, compactionThreshold: 0.7 },
        mcp: { myserver: { type: 'local', command: ['node', 's.js'] } },
      }),
    )
    await loadConfig(testDir)
    const configWarns = warns.filter((w) => w.includes('config issue'))
    expect(configWarns.length).toBe(0)
  })

  test('config loads with defaults despite bad JSON', async () => {
    writeFileSync(join(testDir, 'mira.json'), 'not json at all {{{')
    const config = await loadConfig(testDir)
    expect(config).toBeDefined()
    expect(config.provider).toBeDefined()
    expect(config.model).toBeDefined()
  })
})

describe('auto-generate mira.json from example', () => {
  test('creates mira.json from mira.json.example when no config exists', async () => {
    // Copy example to test dir
    const exampleSrc = join(process.cwd(), 'mira.json.example')
    if (!existsSync(exampleSrc)) return // skip if example not found
    copyFileSync(exampleSrc, join(testDir, 'mira.json.example'))

    const miraPath = join(testDir, 'mira.json')
    expect(existsSync(miraPath)).toBe(false)

    const config = await loadConfig(testDir)

    // mira.json should now exist
    expect(existsSync(miraPath)).toBe(true)
    // Should have loaded the config from the generated file
    expect(config).toBeDefined()
    expect(config.model).toBeDefined()
    // Verify the generated file has the example content
    const written = JSON.parse(readFileSync(miraPath, 'utf-8'))
    expect(written.model).toBe('openrouter/anthropic/claude-sonnet-4')
  })

  test('does not overwrite existing mira.json', async () => {
    writeFileSync(join(testDir, 'mira.json'), JSON.stringify({ model: 'my-custom-model' }))
    // Also create example
    writeFileSync(join(testDir, 'mira.json.example'), JSON.stringify({ model: 'example-model' }))

    const config = await loadConfig(testDir)
    expect(config.model).toBe('my-custom-model')
  })

  test('no example → no mira.json created, uses defaults', async () => {
    const miraPath = join(testDir, 'mira.json')
    expect(existsSync(miraPath)).toBe(false)

    const config = await loadConfig(testDir)
    expect(existsSync(miraPath)).toBe(false)
    expect(config).toBeDefined()
    expect(config.model).toBeDefined()
  })
})
