/**
 * Mira Permission — 5 Layers + BashArity
 *
 * Layers (evaluated top→bottom, first match wins — like Mira):
 *   1. Explicit deny  — `tool: "deny"`  → always block
 *   2. Explicit allow — `tool: "allow"` → always allow (no prompt)
 *   3. Pattern rules  — `edit: { "src/secret/*": "deny", "*": "allow" }`
 *   4. BashArity      — bash commands scored by destructive arity (rm -rf > ls)
 *   5. Default ask    — unmatched → "ask" (publish BusEvent → TUI prompt → wait)
 *
 * BashArity:
 *   - level 0 (read-only): ls, cat, grep, git status/log/diff
 *   - level 1 (write):     git commit, npm install, mkdir, touch
 *   - level 2 (destructive): rm, git reset --hard, DROP, sudo, curl | bash
 *   Rules: level 0 → allow, level 1 → ask, level 2 → ask (with warning) or deny if global deny
 *
 * Config shape (mira.jsonc compatible):
 *   "permission": {
 *     "bash": "allow" | "deny" | "ask" | { "rm *": "deny", "git *": "allow" },
 *     "read": "allow",
 *     "edit": { "packages/mira/migration/*": "ask", "*": "allow" },
 *     "mcp_firecrawl_*": "ask"
 *   }
 */

import type { PermissionRequest, PermissionAction, JsonValue } from '../types/index.js'

/** Narrow untyped tool args to a string-keyed record (JsonValue-tolerant). */
function argStr(args: JsonValue, key: string): string | undefined {
  if (!args || typeof args !== 'object') return undefined
  const v = (args as Record<string, JsonValue>)[key]
  return typeof v === 'string' ? v : undefined
}

type PermRule = PermissionAction | Record<string, PermissionAction>

export interface ToolRisk {
  riskLevel: 'low' | 'medium' | 'high'
  sideEffect: 'none' | 'read' | 'write' | 'destructive'
  isReversible: boolean
}

export interface PermissionDecision {
  action: PermissionAction
  reason: string
  matchedPattern?: string
  arity?: number
  risk?: ToolRisk
  approvalPayload?: { whatWillChange?: string; blastRadius?: string; canUndo?: boolean }
}

// ── BashArity ──────────────────────────────────────────────────────

const ARITY_LEVELS: Array<{ level: number; patterns: RegExp[]; label: string }> = [
  {
    level: 0,
    label: 'read-only',
    patterns: [
      /^\s*(ls|cat|head|tail|grep|rg|find|wc|sort|uniq|git\s+(status|log|diff|show|branch|ls-files)|npm\s+(ls|view)|bun\s+pm\s+ls|echo|pwd|whoami|date|env|which)\b/,
    ],
  },
  {
    level: 1,
    label: 'write',
    patterns: [
      /^\s*(git\s+(commit|add|push|pull|checkout|merge|rebase)|npm\s+install|bun\s+install|mkdir|touch|cp|mv|chmod|npm\s+run|bun\s+run|make|cargo\s+build)\b/,
    ],
  },
  {
    level: 2,
    label: 'destructive',
    patterns: [
      /^\s*(rm\s+-rf|rm\s+.*-r|sudo\s+|DROP\s+|DELETE\s+FROM|TRUNCATE|git\s+reset\s+--hard|git\s+clean\s+-f|mkfs|dd\s+if=|curl.*\|\s*bash|wget.*\|\s*sh|:\(\)\{\s*:\|\:)/i,
    ],
  },
]

export function classifyBashArity(command: string): { level: number; label: string } {
  const trimmed = command.trim()
  for (const entry of [...ARITY_LEVELS].reverse()) {
    if (entry.patterns.some((r) => r.test(trimmed)))
      return { level: entry.level, label: entry.label }
  }
  // Unknown commands default to 1 (ask)
  return { level: 1, label: 'unknown → ask' }
}

export function bashArityDecision(command: string): PermissionDecision {
  const { level, label } = classifyBashArity(command)
  if (level === 0)
    return { action: 'allow', reason: `BashArity: ${label} (0) — auto-allow`, arity: level }
  if (level === 2)
    return {
      action: 'ask',
      reason: `BashArity: ${label} (2) — destructive, requires confirmation`,
      arity: level,
    }
  return { action: 'ask', reason: `BashArity: ${label} (1) — requires confirmation`, arity: level }
}

export function classifyToolRisk(toolName: string, args: JsonValue): ToolRisk {
  const lower = toolName.toLowerCase()
  if (lower === 'bash') {
    const command = argStr(args, 'command') ?? ''
    if (/rm|sudo|drop/i.test(command)) {
      return { riskLevel: 'high', sideEffect: 'destructive', isReversible: false }
    }
    return { riskLevel: 'medium', sideEffect: 'none', isReversible: true }
  }
  if (['write', 'edit', 'patch'].includes(lower)) {
    return { riskLevel: 'medium', sideEffect: 'write', isReversible: true }
  }
  if (['read', 'glob', 'grep'].includes(lower)) {
    return { riskLevel: 'low', sideEffect: 'read', isReversible: true }
  }
  return { riskLevel: 'medium', sideEffect: 'none', isReversible: true }
}

// ── Pattern matching (glob-like, Mira-compatible) ──────────────

function matchesPattern(pattern: string, value: string): boolean {
  // Support: "*", "*.ts", "src/*", "mcp_*", exact — escape regex metas except *
  if (pattern === '*') return true
  if (pattern.includes('*')) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp('^' + escaped.replace(/\*/g, '.*') + '$')
    return re.test(value)
  }
  return pattern === value
}

function resolveForTool(
  tool: string,
  args: JsonValue,
  rule: PermRule | undefined,
): PermissionDecision | null {
  if (rule === undefined) return null
  if (typeof rule === 'string') {
    return { action: rule, reason: `explicit ${tool}=${rule}` }
  }
  // Record<string, PermissionAction> — pattern map
  // For file tools, match against path arg; for mcp, match tool name
  const valueToMatch = (() => {
    if (tool === 'bash' && args) {
      const command = argStr(args, 'command')
      if (command !== undefined) return command
    }
    if ((tool === 'read' || tool === 'write' || tool === 'edit') && args) {
      const path = argStr(args, 'path')
      if (path !== undefined) return path
    }
    return tool
  })()

  for (const [pattern, action] of Object.entries(rule)) {
    if (matchesPattern(pattern, valueToMatch) || matchesPattern(pattern, tool)) {
      return {
        action: action as PermissionAction,
        reason: `pattern "${pattern}" → ${action} (value: ${valueToMatch})`,
        matchedPattern: pattern,
      }
    }
  }
  return null
}

function summarizeArgs(tool: string, args: JsonValue): string {
  if (!args || typeof args !== 'object') return ''
  const rec = args as Record<string, JsonValue>
  if (tool === 'bash') {
    return typeof rec.command === 'string' ? rec.command : JSON.stringify(args)
  }
  if (['read', 'write', 'edit'].includes(tool)) {
    return typeof rec.path === 'string' ? rec.path : JSON.stringify(args)
  }
  return JSON.stringify(args)
}

function augmentDecision(
  decision: PermissionDecision,
  tool: string,
  args: JsonValue,
): PermissionDecision {
  const risk = classifyToolRisk(tool, args)
  decision.risk = risk
  if (
    decision.action === 'ask' &&
    (risk.riskLevel === 'high' || risk.sideEffect === 'destructive')
  ) {
    decision.approvalPayload = {
      whatWillChange: summarizeArgs(tool, args),
      blastRadius: tool,
      canUndo: risk.isReversible,
    }
  }
  return decision
}

// ── PermissionManager ──────────────────────────────────────────────

export class PermissionManager {
  constructor(private rules: Record<string, PermRule>) {}

  /**
   * Check permission for a tool call — 5 layers
   */
  async check(req: PermissionRequest): Promise<PermissionDecision> {
    const { tool, args } = req

    // Layer 1 & 2 & 3: explicit / allow / pattern — check tool-specific rule first
    const toolRule = this.rules[tool]
    if (toolRule !== undefined) {
      const d = resolveForTool(tool, args, toolRule)
      if (d) return augmentDecision(d, tool, args)
    }

    // Also check wildcard and mcp prefix rules
    for (const [key, rule] of Object.entries(this.rules)) {
      if (key === tool) continue
      if (key.includes('*') && matchesPattern(key, tool)) {
        const d = resolveForTool(tool, args, rule)
        if (d) return augmentDecision(d, tool, args)
      }
    }

    // Layer 4: BashArity (only for bash tool)
    if (tool === 'bash' && args) {
      const command = argStr(args, 'command')
      if (command !== undefined) {
        // Only if no explicit rule matched above
        const d = bashArityDecision(command)
        return augmentDecision(d, tool, args)
      }
    }

    // Layer 5: default
    // If global wildcard "*" exists, use it; else "ask"
    if (this.rules['*']) {
      const d = resolveForTool(tool, args, this.rules['*'])
      if (d) return augmentDecision(d, tool, args)
    }
    const d = { action: 'ask', reason: `no rule for ${tool} — default ask` }
    return augmentDecision(d, tool, args)
  }

  /** Update rules at runtime (from TUI config edit) */
  setRules(rules: Record<string, PermRule>) {
    this.rules = rules
  }

  listRules(): Record<string, PermRule> {
    return { ...this.rules }
  }
}
