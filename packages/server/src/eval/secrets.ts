/**
 * Mira Eval — Secrets Scanner (no-secrets PR check)
 *
 * Real scan of git-changed files for high-signal secret patterns.
 * Returns the list of flagged file paths (plus matching pattern). Scans:
 *   - staged + unstaged working-tree changes (`git status --porcelain`)
 *   - commits since the merge-base with the upstream/origin branch, falling
 *     back to HEAD~1 when no upstream exists
 *
 * Test/fixture files are excluded to avoid false positives on mock tokens.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SECRET_PATTERNS: Array<{ re: RegExp; detail: string }> = [
  { re: /sk-(proj-)?[A-Za-z0-9]{20,}/, detail: 'OpenAI-style API key' },
  { re: /sk-ant-[A-Za-z0-9\-]{20,}/, detail: 'Anthropic API key' },
  { re: /ghp_[A-Za-z0-9]{36,}/, detail: 'GitHub PAT' },
  { re: /github_pat_[A-Za-z0-9_]{22,}/, detail: 'GitHub fine-grained PAT' },
  { re: /AKIA[0-9A-Z]{16}/, detail: 'AWS access key' },
  { re: /xox[bpras]-[0-9A-Za-z\-]{10,}/, detail: 'Slack token' },
  { re: /-----BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY-----/, detail: 'Private key material' },
]

/** Paths excluded from the scan (fixtures/tests frequently hold mock tokens). */
const IGNORED_SEGMENTS = [
  '.test.',
  '.spec.',
  '/test-data/',
  '/fixtures/',
  '/mock-',
  '.snap',
  'node_modules',
  '.git/',
]

function isIgnored(file: string): boolean {
  return IGNORED_SEGMENTS.some((seg) => file.includes(seg))
}

function run(cmd: string[]): string {
  try {
    const proc = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' })
    if (proc.exitCode !== 0) return ''
    return new TextDecoder().decode(proc.stdout)
  } catch {
    return ''
  }
}

function changedFiles(cwd: string): string[] {
  const files = new Set<string>()
  // Working tree + staged changes
  const status = run(['git', 'status', '--porcelain', '--untracked-files=normal'])
  for (const line of status.split('\n')) {
    if (!line.trim()) continue
    // porcelain format: <XY> <path>
    files.add(line.slice(3).trim())
  }
  // Committed since the upstream merge-base (HEAD~1 when no upstream exists)
  let base = ''
  const upstream = run([
    'git',
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{upstream}',
  ]).trim()
  if (upstream) {
    base = run(['git', 'merge-base', 'HEAD', upstream]).trim()
  }
  if (!base) {
    const head = run(['git', 'rev-parse', '--verify', 'HEAD~1']).trim()
    if (head) base = head
  }
  if (base) {
    const diff = run(['git', 'diff', '--name-only', `${base}..HEAD`])
    for (const line of diff.split('\n')) if (line.trim()) files.add(line.trim())
  }
  const result: string[] = []
  for (const f of files) {
    if (!f || f.startsWith('"')) continue // skip quoted/renamed porcelain entries
    if (isIgnored(f)) continue
    result.push(join(cwd, f))
  }
  return result
}

export function scanChangedFilesForSecrets(
  cwd = process.cwd(),
): Array<{ file: string; detail: string }> {
  const flags: Array<{ file: string; detail: string }> = []
  for (const absPath of changedFiles(cwd)) {
    if (!existsSync(absPath)) continue
    let text = ''
    try {
      text = readFileSync(absPath, 'utf-8')
    } catch {
      continue
    }
    for (const { re, detail } of SECRET_PATTERNS) {
      if (re.test(text)) {
        flags.push({ file: absPath.slice(cwd.length + 1), detail })
        break
      }
    }
  }
  return flags
}
