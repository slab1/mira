/**
 * Repo Timeline — bounded git-history analysis (master findings P1.5).
 *
 * Answers "what changed, when, and where does churn concentrate" from real
 * `git log` data. Bounded by construction: commit limit, per-commit file
 * limit, and a subprocess timeout are all hard-capped. Never interpolates
 * options into a shell — argv is built as a fixed array.
 *
 * Results are fed into WorkspaceIntelligence as `tech-debt` items for
 * hotspots, so the timeline composes with the dashboard instead of
 * maintaining a parallel store.
 */

import { spawnSync } from 'node:child_process'
import type { MiraDB } from '../storage/db.js'
import type { WorkspaceIntelligence } from '../workspace/intelligence.js'

export interface TimelineCommit {
  sha: string
  subject: string
  authoredAt: number
  files: string[]
}

export interface TimelineHotspot {
  file: string
  commits: number
  lastTouched: number
}

export interface RepoTimeline {
  ok: boolean
  reason?: string
  commits: TimelineCommit[]
  hotspots: TimelineHotspot[]
  /** commits whose subject matches revert/fix patterns — candidate regression windows */
  regressionSignals: string[]
  window: { since: number | null; limit: number }
  generatedAt: number
}

const COMMIT_HARD_CAP = 500
const FILES_PER_COMMIT_CAP = 100
const PROC_TIMEOUT_MS = 15_000
const REGRESSION_RE = /\b(revert|regression|hotfix|rollback)\b/i

export interface TimelineOptions {
  /** Max commits to scan (hard-capped at 500) */
  limit?: number
  /** ISO date or unix ms lower bound; null = unbounded */
  since?: string | number | null
  /** Also mirror hotspots into workspace intelligence */
  workspace?: WorkspaceIntelligence
}

function runGit(rootDir: string, args: string[]): string | null {
  const res = spawnSync('git', ['-C', rootDir, ...args], {
    encoding: 'utf-8',
    timeout: PROC_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
  })
  if (res.error || res.status !== 0) return null
  return res.stdout ?? ''
}

/** True when rootDir is inside a git working tree. */
export function isGitRepo(rootDir: string): boolean {
  const out = runGit(rootDir, ['rev-parse', '--is-inside-work-tree'])
  return out?.trim() === 'true'
}

export function analyzeTimeline(rootDir: string, opts: TimelineOptions = {}): RepoTimeline {
  const limit = Math.min(Math.max(1, opts.limit ?? 200), COMMIT_HARD_CAP)
  const sinceArg = (() => {
    if (opts.since == null) return null
    const iso = typeof opts.since === 'number' ? new Date(opts.since).toISOString() : opts.since
    return `--since=${iso.slice(0, 40)}`
  })()

  if (!isGitRepo(rootDir)) {
    return {
      ok: false,
      reason: 'not a git repository',
      commits: [],
      hotspots: [],
      regressionSignals: [],
      window: { since: null, limit },
      generatedAt: Date.now(),
    }
  }

  // One commit per record: sha<TAB>unixtime<TAB>subject, then a NUL, then name-only files
  const args = [
    'log',
    `--max-count=${limit}`,
    '--no-renames',
    '--format=%H%x09%at%x09%s%x00',
    '--name-only',
  ]
  if (sinceArg) args.push(sinceArg)
  const out = runGit(rootDir, args)

  const commits: TimelineCommit[] = []
  const churn = new Map<string, { commits: number; lastTouched: number }>()
  const regressionSignals: string[] = []

  if (out) {
    let current: TimelineCommit | null = null
    for (const line of out.split('\n')) {
      if (line.includes('\0')) {
        // commit header
        const [sha = '', at = '', subject = ''] = line.replace('\0', '').split('\t')
        current = {
          sha: sha.slice(0, 40),
          subject: subject.slice(0, 200),
          authoredAt: Number(at) * 1000 || Date.now(),
          files: [],
        }
        commits.push(current)
        if (REGRESSION_RE.test(current.subject))
          regressionSignals.push(`${current.sha.slice(0, 8)} ${current.subject}`)
        continue
      }
      const file = line.trim()
      if (!current || !file || file.length > 500) continue
      if (current.files.length >= FILES_PER_COMMIT_CAP) continue
      current.files.push(file)
      const prev = churn.get(file)
      if (prev) {
        prev.commits += 1
        prev.lastTouched = Math.max(prev.lastTouched, current.authoredAt)
      } else if (churn.size < 5000) {
        churn.set(file, { commits: 1, lastTouched: current.authoredAt })
      }
    }
  }

  const hotspots: TimelineHotspot[] = [...churn.entries()]
    .filter(([, v]) => v.commits > 1)
    .map(([file, v]) => ({ file, commits: v.commits, lastTouched: v.lastTouched }))
    .sort((a, b) => b.commits - a.commits || b.lastTouched - a.lastTouched)
    .slice(0, 25)

  return {
    ok: true,
    commits,
    hotspots,
    regressionSignals: regressionSignals.slice(0, 25),
    window: { since: typeof opts.since === 'number' ? opts.since : null, limit },
    generatedAt: Date.now(),
  }
}

/**
 * Analyze and mirror the top hotspot files into workspace intelligence as
 * `tech-debt` items (churn = coupling pressure = refactor candidates).
 * Idempotent — upsert dedupes by kind+title.
 */
export function analyzeTimelineToWorkspace(
  rootDir: string,
  workspace: WorkspaceIntelligence | undefined,
  opts: TimelineOptions = {},
): RepoTimeline {
  const timeline = analyzeTimeline(rootDir, opts)
  if (!timeline.ok || !workspace) return timeline
  try {
    for (const h of timeline.hotspots.slice(0, 10)) {
      const priority = h.commits >= 8 ? 'high' : h.commits >= 4 ? 'medium' : 'low'
      workspace?.upsert({
        kind: 'tech-debt',
        title: `hotspot: ${h.file.slice(-120)}`,
        description: `${h.commits} commits touch this file in the scanned window — consider decomposition or stabilization`,
        status: 'open',
        priority,
        metadata: { churn: h.commits, lastTouched: h.lastTouched, source: 'repo.timeline' },
      })
      // P2-3: high-churn files are fragility — also land in the memory_bank
      // tech_debt.md that every prompt reads. Fire-and-forget.
      if (priority !== 'low') {
        void import('../memory/memory_controller.js')
          .then((m) =>
            m.appendTeamMemory({
              file: 'tech_debt',
              summary: `hotspot: ${h.file} (${h.commits} commits in window)`,
              detail: 'consider decomposition or stabilization; from repo timeline churn analysis',
              source: 'repo.timeline',
              cwd: rootDir,
            }),
          )
          .catch(() => {})
      }
    }
  } catch {
    // best-effort mirroring — timeline result is still returned
  }
  return timeline
}

export type TimelineDeps = { db?: MiraDB }
