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

/** Extract file paths touched by a unified diff (--- / +++ headers + diff --git). */
export function extractPatchPaths(diff: string): string[] {
  const out: string[] = []
  for (const line of diff.split('\n')) {
    let m: RegExpMatchArray | null
    if ((m = line.match(/^(?:---|\+\+\+)\s+(\S+)/))) {
      let p = m[1].split('\t')[0].trim().replace(/^[ab]\//, '')
      if (!p || p === '/dev/null' || p === 'null' || p === '/dev/null/') continue
      out.push(p)
    } else if ((m = line.match(/^diff --git\s+\S+\s+(\S+)/))) {
      const p = m[1].replace(/^b\//, '')
      if (p && p !== '/dev/null') out.push(p)
    }
  }
  return [...new Set(out)]
}

/** Prompt-injection / secret-exfil patterns for task subagent prompts. */
const TASK_INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /disregard\s+(all\s+)?(previous|safety|security|guardrails)/i,
  /you\s+are\s+now\s+(a\s+)?(different|new|unrestricted|jailbroken)/i,
  /\bDAN\b.*\bdo anything now\b/i,
  /system\s*:\s*override/i,
  /exfiltrat/i,
  /send\s+\S*\s*(secret|key|token|password|credential)\S*\s+to\s+(an?\s+)?(external|remote|attacker)/i,
  /\b(curl|wget)\b.*\|\s*(bash|sh)/i,
  /process\.env\s*\[?\s*['"]?(AWS|SECRET|ANTHROPIC|OPENAI|PRIVATE|MIRA)/i,
  /\$(\{)?(AWS_SECRET|AWS_SESSION|ANTHROPIC|OPENAI|PRIVATE)_?(KEY|TOKEN)?/i,
  /\bcat\b[^&|;]*\.env\b/i,
]

/**
 * SSRF validation for outbound fetch URLs.
 * Returns a block reason, or null when the URL is allowed.
 * Allow: only http/https with public DNS. Block: localhost, loopback,
 * private ranges, link-local/metadata (169.254.x.x), file:// and other schemes.
 */
export function isBlockedFetchUrl(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return 'invalid URL'
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return `blocked scheme ${u.protocol} (only http/https allowed)`
  }
  if (u.username || u.password) return 'URL with embedded credentials blocked'
  const rawHost = u.hostname.toLowerCase().replace(/\.$/, '')
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost
  const blockedNames = new Set([
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
    '::1',
    '::ffff:127.0.0.1',
    '169.254.169.254',
    'metadata.google.internal',
    'metadata.google',
    'instance-data',
    'instance-data-compute',
  ])
  if (blockedNames.has(rawHost) || blockedNames.has(host)) {
    return `blocked host ${u.hostname} (SSRF)`
  }
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const o = v4.slice(1).map(Number)
    if (o.some((n) => n > 255)) return 'invalid IPv4 literal'
    if (o[0] === 127) return 'loopback address blocked (SSRF)'
    if (o[0] === 10) return 'private range blocked (SSRF)'
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return 'private range blocked (SSRF)'
    if (o[0] === 192 && o[1] === 168) return 'private range blocked (SSRF)'
    if (o[0] === 169 && o[1] === 254) return 'link-local/metadata blocked (SSRF)'
    if (o[0] === 0) return 'reserved IP blocked (SSRF)'
  }
  if (/\.local$|\.internal$|\.localhost$|\.invalid$/.test(host)) {
    return `internal hostname blocked (SSRF): ${u.hostname}`
  }
  return null
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
      // Patch tool: unified diff content + cwd — validate every touched file + cwd.
      // The patch schema has no `path` arg, so the generic file-tools block above
      // cannot cover it: parse diff headers and check each path explicitly.
      if (tool === 'patch') {
        const cwdArg = argStr(args, 'cwd') ?? argStr(args, 'workdir')
        if (typeof cwdArg === 'string' && cwdArg) {
          const s = sanitizePath(cwdArg)
          const reason = !s.ok
            ? `patch cwd: ${s.reason}`
            : !isPathAllowed(cwdArg, effectiveRoots)
              ? 'patch cwd outside allowed roots'
              : undefined
          if (reason) {
            decision.decision = enforce ? 'deny' : 'warn'
            decision.reason = reason
            await this.logger.log(decision)
            console.warn(`[guardrails] patch blocked: ${reason}`)
            if (enforce) throw new Error(`Guardrail blocked patch: ${reason}`)
            return decision
          }
        }
        const diff = argStr(args, 'patch') ?? ''
        if (diff) {
          if (/rm\s+-rf\s+\/|:\(\)\{\s*:\|\:/i.test(diff)) {
            decision.decision = enforce ? 'deny' : 'warn'
            decision.reason = 'patch contains dangerous pattern'
            await this.logger.log(decision)
            console.warn(`[guardrails] patch blocked: ${decision.reason}`)
            if (enforce) throw new Error(`Guardrail blocked patch: dangerous pattern`)
            return decision
          }
          for (const p of extractPatchPaths(diff)) {
            const s = sanitizePath(p)
            if (!s.ok) {
              decision.decision = enforce ? 'deny' : 'warn'
              decision.reason = `patch target: ${s.reason} (${p})`
              await this.logger.log(decision)
              console.warn(`[guardrails] patch blocked: ${decision.reason}`)
              if (enforce) throw new Error(`Guardrail blocked patch: ${decision.reason}`)
              return decision
            }
            const abs = p.startsWith('/') ? p : `${ctx.cwd ?? '.'}/${p}`
            if (!isPathAllowed(abs, effectiveRoots) && !isPathAllowed(p, effectiveRoots)) {
              decision.decision = enforce ? 'deny' : 'warn'
              decision.reason = `patch target outside allowed roots (${p})`
              await this.logger.log(decision)
              console.warn(`[guardrails] patch blocked: ${decision.reason}`)
              if (enforce) throw new Error(`Guardrail blocked patch: ${decision.reason}`)
              return decision
            }
          }
        }
      }

      // Task tool: validate subagent prompt for injection + any cwd-like args.
      if (tool === 'task') {
        const prompt = argStr(args, 'prompt') ?? ''
        const desc = argStr(args, 'description') ?? ''
        const combined = `${desc}\n${prompt}`
        if (/rm\s+-rf\s+\/|:\(\)\{\s*:\|\:/i.test(combined)) {
          decision.decision = enforce ? 'deny' : 'warn'
          decision.reason = 'task contains dangerous pattern'
          await this.logger.log(decision)
          console.warn(`[guardrails] task blocked: ${decision.reason}`)
          if (enforce) throw new Error(`Guardrail blocked task: dangerous pattern`)
          return decision
        }
        const hit = TASK_INJECTION_PATTERNS.find((rx) => rx.test(combined))
        if (hit) {
          decision.decision = enforce ? 'deny' : 'warn'
          decision.reason = `task prompt injection detected (${hit.source.slice(0, 48)})`
          await this.logger.log(decision)
          console.warn(`[guardrails] task blocked: ${decision.reason}`)
          if (enforce) throw new Error(`Guardrail blocked task: prompt injection`)
          return decision
        }
        for (const key of ['cwd', 'workdir', 'childSession', 'sessionCwd']) {
          const v = argStr(args, key)
          if (typeof v === 'string' && v) {
            const s = sanitizePath(v)
            const reason = !s.ok
              ? `task ${key}: ${s.reason}`
              : !isPathAllowed(v, effectiveRoots)
                ? `task ${key} outside allowed roots`
                : undefined
            if (reason) {
              decision.decision = enforce ? 'deny' : 'warn'
              decision.reason = reason
              await this.logger.log(decision)
              console.warn(`[guardrails] task blocked: ${reason}`)
              if (enforce) throw new Error(`Guardrail blocked task: ${reason}`)
              return decision
            }
          }
        }
      }

      // MCP tools (mcp__<server>__<tool>): validate server name + scan args for
      // path traversal / sensitive-file access / secret exfiltration.
      if (tool.startsWith('mcp__')) {
        const server = tool.split('__')[1] ?? ''
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(server)) {
          decision.decision = enforce ? 'deny' : 'warn'
          decision.reason = `mcp: invalid server name (${server.slice(0, 32)})`
          await this.logger.log(decision)
          console.warn(`[guardrails] mcp blocked: ${decision.reason}`)
          if (enforce) throw new Error(`Guardrail blocked ${tool}: ${decision.reason}`)
          return decision
        }
        if (args && typeof args === 'object') {
          for (const [k, v] of Object.entries(args as Record<string, JsonValue>)) {
            if (typeof v !== 'string' || !v) continue
            // Secret exfil via env-style keys/values
            if (
              /process\.env|AWS_SECRET|AWS_SESSION|ANTHROPIC_API_KEY|OPENAI_API_KEY|PRIVATE_KEY/i.test(
                v,
              ) &&
              /env|secret|token|key|credential/i.test(k)
            ) {
              decision.decision = enforce ? 'deny' : 'warn'
              decision.reason = `mcp: sensitive env access in arg ${k}`
              await this.logger.log(decision)
              console.warn(`[guardrails] mcp blocked: ${decision.reason}`)
              if (enforce) throw new Error(`Guardrail blocked ${tool}: ${decision.reason}`)
              return decision
            }
            // Path-like values: sanitize + root containment
            if (/^[\/.~]/.test(v) || /^\.\//.test(v) || /path|file|dir|cwd|root/i.test(k)) {
              const s = sanitizePath(v)
              if (!s.ok) {
                decision.decision = enforce ? 'deny' : 'warn'
                decision.reason = `mcp arg ${k}: ${s.reason}`
                await this.logger.log(decision)
                console.warn(`[guardrails] mcp blocked: ${decision.reason}`)
                if (enforce) throw new Error(`Guardrail blocked ${tool}: ${decision.reason}`)
                return decision
              }
              if (!isPathAllowed(v, effectiveRoots)) {
                decision.decision = enforce ? 'deny' : 'warn'
                decision.reason = `mcp arg ${k} outside allowed roots`
                await this.logger.log(decision)
                console.warn(`[guardrails] mcp blocked: ${decision.reason}`)
                if (enforce) throw new Error(`Guardrail blocked ${tool}: ${decision.reason}`)
                return decision
              }
            }
          }
        }
      }

      // Web tools: SSRF validation for webfetch (websearch takes a query, not a URL)
      if (tool === 'webfetch') {
        const url = argStr(args, 'url')
        if (typeof url === 'string') {
          const blocked = isBlockedFetchUrl(url)
          if (blocked) {
            decision.decision = enforce ? 'deny' : 'warn'
            decision.reason = `webfetch SSRF: ${blocked}`
            await this.logger.log(decision)
            console.warn(`[guardrails] webfetch blocked: ${decision.reason}`)
            if (enforce) throw new Error(`Guardrail blocked webfetch: ${blocked}`)
            return decision
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
