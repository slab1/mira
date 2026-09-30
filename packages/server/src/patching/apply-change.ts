/**
 * Shared applyChange helper — appends a patch note to file content.
 * Used by both Applier and Verifier.
 */

export function applyChange(original: string, change: string, targetFile: string): string {
  const isMD = targetFile.endsWith('.md')
  const note = isMD
    ? `\n\n<!-- Mira Patch (${new Date().toISOString().slice(0, 10)}): ${change.slice(0, 300)} -->\n`
    : `\n\n// Mira Patch (${new Date().toISOString().slice(0, 10)}): ${change.slice(0, 300)}\n`
  if (original.includes(change.slice(0, 80))) return original
  return original + note
}
