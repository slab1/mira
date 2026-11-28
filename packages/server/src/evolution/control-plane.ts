/**
 * Protected Control Plane Registry & Tampering Detection.
 *
 * Separates ordinary autonomous self-improvement candidates from the security,
 * authorization, containment, governance, and persistence controls that govern
 * them. Human maintainers may modify these files through external repository
 * governance controls (protected branch, CI checks, CODEOWNERS), while
 * autonomous candidates targeting them are flagged critical and blocked.
 */

const PROTECTED_CONTROL_PLANE_PREFIXES = [
  'packages/server/src/auth/',
  'packages/server/src/bootstrap/',
  'packages/server/src/middleware/',
  'packages/server/src/policy/',
  'packages/server/src/guardrails/',
  'packages/server/src/sandbox/',
  'packages/server/src/compliance/',
  'packages/server/src/storage/',
  'packages/server/src/patching/governance/',
  '.github/',
]

const PROTECTED_CONTROL_PLANE_EXACT = new Set([
  'packages/server/src/ws-auth.ts',
  'packages/server/src/token-provisioning.ts',
  'packages/server/src/terminal-security.ts',
  'packages/server/src/patching/security.ts',
  'packages/server/src/verification.ts',
  'packages/server/src/routes/admin.ts',
  'packages/server/src/routes/orgs.ts',
  'packages/server/src/routes/me.ts',
  'packages/server/src/routes/research.ts',
  'packages/server/src/routes/coordination.ts',
  'packages/server/src/routes/evolution.ts',
  'packages/server/src/routes/shadow.ts',
  'packages/server/src/evolution/approval.ts',
  'packages/server/src/evolution/approval-signing.ts',
  'packages/server/src/evolution/artifact-hash.ts',
  'packages/server/src/evolution/autonomy.ts',
  'packages/server/src/evolution/control-plane.ts',
  'packages/server/src/evolution/generalization.ts',
  'packages/server/src/evolution/modification-gate.ts',
  'packages/server/src/evolution/risk.ts',
  'packages/server/src/evolution/rollback.ts',
  'packages/server/src/evolution/security.ts',
  'packages/server/src/evolution/system-rollback.ts',
  'packages/server/src/evolution/verifier.ts',
])

const SHORT_CONTROL_PLANE_PATTERNS = [
  /(^|\/)(auth|bootstrap|middleware|policy|guardrails|sandbox|compliance)\//i,
  /(^|\/)patching\/(security\.ts|governance\/)/i,
  /(^|\/)storage\/(db|schema|snapshots)\.ts$/i,
  /(^|\/)(ws-auth|token-provisioning|terminal-security)\.ts$/i,
  /(^|\/)routes\/(admin|orgs|me|research|coordination|evolution|shadow)\.ts$/i,
  /(^|\/)evolution\/(approval|approval-signing|artifact-hash|autonomy|control-plane|generalization|modification-gate|risk|rollback|security|system-rollback|verifier)\.ts$/i,
  /(^|\/)\.github\//i,
]

export function normalizeRepoPath(filePath: string): string {
  return filePath
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '')
    .replace(/^[ab]\//, '')
    .trim()
}

export function isProtectedControlPlanePath(filePath: string | null | undefined): boolean {
  if (!filePath || typeof filePath !== 'string') return false
  const norm = normalizeRepoPath(filePath)
  if (!norm) return false
  if (PROTECTED_CONTROL_PLANE_EXACT.has(norm)) return true
  if (PROTECTED_CONTROL_PLANE_PREFIXES.some((prefix) => norm.startsWith(prefix))) return true
  return SHORT_CONTROL_PLANE_PATTERNS.some((re) => re.test(norm))
}

/** Extract diff target file headers (`--- a/...`, `+++ b/...`, `diff --git a/... b/...`). */
export function extractDiffTargetPaths(text: string): string[] {
  const paths = new Set<string>()
  for (const line of text.split('\n')) {
    const gitMatch = /^diff --git\s+a\/(.+?)\s+b\/(.+)$/.exec(line)
    if (gitMatch) {
      if (gitMatch[1] && gitMatch[1] !== '/dev/null') paths.add(gitMatch[1].trim())
      if (gitMatch[2] && gitMatch[2] !== '/dev/null') paths.add(gitMatch[2].trim())
      continue
    }
    const hdrMatch = /^(?:---|\+\+\+)\s+(?:[ab]\/)?([^\t\n]+)$/.exec(line)
    if (hdrMatch && hdrMatch[1]) {
      const p = hdrMatch[1].trim()
      if (p !== '/dev/null' && p !== 'a' && p !== 'b') paths.add(p)
    }
  }
  return [...paths]
}

const BYPASS_PATTERNS: Array<{ re: RegExp; msg: string }> = [
  {
    re: /MIRA_STRICT_AUTH\s*[:=]\s*["']?0/i,
    msg: 'protected control-plane tampering: disables MIRA_STRICT_AUTH',
  },
  {
    re: /MIRA_SANDBOX_ALLOW_FALLBACK\s*[:=]\s*["']?(?:1|true)/i,
    msg: 'protected control-plane tampering: enables MIRA_SANDBOX_ALLOW_FALLBACK',
  },
  {
    re: /MIRA_SKIP_ROLLBACK_VERIFY\s*[:=]\s*["']?(?:1|true)/i,
    msg: 'protected control-plane tampering: disables rollback verification',
  },
  {
    re: /MIRA_ALLOW_UNSIGNED_APPROVALS\s*[:=]\s*["']?(?:1|true)/i,
    msg: 'protected control-plane tampering: disables signed approval verification',
  },
  {
    re: /guardrails\.enforce\s*[:=]\s*false/i,
    msg: 'protected control-plane tampering: disables guardrails.enforce',
  },
  {
    re: /\b(?:skipAuth|bypassAuth|disableAuth|authDisabled)\s*[:=]\s*true|\brequireAuth\s*[:=]\s*false/i,
    msg: 'protected control-plane tampering: bypasses authentication',
  },
  {
    re: /\b(?:ApprovalGate|SecurityValidator|RollbackManager|VerificationState)\b.*\b(?:bypass|disable|skip|noop)\b/i,
    msg: 'protected control-plane tampering: weakens or bypasses security/approval/rollback gate',
  },
  {
    re: /--no-verify\b/i,
    msg: 'protected control-plane tampering: attempts to skip verification hooks (--no-verify)',
  },
]

const TEST_WEAKENING_PATTERNS: Array<{ re: RegExp; msg: string }> = [
  {
    re: /\b(?:test|it|describe)\.skip\s*\(|\b(?:xit|xdescribe|xtest)\s*\(/,
    msg: 'test weakening: introduces skipped test',
  },
  {
    re: /expect\s*\(\s*true\s*\)\s*\.toBe\s*\(\s*true\s*\)/,
    msg: 'test weakening: trivial tautological assertion expect(true).toBe(true)',
  },
]

function addedLinesOrAll(text: string): string {
  const lines = text.split('\n')
  const isDiff = lines.some((l) => /^(diff --git |--- |\+\+\+ |@@ )/.test(l))
  if (!isDiff) return text
  return lines
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1))
    .join('\n')
}

function removedLines(text: string): string {
  const lines = text.split('\n')
  return lines
    .filter((l) => l.startsWith('-') && !l.startsWith('---'))
    .map((l) => l.slice(1))
    .join('\n')
}

export function detectControlPlaneTampering(
  patchText: string,
  changedFiles?: string[],
): string[] {
  const findings: string[] = []
  const text = String(patchText ?? '')
  const candidateTargets = new Set<string>([
    ...(changedFiles ?? []),
    ...extractDiffTargetPaths(text),
  ])

  for (const target of candidateTargets) {
    if (isProtectedControlPlanePath(target)) {
      findings.push(
        `protected control-plane path "${normalizeRepoPath(target)}" requires maintainer authorization`,
      )
    }
  }

  const added = addedLinesOrAll(text)
  for (const { re, msg } of BYPASS_PATTERNS) {
    if (re.test(added)) findings.push(msg)
  }

  for (const { re, msg } of TEST_WEAKENING_PATTERNS) {
    if (re.test(added)) findings.push(msg)
  }

  // Detect removal of protect() / security / approval enforcement in diffs
  const removed = removedLines(text)
  if (removed) {
    if (/\bprotect\s*\(/.test(removed) && !/\bprotect\s*\(/.test(added)) {
      findings.push('protected control-plane tampering: removes socket protect() call')
    }
    if (
      /\b(ApprovalGate|SecurityValidator|VerificationState|RollbackManager|authorizesArtifact|checkCapabilities)\b/.test(
        removed,
      ) &&
      !/\b(ApprovalGate|SecurityValidator|VerificationState|RollbackManager|authorizesArtifact|checkCapabilities)\b/.test(
        added,
      )
    ) {
      findings.push(
        'protected control-plane tampering: removes safety gate enforcement (ApprovalGate/SecurityValidator/RollbackManager)',
      )
    }
    const removedExpects = (removed.match(/\bexpect\s*\(/g) ?? []).length
    const addedExpects = (added.match(/\bexpect\s*\(/g) ?? []).length
    if (removedExpects > 0 && addedExpects === 0 && candidateTargets.size > 0) {
      findings.push('test weakening: removes test assertions without replacement')
    }
  }

  return findings
}
