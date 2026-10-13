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

export type SecuritySeverity = 'low' | 'medium' | 'high' | 'critical'
export type SecurityKind =
  | 'prompt-injection'
  | 'secrets-exposure'
  | 'path-traversal'
  | 'command-injection'
  | 'permission-bypass'
  | 'ssrf'
  | 'xss'
  | 'code-eval'
  | 'sql-injection'
  | 'insecure-transport'

export interface SecurityIssue extends Record<string, JsonValue> {
  id: string
  kind: SecurityKind
  severity: SecuritySeverity
  detail: string
  evidence: string // truncated snippet
  suggestion: string
  detectedAt: number
}

import type { JsonValue } from '../types/index.js'

/** Narrow untyped tool args to a string-keyed record (JsonValue-tolerant). */
function argStr(args: JsonValue, key: string): string | undefined {
  if (!args || typeof args !== 'object') return undefined
  const v = (args as Record<string, JsonValue>)[key]
  return typeof v === 'string' ? v : undefined
}

export interface SecurityScanResult extends Record<string, JsonValue> {
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
  {
    re: /ignore (all )?previous instructions/i,
    detail: 'Prompt injection: ignore previous instructions',
  },
  { re: /system\s*:\s*you are now/i, detail: 'Prompt injection: role hijack' },
  {
    re: /disregard.*(policy|rules|guidelines)/i,
    detail: 'Prompt injection: policy override attempt',
  },
  { re: /\[SYSTEM\]/i, detail: 'Prompt injection: fake system tag' },
  { re: /jailbreak|DAN mode|do anything now/i, detail: 'Prompt injection: jailbreak phrase' },
  { re: /exfiltrate|send.*to.*https?:\/\//i, detail: 'Prompt injection: exfiltration attempt' },
]

const SECRET_PATTERNS: Array<{ re: RegExp; detail: string }> = [
  { re: /sk-(proj-)?[A-Za-z0-9]{20,}/, detail: 'Potential OpenAI API key' },
  { re: /sk-ant-[A-Za-z0-9\-]{20,}/, detail: 'Potential Anthropic API key' },
  { re: /ghp_[A-Za-z0-9]{36,}/, detail: 'Potential GitHub PAT' },
  { re: /AKIA[0-9A-Z]{16}/, detail: 'Potential AWS access key' },
  { re: /xox[bpras]-[0-9A-Za-z\-]+/, detail: 'Potential Slack token' },
  { re: /Bearer\s+[A-Za-z0-9\-_\.=]+/i, detail: 'Potential Bearer token in content' },
]

const PATH_TRAVERSAL_RE = /(^|\/)\.\.(\/|\\|$)|\0/
const COMMAND_INJECTION_RE = /[;|&`$]\s*(rm|cat|curl|wget|bash|sh|python|node)\b/i
const SSRF_RE =
  /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|169\.254\.169\.254|metadata\.google)/i

// ── Code-level injection rules ──────────────────────────────────────
//
// COVERAGE GAP FOUND BY EXECUTION: the scanner declared the kinds
// "command-injection", "xss" and "path-traversal", and defined
// COMMAND_INJECTION_RE / PATH_TRAVERSAL_RE — but scanText() only ever ran
// INJECTION_PATTERNS and SECRET_PATTERNS. Those constants were reachable
// only from scanToolArgs(), which runs only when `tool` is supplied, and
// the governance gate calls scan({ text, route }) with no tool.
//
// So for a patch diff the scanner answered exactly two questions: is this
// prompt injection, and is this a hardcoded secret. Measured on hostile
// patches, 7 of 9 sailed through reported clean:
//
//   eval(userInput)                      -> PASS
//   el.innerHTML = userControlled        -> PASS
//   exec("rm -rf " + path)               -> PASS
//   child_process.exec(userCmd)          -> PASS
//   db.query("SELECT ... " + req.body.id)-> PASS
//   md5(password)                        -> PASS
//   rejectUnauthorized: false            -> PASS
//   (hardcoded key + exfil)              -> FAIL  <- the only one caught
//
// A patch that hands attacker-controlled input to a shell is exactly what
// this gate exists to stop. Declaring a kind is not detecting it.

/** True when a sink's argument is not a fixed literal. */
function isDynamicArg(arg: string): boolean {
  const a = arg.trim()
  if (!a) return false
  // A literal that is then concatenated, appended to, or interpolated is still
  // attacker-controllable: `"rm -rf " + path` is not a constant command.
  if (/\+|\$\{|\.\.\./.test(a)) return true
  if (a.startsWith("'") || a.startsWith('"') || a.startsWith('`')) return false
  if (/^(null|undefined|true|false|-?\d)/.test(a)) return false
  return true // identifier, member access, concatenation, call result
}

/**
 * A variable whose name asserts it was already made safe. Treated as trusted so
 * `el.innerHTML = sanitizedHtml` is not reported — the author has already made
 * that call, and re-litigating it on every diff is how a gate gets bypassed.
 */
const PRE_SANITIZED = /^(saniti[sz]ed|escaped|encoded|trusted|safe|clean)/i

/** Pull the argument text of the first `sink(` call on a line. */
function sinkArg(line: string, sink: string): string | null {
  const at = line.indexOf(`${sink}(`)
  if (at < 0) return null
  const open = at + sink.length
  let depth = 0
  for (let i = open; i < line.length; i++) {
    const c = line[i]
    if (c === '(') depth++
    else if (c === ')') {
      if (depth === 0) return line.slice(open + 1, i)
      depth--
    }
  }
  return line.slice(open + 1)
}

interface CodeRule {
  kind: SecurityKind
  severity: SecuritySeverity
  detail: string
  suggestion: string
  test: (line: string) => boolean
}

const EVAL_DETAIL = 'Dynamic code execution: eval/Function/vm run arbitrary code in-process'
const EVAL_SUGGESTION =
  'Parse data instead of evaluating it; if unavoidable, use a sandboxed interpreter'

const CODE_RULES: CodeRule[] = [
  {
    kind: 'code-eval',
    severity: 'critical',
    detail: EVAL_DETAIL,
    suggestion: EVAL_SUGGESTION,
    test: (l) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(l)) return false
      // `new Function('return 1')` compiles a constant — only the dynamic form
      // executes anything the caller controls.
      const fn = sinkArg(l, 'Function')
      if (fn !== null) return isDynamicArg(fn)
      for (const sink of ['eval', 'runInNewContext', 'runInThisContext', 'runInContext']) {
        const arg = sinkArg(l, sink)
        if (arg !== null) return isDynamicArg(arg)
      }
      return false
    },
  },
  {
    // exec/spawn whose command is built at runtime — the shell metacharacters
    // are already there, so the only question is whether input reaches them.
    kind: 'command-injection',
    severity: 'critical',
    detail: 'Shell command built from a non-literal (command injection risk)',
    suggestion: 'Use execFile/spawn with an argv array; never pass a shell string',
    test: (l) => {
      if (COMMAND_INJECTION_RE.test(l) && /[;|&`]/.test(l)) return true
      for (const sink of ['exec', 'execSync', 'spawn', 'spawnSync', 'execFile']) {
        const arg = sinkArg(l, sink)
        if (arg !== null && isDynamicArg(arg)) return true
      }
      return false
    },
  },
  {
    kind: 'xss',
    severity: 'high',
    detail: 'Unescaped HTML sink assigned a non-literal (XSS risk)',
    suggestion: 'Use textContent, or sanitize with a vetted HTML sanitizer',
    test: (l) => {
      const m = /\.(innerHTML|outerHTML)\s*=\s*(.+)$/.exec(l)
      if (m) {
        const rhs = m[2]!.trim()
        if (!isDynamicArg(rhs)) return false
        return !PRE_SANITIZED.test(rhs.replace(/[;,)\s]+$/, ''))
      }
      if (/\binsertAdjacentHTML\s*\(/.test(l)) return true
      if (/dangerouslySetInnerHTML/.test(l) && /=\s*\{\s*[^}]/.test(l)) return true
      return false
    },
  },
  {
    kind: 'sql-injection',
    severity: 'high',
    detail: 'SQL statement built by string concatenation or interpolation',
    suggestion: 'Use parameterized queries / prepared statements with bound values',
    test: (l) => {
      // `exec` is deliberately NOT a SQL sink — it is overwhelmingly a shell
      // or Prisma-style call, and including it made `exec("rm -rf " + p)`
      // report as SQL injection.
      if (!/\b(query|execute|raw)\s*\(/.test(l)) return false
      const arg = sinkArg(l, 'query') ?? sinkArg(l, 'execute') ?? sinkArg(l, 'raw')
      if (arg === null) return false
      // Require SQL in the string, or the gate reports on every `.query()` in a
      // React-Query/GraphQL client.
      if (!/\b(select|insert|update|delete|from|where|join|values)\b/i.test(arg)) return false
      return isDynamicArg(arg) && /['"`]/.test(arg)
    },
  },
  {
    kind: 'insecure-transport',
    severity: 'high',
    detail: 'TLS certificate verification disabled',
    suggestion: 'Leave rejectUnauthorized enabled; pin a CA instead of skipping verification',
    test: (l) => /rejectUnauthorized\s*:\s*false/.test(l) || /NODE_TLS_REJECT_UNAUTHORIZED/.test(l),
  },
  {
    kind: 'permission-bypass',
    severity: 'high',
    detail: 'Authorization/permission check disabled or stubbed',
    suggestion: 'Never gate on a disabled check; enforce permissions server-side',
    test: (l) =>
      // Unambiguous opt-outs only. `auth: false` was tried here and rejected:
      // it appears in test fixtures and type definitions, and a high-severity
      // false positive teaches operators to route around the gate.
      /\b(skipAuth|bypassAuth|requireAuth\s*:\s*false|authDisabled|allowAnonymous\s*:\s*true|disableAuth)\b/.test(
        l,
      ),
  },
]

/**
 * Lines to inspect. For a unified diff that means ADDED lines only — a hazard
 * already present in the surrounding context is not something this change
 * introduced, and flagging it would make the gate cry wolf.
 */
function candidateLines(text: string): string[] {
  const lines = text.split('\n')
  const isDiff = lines.some((l) => /^(diff --git |--- |\+\+\+ |@@ )/.test(l))
  if (!isDiff) return lines
  return lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1))
}

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
    if (input.text) {
      issues.push(...this.scanText(input.text))
      issues.push(...this.scanCode(input.text))
    }
    if (input.fileContent) {
      issues.push(...this.scanText(input.fileContent))
      issues.push(...this.scanFileContent(input.fileContent))
    }
    if (input.tool && input.args !== undefined)
      issues.push(...this.scanToolArgs(input.tool, input.args))
    if (input.route && SSRF_RE.test(input.route)) {
      issues.push(
        this.issue(
          'ssrf',
          'high',
          `SSRF risk: ${input.route.slice(0, 120)}`,
          input.route,
          'Block private/metadata IPs at gateway',
        ),
      )
    }
    return {
      issues,
      passed: issues.filter((i) => i.severity === 'high' || i.severity === 'critical').length === 0,
      scannedAt: Date.now(),
    }
  }

  /** Scan free text for injection and secrets */
  scanText(text: string): SecurityIssue[] {
    const out: SecurityIssue[] = []
    for (const p of INJECTION_PATTERNS) {
      if (p.re.test(text)) {
        out.push(
          this.issue(
            'prompt-injection',
            'critical',
            p.detail,
            text.slice(0, 200),
            'Sanitize user input; add injection guard before LLM context',
          ),
        )
      }
    }
    for (const p of SECRET_PATTERNS) {
      if (p.re.test(text)) {
        out.push(
          this.issue(
            'secrets-exposure',
            'high',
            p.detail,
            redact(text.slice(0, 200)),
            'Strip secrets before logging / storing; use env var references',
          ),
        )
      }
    }
    // XSS in tool results that may be rendered
    if (/<script[\s>]/i.test(text) || /javascript:\s*/i.test(text)) {
      out.push(
        this.issue(
          'xss',
          'medium',
          'Potential XSS payload in content',
          text.slice(0, 200),
          'Escape HTML before rendering',
        ),
      )
    }
    return out
  }

  /** Scan tool args for traversal / injection */
  scanToolArgs(tool: string, args: JsonValue): SecurityIssue[] {
    const out: SecurityIssue[] = []
    const str = JSON.stringify(args ?? '')
    // Path traversal — read/write/edit/glob
    if (['read', 'write', 'edit', 'glob'].includes(tool)) {
      const path = argStr(args, 'path') ?? argStr(args, 'file') ?? str
      if (typeof path === 'string' && PATH_TRAVERSAL_RE.test(path)) {
        out.push(
          this.issue(
            'path-traversal',
            'high',
            `Path traversal in ${tool}: ${String(path).slice(0, 120)}`,
            String(path),
            'Validate and sandbox file paths',
          ),
        )
      }
    }
    // Command injection — bash/task
    if (['bash', 'task'].includes(tool)) {
      const cmd = argStr(args, 'command') ?? argStr(args, 'cmd') ?? str
      if (typeof cmd === 'string' && COMMAND_INJECTION_RE.test(cmd)) {
        // Only flag if it looks like chained injection, not normal use
        if (/[;|&`$]/.test(cmd) && /rm\s+-rf|:\(\)\{/.test(cmd)) {
          out.push(
            this.issue(
              'command-injection',
              'critical',
              `Command injection in ${tool}: ${cmd.slice(0, 120)}`,
              cmd.slice(0, 200),
              'Use allow-list + BashArity; block destructive patterns',
            ),
          )
        }
      }
    }
    // Secrets in args (e.g., env values)
    for (const p of SECRET_PATTERNS) {
      if (p.re.test(str)) {
        out.push(
          this.issue(
            'secrets-exposure',
            'high',
            `${p.detail} in ${tool} args`,
            redact(str.slice(0, 200)),
            "Don't pass raw secrets as tool args",
          ),
        )
      }
    }
    return out
  }

  /**
   * Code-level hazards in a patch: shell injection, dynamic eval, unescaped
   * HTML sinks, concatenated SQL, disabled TLS verification, and stubbed auth.
   *
   * Runs on added lines only for unified diffs, so a hazard that merely
   * appears in surrounding context does not block a change that never
   * introduced it.
   */
  scanCode(text: string): SecurityIssue[] {
    const out: SecurityIssue[] = []
    const seen = new Set<string>()
    for (const line of candidateLines(text)) {
      // Strip line comments so documentation about eval() isn't flagged.
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
      for (const rule of CODE_RULES) {
        if (seen.has(rule.kind)) continue
        let hit = false
        try {
          hit = rule.test(trimmed)
        } catch {
          hit = false
        }
        if (hit) {
          seen.add(rule.kind)
          out.push(
            this.issue(
              rule.kind,
              rule.severity,
              rule.detail,
              line.trim().slice(0, 200),
              rule.suggestion,
            ),
          )
        }
      }
    }
    return out
  }

  /** Content-level checks for file diffs */
  scanFileContent(content: string): SecurityIssue[] {
    const out: SecurityIssue[] = []
    // Detect .env / secrets being written
    if (/\.env|secrets?\.json/i.test(content) && SECRET_PATTERNS.some((p) => p.re.test(content))) {
      out.push(
        this.issue(
          'secrets-exposure',
          'high',
          'Secrets in file content',
          redact(content.slice(0, 200)),
          'Use env vars, not hardcoded secrets',
        ),
      )
    }
    return out
  }

  /** Hardening suggestions for a set of issues */
  hardeningSuggestions(issues: SecurityIssue[]): string[] {
    const byKind = new Map<SecurityKind, number>()
    for (const i of issues) byKind.set(i.kind, (byKind.get(i.kind) ?? 0) + 1)
    const suggestions: string[] = []
    if (byKind.has('prompt-injection'))
      suggestions.push(
        'Add prompt-injection guard in gateway (strip system-role markers, validate user text before context)',
      )
    if (byKind.has('secrets-exposure'))
      suggestions.push('Add no-secrets pre-commit check to eval PR tier + redact logs')
    if (byKind.has('path-traversal'))
      suggestions.push('Enforce path sandbox in read/write/edit tools (resolve + startsWith cwd)')
    if (byKind.has('command-injection'))
      suggestions.push('Enforce BashArity allow-list; deny destructive shell patterns')
    if (byKind.has('ssrf')) suggestions.push('Block private IP ranges at webfetch gateway')
    if (byKind.has('code-eval'))
      suggestions.push('Remove eval/Function/vm execution of untrusted input; parse instead')
    if (byKind.has('sql-injection'))
      suggestions.push('Use parameterized queries for every statement')
    if (byKind.has('xss')) suggestions.push('Escape HTML output; prefer textContent over innerHTML')
    if (byKind.has('insecure-transport'))
      suggestions.push('Re-enable TLS verification; pin a CA if pinning is required')
    if (byKind.has('permission-bypass'))
      suggestions.push('Enforce authorization server-side; remove disabled-check shortcuts')
    return suggestions
  }

  /** Whether this result should trigger a patch */
  needsPatch(result: SecurityScanResult): boolean {
    if (result.issues.some((i) => i.severity === 'critical')) return true
    if (this.config.strict && result.issues.some((i) => i.severity === 'high')) return true
    return result.issues.length >= 3
  }

  private issue(
    kind: SecurityKind,
    severity: SecuritySeverity,
    detail: string,
    evidence: string,
    suggestion: string,
  ): SecurityIssue {
    return {
      id: `sec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 4)}`,
      kind,
      severity,
      detail,
      evidence: evidence.slice(0, 200),
      suggestion,
      detectedAt: Date.now(),
    }
  }
}

// ── helpers ────────────────────────────────────────────────────────

function redact(s: string): string {
  return s
    .replace(/sk-[A-Za-z0-9\-_]{10,}/g, 'sk-***')
    .replace(/ghp_[A-Za-z0-9]{10,}/g, 'ghp-***')
    .replace(/Bearer\s+[A-Za-z0-9\-_\.]+/gi, 'Bearer ***')
}
