/**
 * Security Validator — Phase 2 Safety per MIRA_SYSTEM_DOCUMENTATION.md:8 Tool Security + MIRA_WEAKNESSES:10 + :23
 *
 * Validates patch has no secrets, no permission escalation, static checks. Keeps nvidia primary + colibri opportunistic.
 *
 * Documentation Maintenance — 10 items:
 * | # | Item | Status | Evidence |
 * |---|------|--------|----------|
 * | 1 | Implementation path | Implemented | packages/server/src/evolution/security.ts |
 * | 2 | Public interfaces | Implemented | SecurityValidator.validate(patch): {passed, findings} |
 * | 3 | Events | Implemented | emits evolution.security BusEvent on findings |
 * | 4 | Configuration | Implemented | no config; respects guardrails, MIRA_NO_AUTOPROVISION |
 * | 5 | Tests | Implemented | evolution/*.test.ts security |
 * | 6 | Security boundaries | Implemented | fail-closed on secret/permission escalation |
 * | 7 | Operational procedures | Implemented | check before verifier in POST /evolution/observe |
 * | 8 | Migration strategy | Implemented | additive, Phase 1 security in verifier preserved |
 * | 9 | Rollback strategy | Implemented | revert file, no state |
 * | 10 | Known limitations | Implemented | heuristic static checks; Phase 4 adds full tsc/lint pipeline |
 */

import type { Bus } from "../bus/index.js"
import type { JsonValue } from "../types/index.js"

export interface SecurityResult {
  passed: boolean
  findings: string[]
}

const SECRET_PATTERNS: Array<{ re: RegExp; msg: string }> = [
  { re: /MIRA_TOKEN/i, msg: "patch touches MIRA_TOKEN — secret leak risk (Tool Security §8)" },
  { re: /COLI_API_KEY/i, msg: "patch touches COLI_API_KEY — secret leak risk" },
  { re: /NVIDIA_API_KEY/i, msg: "patch touches NVIDIA_API_KEY — secret leak risk" },
  { re: /OPENROUTER_API_KEY/i, msg: "patch touches OPENROUTER_API_KEY — secret leak risk" },
  { re: /ANTHROPIC_API_KEY/i, msg: "patch touches ANTHROPIC_API_KEY — secret leak risk" },
  { re: /OPENAI_API_KEY/i, msg: "patch touches OPENAI_API_KEY — secret leak risk" },
  { re: /\.mira\/mira\.env/, msg: "patch touches mira.env — secret store (§8)" },
  { re: /api_key/i, msg: "patch contains api_key literal — possible secret" },
  { re: /password\s*[:=]/i, msg: "patch contains password — secret" },
  { re: /secret\s*[:=]/i, msg: "patch contains secret — possible leak" },
  { re: /-----BEGIN (RSA )?PRIVATE KEY-----/, msg: "patch contains private key" },
]

const PERMISSION_PATTERNS: Array<{ re: RegExp; msg: string }> = [
  { re: /guardrails\.enforce\s*=\s*false/i, msg: "permission escalation: disables guardrails.enforce (§18)" },
  { re: /MIRA_STRICT_AUTH\s*=\s*["']?0/i, msg: "permission escalation: disables MIRA_STRICT_AUTH" },
  { re: /allow.*all|permissions?\s*:\s*".*elevated"/i, msg: "permission escalation: elevated permissions" },
  { re: /chmod\s+777/i, msg: "permission escalation: chmod 777" },
  { re: /\bsudo\b/i, msg: "permission escalation: sudo" },
  { re: /blockedCommands\s*:\s*\[\]/i, msg: "permission escalation: clears blockedCommands" },
  { re: /allowedRoots\s*:\s*\[.*\/.*\]/i, msg: "permission escalation: widens allowedRoots to / (needs review)" },
]

export class SecurityValidator {
  private bus?: Bus
  constructor(opts?: { bus?: Bus }) { this.bus = opts?.bus }

  validate(patch: string): SecurityResult {
    const findings: string[] = []
    const text = String(patch ?? "")

    // secrets
    for (const { re, msg } of SECRET_PATTERNS) {
      if (re.test(text)) findings.push(msg)
    }
    // permission escalation
    for (const { re, msg } of PERMISSION_PATTERNS) {
      if (re.test(text)) findings.push(msg)
    }
    // static checks — treat external web content as untrusted (§10)
    if (text.length > 5000) findings.push("static: patch >5k chars — large blast radius, needs review")
    if (/eval\s*\(|Function\s*\(|child_process|execSync/i.test(text)) findings.push("static: patch uses eval/child_process — code injection risk")
    // no secrets = pass, but permission escalation always fail
    const hasSecret = findings.some((f) => /secret|MIRA_TOKEN|API_KEY|private key|mira\.env|password/i.test(f))
    const hasEscalation = findings.some((f) => /permission escalation/i.test(f))
    const hasInjection = findings.some((f) => /eval|injection/i.test(f))

    const passed = !hasSecret && !hasEscalation && !hasInjection

    if (findings.length > 0) {
      try {
        this.bus?.publish({
          type: "evolution.security" as unknown as import("../types/index.js").BusEventType,
          payload: { passed, findings: findings.slice(0, 10), timestamp: Date.now() } as unknown as JsonValue,
          timestamp: Date.now(),
        } as unknown as import("../types/index.js").BusEvent)
      } catch {}
    }

    return { passed, findings }
  }
}
