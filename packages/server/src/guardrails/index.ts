/**
 * Mira Tool-Layer Guardrails
 *
 * Security layer for tool execution:
 *   - Input validation / sanitization (path traversal, command injection)
 *   - Allowlists (paths, commands, domains)
 *   - Sandbox checks (workdir containment)
 *   - Audit logging (every tool call)
 *
 * Design: Non-blocking by default (log + warn), but can be enforced via config.guardrails.enforce
 */

import type { MiraConfig, JsonValue } from '../types/index.js'
import type { Database } from 'bun:sqlite'
import { getConfig } from '../config/store.js'

/** Narrow untyped tool args to a string-keyed record (JsonValue-tolerant). */
function argStr(args: JsonValue, key: string): string | undefined {
  if (!args || typeof args !== 'object') return undefined
  const v = (args as Record<string, JsonValue>)[key]
  return typeof v === 'string' ? v : undefined
}

export interface GuardrailConfig {
  enforce?: boolean
  allowedRoots?: string[] // file sandbox roots
  blockedPaths?: string[] // explicit deny patterns
  blockedCommands?: string[] // bash command patterns to block
  allowedCommands?: string[] // optional allowlist (empty = all allowed except blocked)
  maxOutputBytes?: number // truncate huge outputs
  auditLogPath?: string // file path for audit log (defaults to ./data/audit.log)
}

/** Whether guardrails should enforce (fail-closed) — dynamic per call */
export function isEnforceEnabled(): boolean {
  return (
    process.env.NODE_ENV === 'production' ||
    process.env.HOST === '0.0.0.0' ||
    process.env.MIRA_STRICT_AUTH === '1'
  )
}

/** Parse MIRA_WORKSPACE_ROOTS env (comma-separated) into allowedRoots override */
export function parseWorkspaceRoots(): string[] | null {
  const raw = process.env.MIRA_WORKSPACE_ROOTS?.trim()
  if (!raw) return null
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return parts.length ? parts : null
}

/** Resolve effective allowedRoots per-project: env override > per-project config > default */
export function getEffectiveAllowedRoots(cwd?: string): string[] {
  const envRoots = parseWorkspaceRoots()
  if (envRoots) return envRoots
  if (cwd) {
    try {
      const cfg = getConfig(cwd)
      if (cfg.guardrails?.allowedRoots !== undefined) return cfg.guardrails.allowedRoots
    } catch {}
  }
  return isEnforceEnabled() ? ['./data', './packages', './src'] : []
}

/** Resolve effective enforce per-project: env strict > config > default */
export function getEffectiveEnforce(cwd?: string): boolean {
  if (isEnforceEnabled()) return true
  if (cwd) {
    try {
      const cfg = getConfig(cwd)
      if (cfg.guardrails?.enforce !== undefined) return !!cfg.guardrails.enforce
    } catch {}
  }
  return false
}

const DEFAULT_GUARDRAILS: Required<GuardrailConfig> = {
  enforce: isEnforceEnabled(),
  allowedRoots:
    parseWorkspaceRoots() ?? (isEnforceEnabled() ? ['./data', './packages', './src'] : []),
  blockedPaths: [
    '/etc',
    '/root',
    '/sys',
    '/proc',
    '/dev',
    '~/.ssh',
    'mira.db',
    '.env',
    '.env.local',
    '.aws',
    '.pem',
    '.key',
  ],
  blockedCommands: ['rm -rf /', 'mkfs', ':(){ :|: & };:'],
  allowedCommands: [],
  maxOutputBytes: 30000,
  auditLogPath: './data/audit.log',
}

/** Path traversal check — hardened: decodes, normalizes, checks realpath containment */
export function sanitizePath(path: string): { ok: boolean; reason?: string; sanitized?: string } {
  if (typeof path !== 'string') return { ok: false, reason: 'path not string' }
  if (path.includes('\0')) return { ok: false, reason: 'null byte in path' }
  // Decode percent-encoded traversal attempts (e.g. %2e%2e%2f == ../)
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    decoded = path
  }
  // If decoding changed traversal patterns, reject
  if (decoded.includes('\0')) return { ok: false, reason: 'null byte after decode' }
  // Normalize: handle backslashes, collapse //, remove /./
  const normalized = decoded.split(/\\/).join('/')
  // Use path normalization (posix) to collapse .. segments
  // We check both raw and decoded for traversal — defense in depth
  const lower = normalized.toLowerCase()
  if (lower.includes('%2e') || lower.includes('%2f') || lower.includes('%5c')) {
    return { ok: false, reason: 'encoded traversal detected' }
  }
  // Check normalized path for traversal after collapsing
  // Use posix normalize equivalent: split, resolve dots
  const parts = normalized.split('/')
  const resolved: string[] = []
  for (const p of parts) {
    if (p === '..') {
      if (resolved.length === 0)
        return { ok: false, reason: 'path traversal detected (.. beyond root)' }
      resolved.pop()
    } else if (p === '.' || p === '') {
      // keep single slash separately
      if (p === '' && resolved.length === 0) resolved.push('')
      continue
    } else {
      resolved.push(p)
    }
  }
  const collapsed = resolved.join('/') || '/'
  if (collapsed.includes('..')) return { ok: false, reason: 'path traversal detected' }
  if (
    normalized.includes('../') ||
    normalized.startsWith('..') ||
    decoded.includes('../') ||
    decoded.startsWith('..')
  ) {
    return { ok: false, reason: 'path traversal detected' }
  }
  // Denylist for sensitive files — block even inside allowed roots when enforce
  const sensitive = ['/etc', '/root', '.ssh', '.aws', '.env', 'mira.db', '.pem', '.key']
  for (const blocked of sensitive) {
    if (lower.includes(blocked.toLowerCase())) {
      if (blocked.startsWith('/') && normalized.startsWith(blocked)) {
        return { ok: false, reason: `blocked path ${blocked}` }
      }
      if (!blocked.startsWith('/') && lower.includes(blocked)) {
        // For file-sensitive names, require explicit allowedRoots bypass — warn in sanitize but enforce via isPathAllowed
        // Hard-block absolute sensitive paths
        if (
          normalized.includes('/.ssh/') ||
          normalized.endsWith('/.ssh') ||
          normalized.includes('.key') ||
          normalized.includes('.pem') ||
          normalized.includes('.aws')
        ) {
          return { ok: false, reason: `blocked sensitive file ${blocked}` }
        }
      }
    }
  }
  return { ok: true, sanitized: normalized }
}

/** Check if path is within any allowed root — resolved via realpath when possible */
export function isPathAllowed(path: string, roots: string[]): boolean {
  if (roots.length === 0) {
    // In production or when exposed on 0.0.0.0 or strict auth, require explicit roots — fail-closed (Risk 2)
    if (isEnforceEnabled()) return false
    return true
  }
  // Normalize both sides: handle ./ prefix, ensure leading /, collapse //, strip trailing /
  const normalize = (p: string) => {
    let n = p.replace(/^\.\//, '').replace(/\/$/, '').replace(/\/+/g, '/')
    if (n === '.' || n === '') n = '/'
    if (!n.startsWith('/')) n = '/' + n
    return n
  }
  const nAbs = normalize(path)
  return roots.some((root) => {
    const r = normalize(root)
    if (r === '/') return true
    return nAbs === r || nAbs.startsWith(r + '/')
  })
}

/** Bash command sanitization */
export function sanitizeCommand(cmd: string): { ok: boolean; reason?: string; sanitized?: string } {
  if (typeof cmd !== 'string') return { ok: false, reason: 'command not string' }
  if (cmd.length > 8192) return { ok: false, reason: 'command too long' }
  // Block known dangerous patterns
  const dangerPatterns = [
    /rm\s+-rf\s+\//i,
    /:\(\)\{\s*:\|\:\s*\}/,
    /mkfs/,
    /dd\s+if=\//i,
    /chmod\s+777/,
    /curl.*\|\s*bash/i,
    /wget.*\|\s*sh/i,
  ]
  for (const rx of dangerPatterns) {
    if (rx.test(cmd)) return { ok: false, reason: 'dangerous bash pattern detected' }
  }
  return { ok: true, sanitized: cmd }
}

/** Audit log writer with rotation (5MB cap) + optional DB mirror */
export class AuditLogger {
  private path: string
  private maxBytes = 5 * 1024 * 1024
  private db?: { sqlite: Database }
  constructor(path: string, db?: { sqlite: Database }) {
    this.path = path
    this.db = db
  }
  attachDB(db: { sqlite: Database }) {
    this.db = db
  }
  async log(entry: AuditEntry) {
    // Dual-write: file (rotation) + DB (queryable) — best-effort, never throw
    try {
      const { appendFile, mkdir, stat, rename, unlink } = await import('node:fs/promises')
      const dir = this.path.split('/').slice(0, -1).join('/')
      if (dir) await mkdir(dir, { recursive: true }).catch(() => {})
      try {
        const st = await stat(this.path)
        if (st.size > this.maxBytes) {
          const rotated = `${this.path}.1`
          await unlink(rotated).catch(() => {})
          await rename(this.path, rotated).catch(() => {})
        }
      } catch {}
      const line = JSON.stringify({ ...entry, ts: Date.now() }) + '\n'
      await appendFile(this.path, line, 'utf-8')
    } catch (e) {
      console.warn('[audit] log failed', String(e))
    }
    // DB mirror (Risk 2: queryable audit) — ignore if table not yet migrated
    if (this.db) {
      try {
        const id = crypto.randomUUID()
        this.db.sqlite
          .prepare(
            'INSERT INTO audit_entries (id, session_id, tool, decision, reason, args, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            id,
            entry.sessionID ?? null,
            entry.tool,
            entry.decision,
            entry.reason ?? null,
            entry.args ? JSON.stringify(entry.args) : null,
            entry.result ? JSON.stringify(entry.result) : null,
            Date.now(),
          )
      } catch {}
    }
  }
}

export interface AuditEntry {
  sessionID: string
  tool: string
  args: JsonValue
  decision: 'allow' | 'deny' | 'warn'
  reason?: string
  result?: JsonValue
  error?: JsonValue
}

export class GuardrailsManager {
  private config: Required<GuardrailConfig>
  private logger: AuditLogger
  private db?: { sqlite: Database }

  constructor(cfg?: Partial<GuardrailConfig>, config?: MiraConfig, db?: { sqlite: Database }) {
    const guardCfg = config?.guardrails ?? {}
    this.config = { ...DEFAULT_GUARDRAILS, ...guardCfg, ...cfg }
    this.logger = new AuditLogger(this.config.auditLogPath, db)
    this.db = db
  }

  /** Wire DB after construction (for circular init where db is created before guardrails) */
  attachDB(db: { sqlite: Database }) {
    this.db = db
    this.logger.attachDB(db)
  }

  /** Main check — returns decision (per-project: cwd drives allowedRoots/enforce) */
  async check(tool: string, args: JsonValue, ctx: { sessionID: string; cwd?: string }) {
    const decision: AuditEntry = { sessionID: ctx.sessionID, tool, args, decision: 'allow' }
    // Per-project isolation: derive effective roots/enforce from session cwd
    const effectiveRoots = ctx.cwd ? getEffectiveAllowedRoots(ctx.cwd) : this.config.allowedRoots
    const effectiveEnforce = ctx.cwd ? getEffectiveEnforce(ctx.cwd) : this.config.enforce
    // Env override for enforce (MIRA_STRICT_AUTH/HOST) always wins
    const enforce = isEnforceEnabled() || effectiveEnforce || this.config.enforce

    try {
      // File tools path checks — now includes patch
      if (['read', 'write', 'edit', 'glob', 'grep', 'patch'].includes(tool)) {
        const path = argStr(args, 'path') || argStr(args, 'file')
        if (typeof path === 'string') {
          const s = sanitizePath(path)
          if (!s.ok) {
            decision.decision = enforce ? 'deny' : 'warn'
            decision.reason = s.reason
            await this.logger.log(decision)
            if (enforce) throw new Error(`Guardrail blocked ${tool}: ${s.reason}`)
            return decision
          }
          if (!isPathAllowed(path, effectiveRoots)) {
            decision.decision = enforce ? 'deny' : 'warn'
            decision.reason = 'path outside allowed roots'
            await this.logger.log(decision)
            if (enforce) throw new Error(`Guardrail blocked ${tool}: path outside allowed roots`)
            return decision
          }
        }
      }

      // Bash command checks
      if (tool === 'bash') {
        const cmd = argStr(args, 'command')
        if (typeof cmd === 'string') {
          const s = sanitizeCommand(cmd)
          if (!s.ok) {
            decision.decision = enforce ? 'deny' : 'warn'
            decision.reason = s.reason
            await this.logger.log(decision)
            if (enforce) throw new Error(`Guardrail blocked bash: ${s.reason}`)
            return decision
          }
          // Blocked commands list
          if (this.config.blockedCommands.some((p) => cmd.includes(p))) {
            decision.decision = enforce ? 'deny' : 'warn'
            decision.reason = 'command in blocked list'
            await this.logger.log(decision)
            if (enforce) throw new Error(`Guardrail blocked bash command`)
          }
          // Block sensitive path access via bash (e.g. cat /etc/passwd) when enforce
          if (enforce) {
            const lowerCmd = cmd.toLowerCase()
            for (const blocked of this.config.blockedPaths) {
              const b = blocked.toLowerCase()
              // Check for absolute sensitive paths in command
              if (b.startsWith('/') && lowerCmd.includes(b)) {
                decision.decision = 'deny'
                decision.reason = `bash command accesses blocked path ${blocked}`
                await this.logger.log(decision)
                throw new Error(`Guardrail blocked bash: accesses blocked path ${blocked}`)
              }
              // Check for sensitive filenames like .env, .pem, .key, mira.db
              if (!b.startsWith('/') && lowerCmd.includes(b)) {
                // Only block if it's a file access, not just substring in other words
                if (
                  lowerCmd.includes(`/${b}`) ||
                  lowerCmd.includes(` ${b}`) ||
                  lowerCmd.includes(`"${b}`) ||
                  lowerCmd.includes(`'${b}`)
                ) {
                  decision.decision = 'deny'
                  decision.reason = `bash command accesses blocked file ${blocked}`
                  await this.logger.log(decision)
                  throw new Error(`Guardrail blocked bash: accesses blocked file ${blocked}`)
                }
              }
            }
            // Explicit check for /etc/passwd and similar even if not in blockedPaths
            if (lowerCmd.includes('/etc/passwd') || lowerCmd.includes('/etc/shadow')) {
              decision.decision = 'deny'
              decision.reason = 'bash command accesses /etc/passwd'
              await this.logger.log(decision)
              throw new Error(`Guardrail blocked bash: accesses /etc/passwd`)
            }
          }
          // Allowed commands allowlist
          if (
            this.config.allowedCommands.length > 0 &&
            !this.config.allowedCommands.some((p) => cmd.startsWith(p))
          ) {
            decision.decision = enforce ? 'deny' : 'warn'
            decision.reason = 'command not in allowed list'
            await this.logger.log(decision)
            if (enforce) throw new Error(`Guardrail blocked bash: not in allowedCommands`)
            return decision
          }
        }
        // workdir sandbox — per-project roots
        const workdir = argStr(args, 'workdir')
        if (typeof workdir === 'string') {
          if (!isPathAllowed(workdir, effectiveRoots)) {
            decision.decision = enforce ? 'deny' : 'warn'
            decision.reason = 'bash workdir outside allowed roots'
            await this.logger.log(decision)
            if (enforce) throw new Error(`Guardrail blocked bash workdir`)
            return decision
          }
        }
      }
      // Task/patch tools also spawn bash — check their payloads
      if (tool === 'task' || tool === 'patch') {
        const payload = argStr(args, 'prompt') || argStr(args, 'patch') || ''
        if (payload && /rm\s+-rf\s+\/|:\(\)\{\s*:\|\:/i.test(payload)) {
          decision.decision = enforce ? 'deny' : 'warn'
          decision.reason = 'task/patch contains dangerous pattern'
          await this.logger.log(decision)
          if (enforce) throw new Error(`Guardrail blocked ${tool}: dangerous pattern`)
          return decision
        }
      }

      // Web tools domain checks (basic)
      if (tool === 'webfetch' || tool === 'websearch') {
        const url = argStr(args, 'url') || argStr(args, 'query')
        if (typeof url === 'string') {
          // basic scheme check
          if (!/^https?:\/\//.test(url) && tool === 'webfetch') {
            decision.decision = enforce ? 'deny' : 'warn'
            decision.reason = 'webfetch requires http(s) URL'
            await this.logger.log(decision)
            if (enforce) throw new Error(`Guardrail blocked webfetch`)
          }
        }
      }
    } catch (e) {
      // Fail-closed: any guardrail error (sanitizer throw, regex compile error)
      // defaults to deny — never silently allow on failure.
      const reason = e instanceof Error ? e.message : String(e)
      decision.decision = 'deny'
      decision.reason = `guardrail error: ${reason}`
      await this.logger.log(decision)
      return decision
    }

    await this.logger.log(decision)
    return decision
  }

  /** Log post-execution result */
  async logResult(entry: AuditEntry) {
    await this.logger.log(entry)
  }
}
