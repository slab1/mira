/**
 * Mira Patching — Security
 *
 * Scans for vulnerabilities, prompt injection, secrets, and permission risks.
 * Used by Detector (pain point #9) and Patcher (security hardening patches).
 *
 * Layers:
 *  1. Prompt injection detection in user input / tool results
 *  2. Secrets scan (API keys, tokens in diffs/files)
 *  3. Path traversal / command injection in tool args
 *  4. Permission boundary checks
 */

// ── Types ──────────────────────────────────────────────────────────

export type SecuritySeverity = "low" | "medium" | "high" | "critical"
export type SecurityKind =
  | "prompt-injection"
  | "secrets-exposure"
  | "path-traversal"
  | "command-injection"
  | "permission-bypass"
  | "ssrf"
  | "xss"

export interface SecurityIssue {
  id: string
  kind: SecurityKind
  severity: SecuritySeverity
  detail: string
  evidence: string   // truncated snippet
  suggestion: string
  detectedAt: number
}

import type { JsonValue } from "../types/index.js"

/** Narrow untyped tool args to a string-keyed record (JsonValue-tolerant). */
function argStr(args: JsonValue, key: string): string | undefined {
  if (!args || typeof args !== "object") return undefined
  const v = (args as Record<string, JsonValue>)[key]
  return typeof v === "string" ? v : undefined
}

export interface SecurityScanResult {
  issues: SecurityIssue[]
  passed: boolean
  scannedAt: number
}

export interface SecurityScannerConfig {
  /** block on high/critical only (default true) — medium/low are warnings */
  strict?: boolean
}

// ── Patterns ───────────────────────────────────────────────────────

const INJECTION_PATTERNS: Array<{ re: RegExp; detail: string }> = [
  { re: /ignore (all )?previous instructions/i, detail: "Prompt injection: ignore previous instructions" },
  { re: /system\s*:\s*you are now/i, detail: "Prompt injection: role hijack" },
  { re: /disregard.*(policy|rules|guidelines)/i, detail: "Prompt injection: policy override attempt" },
  { re: /\[SYSTEM\]/i, detail: "Prompt injection: fake system tag" },
  { re: /jailbreak|DAN mode|do anything now/i, detail: "Prompt injection: jailbreak phrase" },
  { re: /exfiltrate|send.*to.*https?:\/\//i, detail: "Prompt injection: exfiltration attempt" },
]

const SECRET_PATTERNS: Array<{ re: RegExp; detail: string }> = [
  { re: /sk-(proj-)?[A-Za-z0-9]{20,}/, detail: "Potential OpenAI API key" },
  { re: /sk-ant-[A-Za-z0-9\-]{20,}/, detail: "Potential Anthropic API key" },
  { re: /ghp_[A-Za-z0-9]{36,}/, detail: "Potential GitHub PAT" },
  { re: /AKIA[0-9A-Z]{16}/, detail: "Potential AWS access key" },
  { re: /xox[bpras]-[0-9A-Za-z\-]+/, detail: "Potential Slack token" },
  { re: /Bearer\s+[A-Za-z0-9\-_\.=]+/i, detail: "Potential Bearer token in content" },
]

const PATH_TRAVERSAL_RE = /(^|\/)\.\.(\/|\\|$)|\0/
const COMMAND_INJECTION_RE = /[;|&`$]\s*(rm|cat|curl|wget|bash|sh|python|node)\b/i
const SSRF_RE = /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|169\.254\.169\.254|metadata\.google)/i

// ── Scanner ────────────────────────────────────────────────────────

export class SecurityScanner {
  private config: Required<SecurityScannerConfig>

  constructor(config: SecurityScannerConfig = {}) {
    this.config = { strict: config.strict ?? true }
  }

  /** Full scan: prompt + tool args + file content */
  scan(input: {
    text?: string
    tool?: string
    args?: JsonValue
    fileContent?: string
    route?: string
  }): SecurityScanResult {
    const issues: SecurityIssue[] = []
    if (input.text) issues.push(...this.scanText(input.text, "prompt-injection"))
    if (input.fileContent) {
      issues.push(...this.scanText(input.fileContent, "secrets-exposure"))
      issues.push(...this.scanFileContent(input.fileContent))
    }
    if (input.tool && input.args !== undefined) issues.push(...this.scanToolArgs(input.tool, input.args))
    if (input.route && SSRF_RE.test(input.route)) {
      issues.push(this.issue("ssrf", "high", `SSRF risk: ${input.route.slice(0, 120)}`, input.route, "Block private/metadata IPs at gateway"))
    }
    return { issues, passed: issues.filter(i => i.severity === "high" || i.severity === "critical").length === 0, scannedAt: Date.now() }
  }

  /** Scan free text for injection and secrets */
  scanText(text: string, _context?: string): SecurityIssue[] {
    const out: SecurityIssue[] = []
    for (const p of INJECTION_PATTERNS) {
      if (p.re.test(text)) {
        out.push(this.issue("prompt-injection", "critical", p.detail, text.slice(0, 200), "Sanitize user input; add injection guard before LLM context"))
      }
    }
    for (const p of SECRET_PATTERNS) {
      if (p.re.test(text)) {
        out.push(this.issue("secrets-exposure", "high", p.detail, redact(text.slice(0, 200)), "Strip secrets before logging / storing; use env var references"))
      }
    }
    // XSS in tool results that may be rendered
    if (/<script[\s>]/i.test(text) || /javascript:\s*/i.test(text)) {
      out.push(this.issue("xss", "medium", "Potential XSS payload in content", text.slice(0, 200), "Escape HTML before rendering"))
    }
    return out
  }

  /** Scan tool args for traversal / injection */
  scanToolArgs(tool: string, args: JsonValue): SecurityIssue[] {
    const out: SecurityIssue[] = []
    const str = JSON.stringify(args ?? "")
    // Path traversal — read/write/edit/glob
    if (["read", "write", "edit", "glob"].includes(tool)) {
      const path = argStr(args, "path") ?? argStr(args, "file") ?? str
      if (typeof path === "string" && PATH_TRAVERSAL_RE.test(path)) {
        out.push(this.issue("path-traversal", "high", `Path traversal in ${tool}: ${String(path).slice(0, 120)}`, String(path), "Validate and sandbox file paths"))
      }
    }
    // Command injection — bash/task
    if (["bash", "task"].includes(tool)) {
      const cmd = argStr(args, "command") ?? argStr(args, "cmd") ?? str
      if (typeof cmd === "string" && COMMAND_INJECTION_RE.test(cmd)) {
        // Only flag if it looks like chained injection, not normal use
        if (/[;|&`$]/.test(cmd) && /rm\s+-rf|:\(\)\{/.test(cmd)) {
          out.push(this.issue("command-injection", "critical", `Command injection in ${tool}: ${cmd.slice(0, 120)}`, cmd.slice(0, 200), "Use allow-list + BashArity; block destructive patterns"))
        }
      }
    }
    // Secrets in args (e.g., env values)
    for (const p of SECRET_PATTERNS) {
      if (p.re.test(str)) {
        out.push(this.issue("secrets-exposure", "high", `${p.detail} in ${tool} args`, redact(str.slice(0, 200)), "Don't pass raw secrets as tool args"))
      }
    }
    return out
  }

  /** Content-level checks for file diffs */
  scanFileContent(content: string): SecurityIssue[] {
    const out: SecurityIssue[] = []
    // Detect .env / secrets being written
    if (/\.env|secrets?\.json/i.test(content) && SECRET_PATTERNS.some(p => p.re.test(content))) {
      out.push(this.issue("secrets-exposure", "high", "Secrets in file content", redact(content.slice(0, 200)), "Use env vars, not hardcoded secrets"))
    }
    return out
  }

  /** Hardening suggestions for a set of issues */
  hardeningSuggestions(issues: SecurityIssue[]): string[] {
    const byKind = new Map<SecurityKind, number>()
    for (const i of issues) byKind.set(i.kind, (byKind.get(i.kind) ?? 0) + 1)
    const suggestions: string[] = []
    if (byKind.has("prompt-injection")) suggestions.push("Add prompt-injection guard in gateway (strip system-role markers, validate user text before context)")
    if (byKind.has("secrets-exposure")) suggestions.push("Add no-secrets pre-commit check to eval PR tier + redact logs")
    if (byKind.has("path-traversal")) suggestions.push("Enforce path sandbox in read/write/edit tools (resolve + startsWith cwd)")
    if (byKind.has("command-injection")) suggestions.push("Enforce BashArity allow-list; deny destructive shell patterns")
    if (byKind.has("ssrf")) suggestions.push("Block private IP ranges at webfetch gateway")
    return suggestions
  }

  /** Whether this result should trigger a patch */
  needsPatch(result: SecurityScanResult): boolean {
    if (result.issues.some(i => i.severity === "critical")) return true
    if (this.config.strict && result.issues.some(i => i.severity === "high")) return true
    return result.issues.length >= 3
  }

  private issue(kind: SecurityKind, severity: SecuritySeverity, detail: string, evidence: string, suggestion: string): SecurityIssue {
    return {
      id: `sec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 4)}`,
      kind, severity, detail, evidence: evidence.slice(0, 200), suggestion,
      detectedAt: Date.now(),
    }
  }
}

// ── helpers ────────────────────────────────────────────────────────

function redact(s: string): string {
  return s.replace(/sk-[A-Za-z0-9\-_]{10,}/g, "sk-***")
    .replace(/ghp_[A-Za-z0-9]{10,}/g, "ghp-***")
    .replace(/Bearer\s+[A-Za-z0-9\-_\.]+/gi, "Bearer ***")
}
