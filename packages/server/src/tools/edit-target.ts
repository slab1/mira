/**
 * Edit-target sanity signals (wrong-file detection).
 *
 * Mira enforces read-before-edit, but "did you read it" is not "should you
 * edit it". Nothing scored a target against what the session had actually been
 * working on, so the classic wrong-file mistake — editing `src/foo.ts` when
 * `src/foo/index.ts` (or a same-named file in a sibling package) was meant —
 * passed silently.
 *
 * These signals are deliberately narrow and evidence-based:
 *   1. **Same basename, different directory** as a file this session already
 *      read or edited. Near-certain wrong-file: the agent demonstrably had the
 *      other one in hand.
 *   2. **Creating a file that has a live twin elsewhere** (same basename under
 *      a sibling directory) — often a duplicate-module mistake.
 *   3. **Disjoint from session focus** (weak): the target's directory shares
 *      nothing with anything read this session. Advisory only; too weak to
 *      block on.
 *
 * Signal 1 can be made blocking (MIRA_STRICT_EDIT_TARGET=1); the rest are
 * always advisory. False positives must never silently discard work, so the
 * default is warn-and-show.
 */
import { existsSync, readdirSync, type Dirent } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'

/** Directories never scanned for twins. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'out'])

/** Hard cap on directories visited while looking for existing twins. */
const MAX_DIRS_SCANNED = 400

export interface EditTargetInput {
  /** Absolute path being mutated. */
  target: string
  /** Repo/project root used to bound the twin scan. */
  cwd: string
  /** Absolute paths read in this session. */
  sessionReads?: ReadonlySet<string>
  /** Absolute paths mutated in this session. */
  sessionTouches?: ReadonlySet<string>
}

export interface EditTargetSignal {
  /** The analyzed target (absolute). */
  target: string
  /** Human-readable advisories, safe to show the agent verbatim. */
  warnings: string[]
  /** Set only for the high-confidence wrong-file signal; blocks in strict mode. */
  nearMiss?: { path: string; kind: 'same-basename-read' | 'existing-twin' }
}

/** Relative-ish label for messages: last 3 path segments. */
function label(abs: string, cwd: string): string {
  const rel = abs.startsWith(cwd) ? abs.slice(cwd.length + 1) : abs
  const parts = rel.split(sep).filter(Boolean)
  return parts.length > 3 ? '…/' + parts.slice(-3).join('/') : rel
}

/**
 * Do two directories share at least one path segment below the project root?
 * `src/auth` and `src/db` do (share `src`); `src/auth` and `docs` do not.
 */
function sharesAncestorBelow(a: string, b: string, cwd: string): boolean {
  if (a === b) return true
  const rel = (p: string) =>
    (p.startsWith(cwd) ? p.slice(cwd.length) : p).split(sep).filter(Boolean)
  const pa = rel(a)
  const pb = rel(b)
  if (pa.length === 0 || pb.length === 0) return false // one IS the project root
  let shared = 0
  while (shared < pa.length && shared < pb.length && pa[shared] === pb[shared]) shared++
  return shared > 0
}

/**
 * Existing files with the same basename, found by a bounded breadth-first walk
 * upward from the target's directory. Bounded by MAX_DIRS_SCANNED so this can
 * never turn a tool call into a repo-wide crawl.
 */
function findExistingTwins(target: string, cwd: string): string[] {
  const name = basename(target)
  const found: string[] = []
  const seenDirs = new Set<string>()
  const queue: string[] = []
  // seed: the target's own directory and its siblings' subtrees, then walk up
  let dir = dirname(target)
  let depth = 0
  while (dir.length > 0 && dir.startsWith(cwd) && depth < 8) {
    queue.push(dir)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
    depth++
  }
  let scanned = 0
  while (queue.length > 0 && scanned < MAX_DIRS_SCANNED) {
    const current = queue.shift()!
    if (seenDirs.has(current)) continue
    seenDirs.add(current)
    scanned++
    let entries: Dirent[]
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.isFile() && e.name === name) found.push(join(current, e.name))
      else if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'))
        queue.push(join(current, e.name))
    }
  }
  return found
}

/**
 * Analyze a mutation target. Pure-ish: filesystem reads only for the
 * "creating a duplicate" check, and only when the target does not exist.
 */
export function analyzeEditTarget(input: EditTargetInput): EditTargetSignal {
  const { target, cwd } = input
  const warnings: string[] = []
  let nearMiss: EditTargetSignal['nearMiss']

  const name = basename(target)
  const seen = new Set<string>([...(input.sessionReads ?? []), ...(input.sessionTouches ?? [])])

  // Signal 1 — same basename, different file, already in this session's context.
  // Precision rule: only when the session saw EXACTLY ONE other file with that
  // name. If it read several same-named files (common for `index.ts`), the agent
  // is clearly working across sibling modules and a warning would be noise.
  const sameNamed = [...seen].filter((other) => other !== target && basename(other) === name)
  if (sameNamed.length === 1) {
    const other = sameNamed[0]
    nearMiss = { path: other, kind: 'same-basename-read' }
    warnings.push(
      `Possible wrong file: ${label(other, cwd)} has the same name and was read/edited earlier in this session. ` +
        `You are writing ${label(target, cwd)}.`,
    )
  }

  // Signal 2 — creating a file that duplicates one that already exists nearby.
  // Same precision rule: a single existing twin only.
  if (!existsSync(target)) {
    const twins = findExistingTwins(target, cwd).filter((p) => p !== target)
    if (twins.length === 1 && !nearMiss) {
      const twin = twins[0]
      nearMiss = { path: twin, kind: 'existing-twin' }
      warnings.push(
        `Possible duplicate module: ${label(twin, cwd)} already exists. ` +
          `Creating ${label(target, cwd)} may duplicate it.`,
      )
    }
  }

  // Signal 3 — weak: nothing in this session touches the target's area.
  // "Related" means sharing any ancestor below the project root, so ordinary
  // sibling modules (src/auth, src/cache, src/db) do NOT trigger this.
  if (warnings.length === 0 && seen.size > 0) {
    const targetDir = dirname(target)
    const related = [...seen].some((p) => sharesAncestorBelow(dirname(p), targetDir, cwd))
    if (!related) {
      warnings.push(
        `This file is outside everything read so far in this session ` +
          `(${label(target, cwd)}). Double-check it is the intended target.`,
      )
    }
  }

  return { target, warnings, nearMiss }
}

/** Strict mode: only the high-confidence signal blocks. */
export function strictEditTarget(): boolean {
  return process.env.MIRA_STRICT_EDIT_TARGET === '1'
}
