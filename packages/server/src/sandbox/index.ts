/**
 * Terminal Sandbox — command filtering for interactive PTY sessions.
 *
 * Separated from terminal transport to enforce security policy independently.
 * The sandbox inspects every `terminal.input` event and only forwards commands
 * that pass the allowlist + restricted-flag checks.
 *
 * Usage:
 *   const sandbox = createSandbox({ allowedCommands: [...] })
 *   if (sandbox.isBlocked(input)) { send error } else { forward to PTY }
 */

import type { MiraConfig, JsonValue } from '../types/index.js'
import { getConfig } from '../config/index.js'

export interface SandboxConfig {
  /** Explicit allowlist. If empty, uses DEFAULT_ALLOWED. */
  allowedCommands?: string[]
}

export interface BlockResult {
  blocked: true
  reason: string
}

export interface AllowResult {
  blocked: false
}

export type CheckResult = BlockResult | AllowResult

// Commands that are always available (read-only / safe)
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

// Commands allowed but restricted from shell escapes (-c, -e, -r, --eval)
const RESTRICTED_FLAGS = ['git', 'tsc', 'bun', 'node', 'bash']

export function createSandbox(config: SandboxConfig = {}) {
  const allowed = config.allowedCommands?.length
    ? config.allowedCommands
    : [...DEFAULT_ALLOWED, ...RESTRICTED_FLAGS]

  function isBlocked(input: string): CheckResult {
    const raw = input.trim()
    if (!raw || raw.startsWith('#')) return { blocked: false }

    // Split on newlines + shell operators to check ALL commands
    const commands = raw
      .split(/[\n;|&]+/)
      .map((s) => s.trim())
      .filter(Boolean)

    for (const cmd of commands) {
      // Strip variable assignments (CMD=val), leading parens, leading backslash
      const stripped = cmd
        .replace(/^[A-Za-z_][A-Za-z0-9_]*=\S+\s*/, '')
        .replace(/^\(\s*/, '')
        .replace(/^\\/, '')
      if (!stripped) continue

      const first = stripped.split(/[\s;|&]+/)[0] ?? ''
      const base = first.split('/').pop() ?? first

      // Check if base command is allowed
      if (!allowed.includes(base) && !allowed.includes(first)) {
        return { blocked: true, reason: base }
      }

      // Block shell escapes for restricted commands (bash -c, node -e, git -c)
      if (RESTRICTED_FLAGS.includes(base)) {
        const args = stripped.slice(first.length)
        if (/\s+-[ce]/.test(args) || /\s+--eval\b/.test(args) || /\s+-r/.test(args)) {
          return { blocked: true, reason: `${base} (restricted flag)` }
        }
      }

      // Block command substitution and backticks
      if (/\$\(|`[^`]+`/.test(cmd)) {
        return { blocked: true, reason: 'command substitution' }
      }
    }

    return { blocked: false }
  }

  function getBlockedMessage(result: BlockResult): string {
    return `sandbox: "${result.reason}" blocked by allowedCommands policy\n`
  }

  return { isBlocked, getBlockedMessage, allowed }
}

/** Load sandbox config from mira.json → tools.terminal */
export function loadSandboxConfig(): SandboxConfig {
  try {
    const cfg = getConfig() as MiraConfig
    const t = (cfg.tools as Record<string, JsonValue> | undefined)?.terminal as
      Record<string, JsonValue> | undefined
    const list = t?.allowedCommands as string[] | undefined
    return Array.isArray(list) ? { allowedCommands: list } : {}
  } catch {
    return {}
  }
}
