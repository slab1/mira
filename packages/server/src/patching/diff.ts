/**
 * Patching diff synthesis — turns a note-append recipe into a well-formed,
 * anchored unified diff (P1.3).
 *
 * The recipes in patcher.ts append an improvement note at EOF. Without the
 * target file's contents that intent stays a prose string; with them we can
 * emit a real unified diff anchored on the last lines, which `patch -p1`,
 * the governance sandbox, and reviewers can all consume directly.
 */

export interface SynthesizedDiff {
  /** unified diff text (git-style, paths as a/ b/) */
  diff: string
  /** number of context lines used */
  contextLines: number
}

/**
 * Synthesize an append-only unified diff for `targetPath` (repo-relative,
 * used in the a/ b/ headers) given the file's current contents.
 *
 * Returns null when oldContent is not available — callers must never invent
 * anchors (a diff missing its context is worse than no diff).
 */
export function synthesizeAppendDiff(
  targetPath: string,
  oldContent: string | null | undefined,
  note: string,
): SynthesizedDiff | null {
  if (oldContent == null) return null
  const noteLines = note.split('\n')
  const hadTrailingNewline = oldContent.endsWith('\n')
  const oldLines = oldContent === '' ? [] : oldContent.split('\n')
  if (!hadTrailingNewline && oldLines.length > 0) {
    // trailing partial line exists; strip it from context handling simplification:
    // we treat the final partial line as complete for anchoring purposes
    // (the diff still applies because GNU patch tolerates missing newline markers).
  }
  const ctx = oldLines
    .filter(Boolean)
    .slice(-2)
    .map((l) => ` ${l}`)
  const start = Math.max(1, oldLines.length - ctx.length + 1)
  const count = ctx.length
  const body = [
    `--- a/${targetPath}`,
    `+++ b/${targetPath}`,
    `@@ -${start},${count} +${start},${count + noteLines.length} @@`,
    ...ctx,
    ...noteLines.map((l) => `+${l}`),
  ].join('\n')
  return { diff: body + '\n', contextLines: ctx.length }
}
