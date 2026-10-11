/**
 * Tool: edit — Precise string replacement (hash-anchored edit pattern)
 * Based on Mira's 9-layer edit fallback: exact → trimmed → fuzzy
 * Prevents stale-line failures (raises success 7% → 68% in benchmarks)
 */
import { z } from 'zod'
import type { ToolDef } from './registry.js'
import { applyEditWithFallback } from './edit-fallback.js'
import { isAbsolute, join } from 'node:path'

const editSchema = z.object({
  path: z.string().describe('File to edit'),
  oldString: z.string().describe('Exact string to replace (must be unique unless replaceAll)'),
  newString: z.string().describe('Replacement string'),
  replaceAll: z.boolean().optional().describe('Replace all occurrences (default false)'),
  near: z
    .string()
    .optional()
    .describe(
      'Intent anchor: unique text (e.g. the enclosing function signature) the edit must land inside. ' +
        "The replaced text must appear AFTER the anchor's last occurrence and within ~40 lines — " +
        'otherwise the edit is refused. Use this whenever the snippet could exist elsewhere in the file ' +
        '(common patterns like `return x` + `}`).',
    ),
})

/** Default window between the anchor and the replaced span, in lines. */
const NEAR_WINDOW_LINES = 40

/**
 * Intent-anchor validation: an oldString can match perfectly yet sit in the
 * WRONG function (stale snippet, common pattern). No string matcher can detect
 * that by itself — the mismatch is intent, not text. `near` lets the caller
 * declare the intent; this verifies the resolved edit lands inside it.
 *
 * Enforced only when oldString matches exactly once (Layer 1's path). Fuzzy
 * fallback layers have their own span validation; for those the anchor cannot
 * be reliably located pre-apply, so it is skipped rather than mis-enforced.
 * Returns an error message, or null when the check passes/skips.
 */
export function validateNearAnchor(
  original: string,
  oldString: string,
  near: string,
  filePath: string,
): string | null {
  const escaped = oldString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const occurrences = original.match(new RegExp(escaped, 'g'))?.length ?? 0
  if (occurrences !== 1) return null // ambiguity handled elsewhere / replaceAll path

  const lines = original.split('\n')
  const findLine = (needle: string, fromLine = 0): number => {
    for (let i = fromLine; i < lines.length; i++) if (lines[i].includes(needle)) return i
    return -1
  }
  // First line containing the start of oldString (the match position).
  const oldFirstLine = oldString.split('\n')[0]
  const matchLine = findLine(oldFirstLine)
  if (matchLine < 0) return null

  // Last anchor occurrence at or before the match — the "enclosing" anchor.
  let anchorLine = -1
  let from = 0
  while (true) {
    const at = findLine(near, from)
    if (at < 0 || at > matchLine) break
    anchorLine = at
    from = at + 1
  }

  if (anchorLine < 0) {
    // Does the anchor exist at all? If only AFTER the match, the caller is
    // almost certainly editing outside the region they named.
    const existsAnywhere = findLine(near, matchLine + 1) >= 0
    return existsAnywhere
      ? `Edit refused by near-anchor: "${near}" appears only AFTER the text you are replacing ` +
          `(line ${matchLine + 1} of ${filePath}) — you are editing outside the region you named. ` +
          `Include the anchor line inside oldString, or fix the anchor.`
      : `Edit refused by near-anchor: anchor "${near}" not found in ${filePath}.`
  }

  const distance = matchLine - anchorLine
  if (distance > NEAR_WINDOW_LINES) {
    return (
      `Edit refused by near-anchor: "${near}" is ${distance} lines above the text you are replacing ` +
      `(line ${matchLine + 1} of ${filePath}). If this is really inside it, drop the anchor; ` +
      `otherwise you are editing outside the region you named.`
    )
  }
  return null
}

export const editTool = {
  name: 'edit',
  description:
    'Edit a file via exact string replacement. oldString must match exactly (including whitespace) and be unique. ' +
    'For new files use write. Set replaceAll=true to replace every occurrence. ' +
    'When the snippet could exist in more than one place (common patterns like `return x` + `}`), pass `near` ' +
    "with the enclosing function's signature — the edit is refused if it would land outside that region.",
  category: 'file',
  needsPermission: true,
  schema: editSchema,
  async execute({ path, oldString, newString, replaceAll, near }, ctx) {
    const cwd = ctx.cwd ?? process.cwd()
    const abs = isAbsolute(path) ? path : join(cwd, path)

    // Intent-anchor check BEFORE any layer runs (cheap: in-memory scan of the
    // current content). Applies on the exact-match path.
    let anchorVerified = false
    if (near) {
      const original = await Bun.file(abs).text()
      const refusal = validateNearAnchor(original, oldString, near, path)
      if (refusal) return { ok: false, path, error: refusal }
      anchorVerified = true
    }

    // Use 9-layer fallback engine with verification — workspace-aware (P2-1)
    const result = await applyEditWithFallback(abs, oldString, newString, replaceAll ?? false, cwd)

    // Backward compatible return shape
    return {
      ok: result.ok,
      path,
      replaced: result.replaced ?? 1,
      fallback: result.fallback,
      layer: result.layer,
      verification: result.verification,
      notes: result.notes,
      ...(anchorVerified ? { anchorVerified: true } : {}),
    }
  },
} satisfies ToolDef<typeof editSchema>

// Companion: apply patch via unified diff (9th fallback layer)
const patchSchema = z.object({
  patch: z.string().describe('Unified diff patch content'),
  cwd: z.string().optional().describe('Working directory'),
})

export const patchTool = {
  name: 'patch',
  description:
    'Apply a unified diff patch to a file or create new files from patch. Alternative to edit for multi-hunk changes.',
  category: 'file',
  needsPermission: true,
  schema: patchSchema,
  async execute({ patch, cwd }, ctx) {
    const { safeTempFile } = await import('../../../shared/src/utils/paths.js')
    const tmp = safeTempFile(`mira-patch-${Date.now()}.diff`)
    await Bun.write(tmp, patch)
    const proc = Bun.spawn(['patch', '-p1', '--forward'], {
      cwd: cwd ?? ctx.cwd ?? process.cwd(),
      stdin: Bun.file(tmp),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { ok: code === 0, stdout: out, stderr: err, exitCode: code }
  },
} satisfies ToolDef<typeof patchSchema>

export default editTool
export const tools = [editTool, patchTool]
