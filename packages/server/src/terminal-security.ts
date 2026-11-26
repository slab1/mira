import { realpathSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { Role } from './auth/roles.js'

export function terminalRoleAllowed(role: Role): boolean {
  return role === 'operator' || role === 'admin'
}

/** Interactive persistent shells cannot be safely command-allowlisted through a persistent shell. */
export function terminalExecutionAllowed(sandboxed: boolean): boolean {
  return !sandboxed
}

export const DEFAULT_SANDBOX_ALLOWED_COMMANDS = [
  'ls',
  'cat',
  'grep',
  'find',
  'git',
  'bun',
  'node',
  'tsc',
  'echo',
  'pwd',
  'head',
  'tail',
  'wc',
  'sort',
  'uniq',
  'date',
  'which',
  'whoami',
  'printf',
] as const

export const SANDBOX_BUILTINS = new Set(['cd', 'pwd', 'clear', 'help', 'exit'])

export const DISALLOWED_SHELL_BINARIES = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'csh',
  'tcsh',
  'ash',
  'cmd',
  'cmd.exe',
  'powershell',
  'pwsh',
])

export type SandboxedCommandParseResult =
  | { ok: true; kind: 'noop' }
  | { ok: true; kind: 'builtin'; cmd: string; args: string[] }
  | { ok: true; kind: 'exec'; cmd: string; args: string[]; allowed: string[] }
  | { ok: false; error: string }

const UNQUOTED_META_CHARS = new Set([';', '|', '&', '`', '$', '<', '>', '(', ')'])

function tokenizeSandboxedLine(line: string): { ok: true; tokens: string[] } | { ok: false; error: string } {
  const tokens: string[] = []
  let current = ''
  let inToken = false
  let quote: '"' | "'" | null = null

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (quote === "'") {
      if (ch === "'") {
        quote = null
      } else {
        current += ch
      }
      continue
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null
      } else if (ch === '\\' && i + 1 < line.length) {
        current += line[++i]!
      } else {
        current += ch
      }
      continue
    }

    if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(current)
        current = ''
        inToken = false
      }
      continue
    }

    if (ch === '#' && !inToken) {
      break
    }

    if (UNQUOTED_META_CHARS.has(ch)) {
      return {
        ok: false,
        error: `sandbox: shell operator "${ch}" is not allowed in sandboxed mode`,
      }
    }

    if (ch === "'" || ch === '"') {
      quote = ch
      inToken = true
      continue
    }

    if (ch === '\\') {
      if (i + 1 >= line.length) {
        return { ok: false, error: 'sandbox: trailing backslash in command' }
      }
      current += line[++i]!
      inToken = true
      continue
    }

    current += ch
    inToken = true
  }

  if (quote !== null) {
    return { ok: false, error: 'sandbox: unterminated quote in command' }
  }
  if (inToken) tokens.push(current)
  return { ok: true, tokens }
}

function blockedSandboxFlags(cmd: string, args: string[]): string | null {
  if (cmd === 'find') {
    for (const a of args) {
      if (a === '-exec' || a === '-execdir' || a === '-ok' || a === '-okdir' || a === '-delete') {
        return `sandbox: flag "${a}" is not allowed for find in sandboxed mode`
      }
    }
  }
  if (cmd === 'node' || cmd === 'bun') {
    for (const a of args) {
      if (
        a === '-e' ||
        a === '--eval' ||
        a === '-p' ||
        a === '--print' ||
        a === '-r' ||
        a === '--require' ||
        a === '--preload'
      ) {
        return `sandbox: flag "${a}" is not allowed for ${cmd} in sandboxed mode`
      }
    }
  }
  if (cmd === 'git') {
    for (const a of args) {
      if (
        a === '-c' ||
        a.startsWith('--exec-path') ||
        a.startsWith('--upload-pack') ||
        a.startsWith('--receive-pack')
      ) {
        return `sandbox: flag "${a}" is not allowed for git in sandboxed mode`
      }
    }
  }
  return null
}

/**
 * Parse and validate one sandboxed command line for direct non-shell execution
 * (`Bun.spawn([cmd, ...args])`). Never invokes a shell interpreter.
 */
export function parseSandboxedCommand(
  rawLine: string,
  configuredAllowed?: readonly string[],
): SandboxedCommandParseResult {
  const trimmed = rawLine.replace(/[\r\n]+$/, '').trim()
  if (!trimmed) return { ok: true, kind: 'noop' }
  if (/[\r\n]/.test(trimmed)) {
    return { ok: false, error: 'sandbox: multi-line commands are not allowed' }
  }

  const tokRes = tokenizeSandboxedLine(trimmed)
  if (!tokRes.ok) return tokRes
  if (tokRes.tokens.length === 0) return { ok: true, kind: 'noop' }

  const [cmd, ...args] = tokRes.tokens
  if (!cmd) return { ok: true, kind: 'noop' }
  if (cmd.includes('/') || cmd.includes('\\')) {
    return { ok: false, error: `sandbox: path-qualified command "${cmd}" is not allowed` }
  }

  if (SANDBOX_BUILTINS.has(cmd)) {
    return { ok: true, kind: 'builtin', cmd, args }
  }

  const baseList = configuredAllowed?.length ? configuredAllowed : DEFAULT_SANDBOX_ALLOWED_COMMANDS
  const effectiveAllowed = baseList.filter(
    (entry) =>
      typeof entry === 'string' &&
      entry.length > 0 &&
      !entry.includes('/') &&
      !entry.includes('\\') &&
      !DISALLOWED_SHELL_BINARIES.has(entry.toLowerCase()),
  )

  if (DISALLOWED_SHELL_BINARIES.has(cmd.toLowerCase()) || !effectiveAllowed.includes(cmd)) {
    return {
      ok: false,
      error: `sandbox: command "${cmd}" not in allowedCommands [${effectiveAllowed.join(', ')}] — blocked`,
    }
  }

  const flagErr = blockedSandboxFlags(cmd, args)
  if (flagErr) return { ok: false, error: flagErr }

  return { ok: true, kind: 'exec', cmd, args, allowed: effectiveAllowed }
}

/** Resolve `cd` inside `workspaceRoot` using realpath containment. */
export function resolveSandboxCwd(
  workspaceRoot: string,
  currentCwd: string,
  targetArg?: string,
): { ok: true; cwd: string } | { ok: false; error: string } {
  try {
    const realRoot = realpathSync(workspaceRoot)
    const candidate = targetArg ? resolve(currentCwd, targetArg) : realRoot
    const realTarget = realpathSync(candidate)
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
      return { ok: false, error: 'sandbox: cannot change directory outside workspace root' }
    }
    if (!statSync(realTarget).isDirectory()) {
      return { ok: false, error: `sandbox: not a directory: ${targetArg ?? candidate}` }
    }
    return { ok: true, cwd: realTarget }
  } catch (e) {
    return {
      ok: false,
      error: `sandbox: cd failed: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}
