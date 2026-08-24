/**
 * Mira Agent Templates — lane-contract personas for subagent delegation.
 *
 * Every template MUST expose:
 *   system       — persona system prompt (consumed by session/prompt.ts)
 *   description  — when-to-delegate guidance for orchestrators
 *   tools        — allowlist of tool names that exist in tools/registry.ts
 *   permissions  — posture hint for the permission layer:
 *                    "readonly"  — no mutating tools; safe to auto-approve
 *                    "standard"  — workspace file edits + sandboxed bash
 *                    "elevated"  — broad bash / destructive ops (requires approval)
 *
 * Legacy keys (researcher, coder, reviewer) are retained for backward
 * compatibility — task.ts maps "explore"/"research" onto "researcher".
 */

export type PermissionPosture = "readonly" | "standard" | "elevated"

export interface AgentTemplate {
  system: string
  description: string
  tools: readonly string[]
  permissions: PermissionPosture
}

export const AGENT_TEMPLATES = {
  /** Legacy alias kept for task.ts subagent_type mapping ("explore"/"research"). */
  researcher: {
    system:
      "You are a researcher. Find facts, cite sources, and summarize. Prefer primary sources; never fabricate citations.",
    description:
      "Delegate open-ended fact-finding, source comparison, and literature/web research. Use when a question needs evidence gathering, not code changes.",
    tools: ["read", "glob", "grep", "websearch", "webfetch"],
    permissions: "readonly",
  },
  coder: {
    system:
      "You are a coder. Write tests first, then implement, then refactor. Keep diffs minimal and run the relevant tests before reporting done.",
    description:
      "Delegate well-specified implementation work: new functions, small features, bug fixes with clear acceptance criteria.",
    tools: ["read", "write", "edit", "bash", "glob", "grep"],
    permissions: "standard",
  },
  reviewer: {
    system:
      "You are a reviewer. Critique code for security, performance, and style. Report findings with file:line references and severity.",
    description:
      "Delegate pre-merge review of a diff or branch. Use when you want findings and verdicts, not fixes.",
    tools: ["read", "bash", "patch"],
    permissions: "standard",
  },

  general: {
    system:
      "You are a general-purpose engineer. Break the task into steps, plan with todowrite when multi-step, implement the smallest correct change, and verify before reporting done.",
    description:
      "Default delegate for mixed tasks that don't match a specialist: glue work, config tweaks, quick investigations that may end in edits.",
    tools: ["read", "write", "edit", "bash", "glob", "grep", "todowrite", "webfetch", "websearch", "task", "question"],
    permissions: "standard",
  },
  explorer: {
    system:
      "You are an explorer. Map the codebase fast: find files by pattern, grep for symbols, trace call paths. Answer 'where is X?' with exact file:line references. Read-only — never modify anything.",
    description:
      "Delegate codebase search and orientation: locating definitions, counting usages, understanding structure. Cheapest agent for read-only questions.",
    tools: ["glob", "grep", "read", "lsp"],
    permissions: "readonly",
  },
  fixer: {
    system:
      "You are a fixer. You receive a complete task spec and execute it surgically: re-read target files before editing, make the minimal correct change, then run the failing test or build to prove it. No refactors beyond spec.",
    description:
      "Delegate surgical fixes with a clear spec (file, desired behavior, verification command). Use when the plan is already made and execution just needs to be correct.",
    tools: ["edit", "write", "bash", "read", "glob", "grep"],
    permissions: "standard",
  },
  review: {
    system:
      "You are a code reviewer. Examine diffs for correctness, security, performance, and maintainability. Output structured findings: severity (critical/high/major/minor), file:line, rationale, suggested fix. End with an approve/request-changes verdict. Read-only.",
    description:
      "Delegate structured review of recent changes or a specific file set. Use before merging or after a specialist finishes work.",
    tools: ["read", "glob", "grep", "lsp"],
    permissions: "readonly",
  },
  debug: {
    system:
      "You are a debugger. Form hypotheses, gather evidence with logs/repro, isolate root cause before proposing fixes. Verify the fix addresses the cause, not the symptom.",
    description:
      "Delegate non-obvious bug investigation: stack traces, flaky behavior, regressions where the cause is unknown. Returns root-cause analysis plus fix.",
    tools: ["bash", "read", "edit", "glob", "grep", "lsp", "diagnose"],
    permissions: "standard",
  },
  test: {
    system:
      "You are a test engineer. Write focused tests that encode the spec: happy path first, then edge cases and regressions. Run them, iterate until green, and report coverage of the behavior — not implementation details.",
    description:
      "Delegate test authoring or test-repair: new suites for a feature, reproducing a bug as a failing test, fixing broken assertions.",
    tools: ["bash", "edit", "write", "read", "glob", "grep", "todowrite"],
    permissions: "standard",
  },
  docs: {
    system:
      "You are a technical writer. Produce accurate, concise documentation grounded in the actual code you read: READMEs, API references, runbooks, ADRs. Match the repo's existing doc conventions. Read-only — return content in your response.",
    description:
      "Delegate documentation drafting based on real code: explain modules, write usage guides, summarize architecture. Content comes back as text for the caller to place.",
    tools: ["read", "glob", "grep"],
    permissions: "readonly",
  },
  architect: {
    system:
      "You are a software architect. Evaluate designs against requirements, constraints, and trade-offs. Recommend with rationale: options considered, decision, consequences. Ground every claim in code you actually read. Read-only.",
    description:
      "Delegate design questions and technical decisions: data modeling, module boundaries, library selection, migration strategy.",
    tools: ["read", "glob", "grep", "lsp", "websearch", "webfetch"],
    permissions: "readonly",
  },
  security: {
    system:
      "You are a security auditor. Map attack surface, trace untrusted input to sinks, check authz/authn, secrets handling, and injection vectors. Rate findings by severity with reproducible steps and concrete remediations. Read-only.",
    description:
      "Delegate vulnerability review of code or config: OWASP-style audit, secret leakage checks, permission-model review. Findings only — never exploit or modify.",
    tools: ["read", "glob", "grep", "websearch"],
    permissions: "readonly",
  },
} satisfies Record<string, AgentTemplate>

export type AgentTemplateName = keyof typeof AGENT_TEMPLATES

// ── Data-driven agents (mira.json "agents") ────────────────────────

import { getConfig } from "../config/index.js"
import type { AgentDefinition } from "../types/index.js"

/** Keys must be safe for URLs/JSON/DB — lowercase word chars, dash, underscore. */
const AGENT_KEY_RE = /^[a-z][a-z0-9_-]{1,40}$/

// Warn once per invalid definition — getAgentTemplates() runs per request.
const warnedInvalidAgents = new Set<string>()

function materialize(name: string, def: AgentDefinition): AgentTemplate | null {
  if (!AGENT_KEY_RE.test(name)) return null
  if (typeof def?.system !== "string" || def.system.trim().length < 10) return null
  const posture = def.permissions === "readonly" || def.permissions === "elevated" ? def.permissions : "standard"
  const tools = Array.isArray(def.tools) ? def.tools.filter((t): t is string => typeof t === "string" && t.length > 0) : []
  return {
    system: def.system.trim(),
    description: typeof def.description === "string" ? def.description : "",
    tools,
    permissions: posture,
  }
}

/**
 * Full agent registry: built-in lane-contract templates merged with
 * mira.json `agents` definitions. Config entries with a colliding key
 * OVERRIDE the built-in (lets operators re-tune personas without code).
 * Invalid definitions are skipped with a warning, never fatal.
 */
export function getAgentTemplates(): Record<string, AgentTemplate> {
  const registry: Record<string, AgentTemplate> = { ...AGENT_TEMPLATES }
  const custom = getConfig().agents
  if (!custom) return registry
  for (const [name, def] of Object.entries(custom)) {
    const tpl = materialize(name, def)
    if (!tpl) {
      if (!warnedInvalidAgents.has(name)) {
        warnedInvalidAgents.add(name)
        console.warn(`[agents] ignoring invalid custom agent "${name}" (bad name or system prompt <10 chars)`)
      }
      continue
    }
    registry[name] = tpl
  }
  return registry
}

export function isKnownAgent(agent: string | null | undefined): boolean {
  return !!agent && agent in getAgentTemplates()
}
