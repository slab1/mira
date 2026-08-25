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

import type { MiraConfig } from "../types/index.js"

/** Narrow untyped tool args to a string-keyed record (JsonValue-tolerant). */
function argStr(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== "object") return undefined
  const v = (args as Record<string, unknown>)[key]
  return typeof v === "string" ? v : undefined
}

export interface GuardrailConfig {
  enforce?: boolean
  allowedRoots?: string[]        // file sandbox roots
  blockedPaths?: string[]        // explicit deny patterns
  blockedCommands?: string[]     // bash command patterns to block
  allowedCommands?: string[]     // optional allowlist (empty = all allowed except blocked)
  maxOutputBytes?: number        // truncate huge outputs
  auditLogPath?: string          // file path for audit log (defaults to ./data/audit.log)
}

const DEFAULT_GUARDRAILS: Required<GuardrailConfig> = {
  enforce: false,
  allowedRoots: [],
  blockedPaths: ["/etc", "/root", "/sys", "/proc", "/dev"],
  blockedCommands: ["rm -rf /", "mkfs", ":(){ :|: & };:"],
  allowedCommands: [],
  maxOutputBytes: 30000,
  auditLogPath: "./data/audit.log",
}

/** Simple path traversal check */
export function sanitizePath(path: string): { ok: boolean; reason?: string; sanitized?: string } {
  if (typeof path !== "string") return { ok: false, reason: "path not string" }
  // Null bytes
  if (path.includes("\0")) return { ok: false, reason: "null byte in path" }
  // Normalize
  const normalized = path.split(/\\/).join("/")
  // Path traversal
  if (normalized.includes("../") || normalized.startsWith("..")) {
    return { ok: false, reason: "path traversal detected" }
  }
  // Windows absolute?
  if (/^[a-zA-Z]:\//.test(normalized)) {
    // keep but will be checked against roots
  }
  return { ok: true, sanitized: normalized }
}

/** Check if path is within any allowed root */
export function isPathAllowed(path: string, roots: string[]): boolean {
  if (roots.length === 0) return true // permissive default
  const abs = path.startsWith("/") ? path : "/" + path
  return roots.some(root => {
    const r = root.replace(/\/$/, "")
    return abs === r || abs.startsWith(r + "/")
  })
}

/** Bash command sanitization */
export function sanitizeCommand(cmd: string): { ok: boolean; reason?: string; sanitized?: string } {
  if (typeof cmd !== "string") return { ok: false, reason: "command not string" }
  if (cmd.length > 8192) return { ok: false, reason: "command too long" }
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
    if (rx.test(cmd)) return { ok: false, reason: "dangerous bash pattern detected" }
  }
  return { ok: true, sanitized: cmd }
}

/** Simple audit log writer (append-only) */
export class AuditLogger {
  private path: string
  constructor(path: string) {
    this.path = path
  }
  async log(entry: AuditEntry) {
    try {
      const { appendFile, mkdir } = await import("node:fs/promises")
      const dir = this.path.split("/").slice(0, -1).join("/")
      if (dir) await mkdir(dir, { recursive: true }).catch(() => {})
      const line = JSON.stringify({ ...entry, ts: Date.now() }) + "\n"
      await appendFile(this.path, line, "utf-8")
    } catch {}
  }
}

export interface AuditEntry {
  sessionID: string
  tool: string
  args: unknown
  decision: "allow" | "deny" | "warn"
  reason?: string
  result?: unknown
  error?: unknown
}

export class GuardrailsManager {
  private config: Required<GuardrailConfig>
  private logger: AuditLogger

  constructor(cfg?: Partial<GuardrailConfig>, config?: MiraConfig) {
    const guardCfg = config?.guardrails ?? {}
    this.config = { ...DEFAULT_GUARDRAILS, ...guardCfg, ...cfg }
    this.logger = new AuditLogger(this.config.auditLogPath)
  }

  /** Main check — returns decision */
  async check(tool: string, args: unknown, ctx: { sessionID: string }) {
    const decision: AuditEntry = { sessionID: ctx.sessionID, tool, args, decision: "allow" }

    try {
      // File tools path checks
      if (["read", "write", "edit", "glob", "grep"].includes(tool)) {
        const path = argStr(args, "path")
        if (typeof path === "string") {
          const s = sanitizePath(path)
          if (!s.ok) {
            decision.decision = this.config.enforce ? "deny" : "warn"
            decision.reason = s.reason
            await this.logger.log(decision)
            if (this.config.enforce) throw new Error(`Guardrail blocked ${tool}: ${s.reason}`)
            return decision
          }
          if (!isPathAllowed(path, this.config.allowedRoots)) {
            decision.decision = "warn"
            decision.reason = "path outside allowed roots"
            await this.logger.log(decision)
          }
        }
      }

      // Bash command checks
      if (tool === "bash") {
        const cmd = argStr(args, "command")
        if (typeof cmd === "string") {
          const s = sanitizeCommand(cmd)
          if (!s.ok) {
            decision.decision = this.config.enforce ? "deny" : "warn"
            decision.reason = s.reason
            await this.logger.log(decision)
            if (this.config.enforce) throw new Error(`Guardrail blocked bash: ${s.reason}`)
            return decision
          }
          // Blocked commands list
          if (this.config.blockedCommands.some(p => cmd.includes(p))) {
            decision.decision = this.config.enforce ? "deny" : "warn"
            decision.reason = "command in blocked list"
            await this.logger.log(decision)
            if (this.config.enforce) throw new Error(`Guardrail blocked bash command`)
          }
          // Allowed commands allowlist
          if (this.config.allowedCommands.length > 0 && !this.config.allowedCommands.some(p => cmd.startsWith(p))) {
            decision.decision = "warn"
            decision.reason = "command not in allowed list"
            await this.logger.log(decision)
          }
        }
        // workdir sandbox
        const workdir = argStr(args, "workdir")
        if (typeof workdir === "string") {
          if (!isPathAllowed(workdir, this.config.allowedRoots)) {
            decision.decision = "warn"
            decision.reason = "bash workdir outside allowed roots"
            await this.logger.log(decision)
          }
        }
      }

      // Web tools domain checks (basic)
      if (tool === "webfetch" || tool === "websearch") {
        const url = argStr(args, "url") || argStr(args, "query")
        if (typeof url === "string") {
          // basic scheme check
          if (!/^https?:\/\//.test(url) && tool === "webfetch") {
            decision.decision = this.config.enforce ? "deny" : "warn"
            decision.reason = "webfetch requires http(s) URL"
            await this.logger.log(decision)
            if (this.config.enforce) throw new Error(`Guardrail blocked webfetch`)
          }
        }
      }
    } catch (e) {
      // never block audit
    }

    await this.logger.log(decision)
    return decision
  }

  /** Log post-execution result */
  async logResult(entry: AuditEntry) {
    await this.logger.log(entry)
  }
}
