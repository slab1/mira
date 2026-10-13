/**
 * Shared applyChange helper — applies a real change to file content.
 * Used by both Applier and Verifier.
 *
 * Two modes, in strict precedence:
 *   1. REAL unified diff — when `change` is a well-formed unified diff
 *      (git-style `--- a/…` / `+++ b/…` with @@ hunks), it is APPLIED with
 *      context verification. This is what makes a candidate variant tree a
 *      genuinely different code path: a diff that fails to apply returns
 *      null, so the caller knows no change happened (fail-closed).
 *   2. Note append — the legacy fallback for prose intent: append a dated
 *      `// Mira Patch` / `<!-- Mira Patch -->` comment. Idempotent.
 *
 * Rationale (MIRA_WEAKNESSES §3/§5): a candidate measured in a shadow tree
 * is only meaningful if the tree contains a REAL change. Appending a comment
 * produces a tree that compiles for reasons unrelated to the change — worse
 * than no measurement. `patching/diff.ts` already synthesizes anchored diffs;
 * this applies them.
 */

/** True when the text looks like a unified diff we can apply. */
export function isUnifiedDiff(change: string): boolean {
  const s = String(change ?? '')
  return /^---\s+a\//m.test(s) && /^\+\+\+\s+b\//m.test(s) && /^@@\s+-\d+/m.test(s)
}

interface Hunk {
  oldStart: number
  oldLines: string[]
  newLines: string[]
}

/** Parse hunks from a unified diff (context/+/− lines). */
function parseHunks(change: string): Hunk[] {
  const lines = String(change).split('\n')
  const hunks: Hunk[] = []
  let current: Hunk | null = null
  for (const line of lines) {
    const header = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line)
    if (header) {
      current = { oldStart: Number(header[1]), oldLines: [], newLines: [] }
      hunks.push(current)
      continue
    }
    if (!current) continue
    if (line.startsWith('---') || line.startsWith('+++')) continue
    if (line.startsWith('diff ') || line.startsWith('index ')) continue
    if (line.startsWith('\\')) continue // "\ No newline at end of file"
    if (line.startsWith('-')) {
      current.oldLines.push(line.slice(1))
    } else if (line.startsWith('+')) {
      current.newLines.push(line.slice(1))
    } else if (line.startsWith(' ') || line === '') {
      const text = line.startsWith(' ') ? line.slice(1) : ''
      current.oldLines.push(text)
      current.newLines.push(text)
    }
  }
  return hunks
}

/**
 * Apply a unified diff to `original`.
 * Returns the patched content, or null when the diff does not match the
 * original (context drift) — the caller must treat null as "no change made".
 */
export function applyUnifiedDiff(original: string, diff: string): string | null {
  const hunks = parseHunks(diff)
  if (hunks.length === 0) return null
  const hadTrailingNewline = original.endsWith('\n')
  const lines = original === '' ? [] : original.replace(/\n$/, '').split('\n')

  // Apply hunks in order; each hunk is anchored at oldStart (1-based) with
  // exact context verification — a mismatch aborts the whole diff.
  for (const hunk of hunks) {
    const idx = Math.max(0, hunk.oldStart - 1)
    // Verify the removed/context lines match the file at the anchor.
    for (let i = 0; i < hunk.oldLines.length; i++) {
      const actual = lines[idx + i]
      if (actual !== hunk.oldLines[i]) {
        // Context drift — refuse rather than apply a partial/incorrect change.
        return null
      }
    }
    lines.splice(idx, hunk.oldLines.length, ...hunk.newLines)
  }
  return lines.join('\n') + (hadTrailingNewline ? '\n' : '')
}

export function applyChange(original: string, change: string, targetFile: string): string {
  // Mode 1 — real unified diff: apply it, and only fall through when it does
  // not match (stale context) so the caller can decide what to do.
  if (isUnifiedDiff(change)) {
    const patched = applyUnifiedDiff(original, change)
    if (patched !== null) return patched
    // Diff did not apply — do NOT silently append a comment pretending the
    // change landed. The Applier treats "no change" as not-applied.
    return original
  }

  // Mode 2 — legacy note append (prose intent).
  const isMD = targetFile.endsWith('.md')
  const note = isMD
    ? `\n\n<!-- Mira Patch (${new Date().toISOString().slice(0, 10)}): ${change.slice(0, 300)} -->\n`
    : `\n\n// Mira Patch (${new Date().toISOString().slice(0, 10)}): ${change.slice(0, 300)}\n`
  if (original.includes(change.slice(0, 80))) return original
  return original + note
}
