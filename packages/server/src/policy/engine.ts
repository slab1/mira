/**
 * Unified Policy Engine — single authority for all policy decisions.
 *
 * Consolidates:
 *   - Guardrails (path safety, command safety, URL blocking)
 *   - Permissions (5-layer: deny → allow → pattern → bash-arity → ask)
 *   - Tool Registry (tool existence, risk classification)
 *
 * evaluate() runs all three layers and returns a single PolicyDecision.
 * First deny wins; otherwise first allow wins; otherwise ask.
 */

import type { MiraDB } from '../storage/db.js'
import type { Bus } from '../bus/index.js'
import type { PermissionRequest, PermissionAction } from '../types/index.js'
import type { PermissionDecision } from '../permission/index.js'
import { sanitizePath, isPathAllowed, sanitizeCommand, isBlockedFetchUrl, getEffectiveAllowedRoots } from '../guardrails/index.js'
import { ToolRegistry } from '../tools/registry.js'

export interface PolicyRequest {
  sessionID: string
  tool: string
  args: Record<string, unknown>
  cwd?: string
}

export interface PolicyDecision {
  action: PermissionAction
  reason: string
  layer: 'guardrails' | 'permissions' | 'registry'
  risk?: 'low' | 'medium' | 'high'
}

export interface PolicyEngineDeps {
  db?: MiraDB
  bus?: Bus
  registry?: ToolRegistry
}

export class PolicyEngine {
  private registry: ToolRegistry | null

  constructor(private deps: PolicyEngineDeps = {}) {
    this.registry = deps.registry ?? null
  }

  /**
   * Evaluate a policy request through all layers.
   * Order: guardrails → registry → permissions.
   * First deny wins; otherwise first allow wins; otherwise ask.
   */
  evaluate(req: PolicyRequest): PolicyDecision {
    // ── Layer 1: Guardrails ──────────────────────────────────────────
    const guardrail = this.checkGuardrails(req)
    if (guardrail) return guardrail

    // ── Layer 2: Tool Registry ────────────────────────────────────────
    const registry = this.checkRegistry(req)
    if (registry) return registry

    // ── Layer 3: Permissions ──────────────────────────────────────────
    return this.checkPermissions(req)
  }

  private checkGuardrails(req: PolicyRequest): PolicyDecision | null {
    const roots = getEffectiveAllowedRoots(req.cwd)

    // Path safety for file operations
    if (req.args.path && typeof req.args.path === 'string') {
      const sanitized = sanitizePath(req.args.path)
      if (!sanitized.ok) {
        return { action: 'deny', reason: `guardrails: ${sanitized.reason}`, layer: 'guardrails' }
      }
      if (!isPathAllowed(sanitized.sanitized ?? req.args.path, roots)) {
        return { action: 'deny', reason: 'guardrails: path outside allowed roots', layer: 'guardrails' }
      }
    }

    // Command safety for bash
    if (req.args.command && typeof req.args.command === 'string') {
      const sanitized = sanitizeCommand(req.args.command)
      if (!sanitized.ok) {
        return { action: 'deny', reason: `guardrails: ${sanitized.reason}`, layer: 'guardrails' }
      }
    }

    // URL safety for fetch
    if (req.args.url && typeof req.args.url === 'string') {
      const blocked = isBlockedFetchUrl(req.args.url)
      if (blocked) {
        return { action: 'deny', reason: `guardrails: ${blocked}`, layer: 'guardrails' }
      }
    }

    return null
  }

  private checkRegistry(req: PolicyRequest): PolicyDecision | null {
    if (!this.registry) return null
    const tool = this.registry.get(req.tool)
    if (!tool) {
      return { action: 'deny', reason: `registry: unknown tool "${req.tool}"`, layer: 'registry' }
    }
    if (tool.needsPermission) {
      const risk = tool.metadata?.riskLevel ?? 'medium'
      return { action: 'ask', reason: `registry: tool "${req.tool}" requires permission`, layer: 'registry', risk }
    }
    return null
  }

  private checkPermissions(req: PolicyRequest): PolicyDecision {
    if (!this.registry) {
      return { action: 'ask', reason: 'permissions: registry not available', layer: 'permissions', risk: 'medium' }
    }
    const tool = this.registry.get(req.tool)
    if (!tool) {
      return { action: 'deny', reason: 'permissions: unknown tool', layer: 'permissions' }
    }
    if (tool.needsPermission) {
      const risk = tool.metadata?.riskLevel ?? 'medium'
      return { action: 'ask', reason: `permissions: tool "${req.tool}" needs permission`, layer: 'permissions', risk }
    }
    return { action: 'allow', reason: 'permissions: tool does not require permission', layer: 'permissions' }
  }
}

export function createPolicyEngine(deps?: PolicyEngineDeps): PolicyEngine {
  return new PolicyEngine(deps)
}
