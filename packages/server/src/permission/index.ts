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
 * Action Classes (L0–L3, master findings addendum):
 *   - L0 read-only / L1 file-modification / L2 git-operation / L3 production-deploy
 *   - Bash commands are classified by text: git state-changes → L2; deploy/publish
 *     commands (kubectl apply, docker push, terraform apply, vercel --prod,
 *     npm publish, …) → L3. L2/L3 always ask unless an explicit rule matched.
 *     This fixes git ops sharing arity-1 with `mkdir`.
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
  /** Action class per master findings L0–L3 taxonomy (0=read-only … 3=deploy) */
  actionClass: number
}

export interface PermissionDecision {
  action: PermissionAction
  reason: string
  matchedPattern?: string
  arity?: number
  risk?: ToolRisk
  approvalPayload?: { whatWillChange?: string; blastRadius?: string; canUndo?: boolean }
}

// ── Action Classes (L0–L3) ─────────────────────────────────────────
// Master findings taxonomy: an action's class determines its approval tier,
// independent of command-level destructiveness (BashArity). A `git commit`
// (write arity) is still L2 git-ops — not the same as `mkdir`.

export const ACTION_CLASSES = {
  0: 'read-only',
  1: 'file-modification',
  2: 'git-operation',
  3: 'production-deploy',
} as const

const GIT_OP_RE =
  /^\s*git\s+(commit|add|push|pull|checkout|merge|rebase|reset|clean|cherry-pick|revert|stash|tag|branch\s+-[dD]|fetch)\b/i
const DEPLOY_RE =
  /^\s*(kubectl\s+(apply|create|replace|delete)|helm\s+(install|upgrade|rollback)|docker\s+(push|logout)|terraform\s+(apply|destroy)|vercel\s+(--prod|deploy)|netlify\s+deploy|aws\s+deploy|flyctl\s+deploy|gcloud\s+app\s+deploy|serverless\s+deploy|sls\s+deploy|npm\s+publish|bun\s+publish|pnpm\s+publish|yarn\s+publish)\b/i

/**
 * Classify an action into L0–L3.
 * Bash commands are inspected by command text; tools by name + args.
 */
export function classifyActionClass(
  tool: string,
  args: JsonValue,
): { level: number; label: string } {
  const lower = tool.toLowerCase()
  if (lower === 'bash') {
    const command = argStr(args, 'command') ?? ''
    if (DEPLOY_RE.test(command)) return { level: 3, label: ACTION_CLASSES[3] }
    if (GIT_OP_RE.test(command)) return { level: 2, label: ACTION_CLASSES[2] }
    const arity = classifyBashArity(command)
    if (arity.level === 0) return { level: 0, label: ACTION_CLASSES[0] }
    return { level: 1, label: ACTION_CLASSES[1] }
  }
  if (
    [
      'read',
      'glob',
      'grep',
      'findcallers',
      'finddependencies',
      'finddependents',
      'memory_search',
      'finding_list',
      'question',
      'webfetch',
      'websearch',
      'lsp',
    ].includes(lower)
  ) {
    return { level: 0, label: ACTION_CLASSES[0] }
  }
  if (['apply_patch'].includes(lower)) {
    // patch application is file modification unless it deploys (not expressible here)
    return { level: 1, label: ACTION_CLASSES[1] }
  }
  if (
    [
      'write',
      'edit',
      'patch',
      'memory_write',
      'finding_write',
      'finding_resolve',
      'todowrite',
    ].includes(lower)
  ) {
    return { level: 1, label: ACTION_CLASSES[1] }
  }
  return { level: 1, label: ACTION_CLASSES[1] }
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
  const actionClass = classifyActionClass(toolName, args).level
  const lower = toolName.toLowerCase()
  if (lower === 'bash') {
    const command = argStr(args, 'command') ?? ''
    if (actionClass === 3) {
      return { riskLevel: 'high', sideEffect: 'destructive', isReversible: false, actionClass }
    }
    if (/rm|sudo|drop/i.test(command)) {
      return { riskLevel: 'high', sideEffect: 'destructive', isReversible: false, actionClass }
    }
    return { riskLevel: 'medium', sideEffect: 'none', isReversible: true, actionClass }
  }
  if (['write', 'edit', 'patch'].includes(lower)) {
    return { riskLevel: 'medium', sideEffect: 'write', isReversible: true, actionClass }
  }
  if (['read', 'glob', 'grep'].includes(lower)) {
    return { riskLevel: 'low', sideEffect: 'read', isReversible: true, actionClass }
  }
  return { riskLevel: 'medium', sideEffect: 'none', isReversible: true, actionClass }
}

/**
 * Approval tier per action class:
 *   L0 read-only          → allow
 *   L1 file modification  → allow under standard posture, ask in readonly
 *   L2 git operation      → ask (reviewable history, but state-changing)
 *   L3 production deploy  → ask with explicit warning, always
 */
export function actionClassApproval(actionClass: number): {
  action: PermissionAction
  reason: string
} {
  switch (actionClass) {
    case 0:
      return { action: 'allow', reason: 'L0 read-only — auto-allow' }
    case 3:
      return { action: 'ask', reason: 'L3 production deploy — always requires confirmation' }
    case 2:
      return { action: 'ask', reason: 'L2 git operation — requires confirmation' }
    default:
      return { action: 'ask', reason: 'L1 file modification — requires confirmation' }
  }
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
    return { action: rule as PermissionAction, reason: `explicit ${tool}=${rule}` }
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
    (risk.riskLevel === 'high' || risk.sideEffect === 'destructive' || risk.actionClass >= 2)
  ) {
    decision.approvalPayload = {
      whatWillChange: summarizeArgs(tool, args),
      blastRadius: `${tool} (L${risk.actionClass} ${ACTION_CLASSES[risk.actionClass as keyof typeof ACTION_CLASSES] ?? 'unknown'})`,
      canUndo: risk.isReversible,
    }
  }
  return decision
}

/**
 * Layer-4b (after BashArity): enforce L2/L3 action classes as always-ask
 * unless an explicit allow pattern matched earlier. This is the approval-
 * level arm of the L0–L3 taxonomy — read-only still auto-allows at arity 0.
 */
function applyActionClassGate(
  decision: PermissionDecision,
  tool: string,
  args: JsonValue,
): PermissionDecision {
  if (decision.action === 'deny') return decision
  if (tool !== 'bash') return decision
  const ac = classifyActionClass(tool, args)
  if (ac.level >= 2 && decision.action === 'allow') {
    return {
      ...decision,
      action: 'ask',
      reason: `${decision.reason} → escalated: ${ac.label} (L${ac.level}) always asks without explicit rule`,
      arity: decision.arity ?? ac.level,
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
        return applyActionClassGate(augmentDecision(d, tool, args), tool, args)
      }
    }

    // Layer 5: default
    // If global wildcard "*" exists, use it; else "ask"
    if (this.rules['*']) {
      const d = resolveForTool(tool, args, this.rules['*'])
      if (d) return augmentDecision(d, tool, args)
    }
    const d = { action: 'ask' as PermissionAction, reason: `no rule for ${tool} — default ask` }
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
