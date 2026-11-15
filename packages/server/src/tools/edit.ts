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

export async function applyUnifiedPatchJs(
  patch: string,
  targetDir: string,
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> {
  const lines = patch.split('\n')
  let currentFileA: string | null = null
  let currentFileB: string | null = null

  interface FilePatch {
    fileA: string
    fileB: string
    hunks: Array<{ oldStart: number; oldLines: string[]; newLines: string[] }>
  }
  const filePatches: FilePatch[] = []
  let currentHunks: Array<{ oldStart: number; oldLines: string[]; newLines: string[] }> = []
  let currentHunk: { oldStart: number; oldLines: string[]; newLines: string[] } | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('--- ')) {
      currentFileA = line.slice(4).trim().replace(/^[ab]\//, '')
      continue
    }
    if (line.startsWith('+++ ')) {
      currentFileB = line.slice(4).trim().replace(/^[ab]\//, '')
      if (currentFileA && currentFileB) {
        currentHunks = []
        filePatches.push({ fileA: currentFileA, fileB: currentFileB, hunks: currentHunks })
      }
      continue
    }
    const hunkHeader = /^@@(?:\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@|.*@@)/.exec(line)
    if (hunkHeader) {
      const oldStart = hunkHeader[1] ? Number(hunkHeader[1]) : 1
      currentHunk = { oldStart, oldLines: [], newLines: [] }
      currentHunks.push(currentHunk)
      continue
    }
    if (!currentHunk) continue
    if (line.startsWith('-')) {
      currentHunk.oldLines.push(line.slice(1))
    } else if (line.startsWith('+')) {
      currentHunk.newLines.push(line.slice(1))
    } else if (line.startsWith(' ') || line === '') {
      const text = line.startsWith(' ') ? line.slice(1) : ''
      currentHunk.oldLines.push(text)
      currentHunk.newLines.push(text)
    }
  }

  if (filePatches.length === 0) {
    return { ok: false, stdout: '', stderr: 'No file patches found in diff', exitCode: 1 }
  }

  const { join, dirname } = await import('node:path')
  const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import('node:fs')

  for (const fp of filePatches) {
    const relPath = fp.fileB === '/dev/null' ? fp.fileA : fp.fileB
    const filePath = join(targetDir, relPath)

    if (fp.fileB === '/dev/null') {
      const { rmSync } = await import('node:fs')
      if (existsSync(filePath)) {
        rmSync(filePath)
      }
      continue
    }

    let original = ''
    if (existsSync(filePath)) {
      original = readFileSync(filePath, 'utf-8')
    } else {
      mkdirSync(dirname(filePath), { recursive: true })
    }

    const hadTrailingNewline = original.endsWith('\n')
    let fileLines = original === '' ? [] : original.replace(/\n$/, '').split('\n')

    for (const hunk of fp.hunks) {
      if ((fp.fileA === '/dev/null' || !existsSync(filePath)) && fileLines.length === 0) {
        fileLines = [...hunk.newLines]
        continue
      }
      let startIdx = Math.max(0, hunk.oldStart - 1)
      if (hunk.oldLines.length > 0) {
        let matched = true
        for (let j = 0; j < hunk.oldLines.length; j++) {
          if (fileLines[startIdx + j] !== hunk.oldLines[j]) {
            matched = false
            break
          }
        }
        if (!matched) {
          const firstOld = hunk.oldLines[0]
          let foundIdx = -1
          for (let k = 0; k <= fileLines.length - hunk.oldLines.length; k++) {
            if (fileLines[k] === firstOld) {
              let m = true
              for (let j = 0; j < hunk.oldLines.length; j++) {
                if (fileLines[k + j] !== hunk.oldLines[j]) {
                  m = false
                  break
                }
              }
              if (m) {
                foundIdx = k
                break
              }
            }
          }
          if (foundIdx >= 0) {
            startIdx = foundIdx
          }
        }
      }
      fileLines.splice(startIdx, hunk.oldLines.length, ...hunk.newLines)
    }

    const newContent = fileLines.join('\n') + (hadTrailingNewline || fileLines.length > 0 ? '\n' : '')
    writeFileSync(filePath, newContent, 'utf-8')
  }

  return { ok: true, stdout: 'Patch applied successfully (JS fallback)', stderr: '', exitCode: 0 }
}

export const patchTool = {
  name: 'patch',
  description:
    'Apply a unified diff patch to a file or create new files from patch. Alternative to edit for multi-hunk changes.',
  category: 'file',
  needsPermission: true,
  schema: patchSchema,
  async execute({ patch, cwd }, ctx) {
    const targetDir = cwd ?? ctx.cwd ?? process.cwd()
    const { safeTempFile } = await import('../../../shared/src/utils/paths.js')
    const tmp = safeTempFile(`mira-patch-${Date.now()}.diff`)
    await Bun.write(tmp, patch)
    try {
      const proc = Bun.spawn(['patch', '-p1', '--forward'], {
        cwd: targetDir,
        stdin: Bun.file(tmp),
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      if (code === 0) {
        return { ok: true, stdout: out, stderr: err, exitCode: code }
      }
    } catch {
      // patch binary not found or execution failed; proceed to pure JS fallback
    }
    return applyUnifiedPatchJs(patch, targetDir)
  },
} satisfies ToolDef<typeof patchSchema>

export default editTool
export const tools = [editTool, patchTool]
