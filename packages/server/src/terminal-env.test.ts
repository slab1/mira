import { describe, expect, test } from 'bun:test'

/**
 * Regression test for the terminal env scrubber (index.ts terminalEnv).
 *
 * The interactive bash pty must NOT receive the full process.env — a user
 * typing `env`/`printenv` would leak MIRA_TOKEN and any *_API_KEY / *_TOKEN /
 * *_SECRET / *_PASSWORD / *_CREDENTIAL. This replicates the filter exactly as
 * in index.ts (same pattern as middleware/cors.test.ts, since importing
 * index.ts triggers module-level side effects).
 */

const SECRET_ENV_RE = /(API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/i
function terminalEnv(source: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue
    if (k === 'MIRA_TOKEN' || SECRET_ENV_RE.test(k)) continue
    env[k] = v
  }
  env.TERM = 'xterm-256color'
  return env
}

describe('terminalEnv secret scrubber', () => {
  test('strips MIRA_TOKEN and secret-shaped keys', () => {
    const env = terminalEnv({
      MIRA_TOKEN: 'mira-secret',
      OPENROUTER_API_KEY: 'sk-abc',
      NVIDIA_API_KEY: 'nv-xyz',
      FIRECRAWL_API_KEY: 'fc-123',
      TAVILY_API_KEY: 'tv-456',
      GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_789',
      SLACK_BOT_TOKEN: 'xoxb-000',
      DB_PASSWORD: 'pw',
      AWS_CREDENTIAL: 'cred',
      MCP_SECRET: 's3cr3t',
    })
    expect(env.MIRA_TOKEN).toBeUndefined()
    expect(env.OPENROUTER_API_KEY).toBeUndefined()
    expect(env.NVIDIA_API_KEY).toBeUndefined()
    expect(env.FIRECRAWL_API_KEY).toBeUndefined()
    expect(env.TAVILY_API_KEY).toBeUndefined()
    expect(env.GITHUB_PERSONAL_ACCESS_TOKEN).toBeUndefined()
    expect(env.SLACK_BOT_TOKEN).toBeUndefined()
    expect(env.DB_PASSWORD).toBeUndefined()
    expect(env.AWS_CREDENTIAL).toBeUndefined()
    expect(env.MCP_SECRET).toBeUndefined()
  })

  test('keeps non-secret env so git/bun still work', () => {
    const env = terminalEnv({
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/home/user',
      SHELL: '/bin/bash',
      LANG: 'en_US.UTF-8',
      GIT_AUTHOR_NAME: 'Mira',
      BUN_INSTALL: '/home/user/.bun',
      MIRA_TERMINAL_ENABLED: '1',
    })
    expect(env.PATH).toBe('/usr/local/bin:/usr/bin:/bin')
    expect(env.HOME).toBe('/home/user')
    expect(env.SHELL).toBe('/bin/bash')
    expect(env.LANG).toBe('en_US.UTF-8')
    expect(env.GIT_AUTHOR_NAME).toBe('Mira')
    expect(env.BUN_INSTALL).toBe('/home/user/.bun')
    expect(env.MIRA_TERMINAL_ENABLED).toBe('1')
  })

  test('forces TERM=xterm-256color and skips undefined values', () => {
    const env = terminalEnv({ TERM: 'dumb', UNDEFINED_VAR: undefined, PATH: '/bin' })
    expect(env.TERM).toBe('xterm-256color')
    expect(env.UNDEFINED_VAR).toBeUndefined()
    expect(env.PATH).toBe('/bin')
  })
})
