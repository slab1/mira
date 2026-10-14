/**
 * Content-addressed approval binding.
 *
 * An approval authorizes a specific artifact — a specific diff against a
 * specific file. Keying approval on a proposal id alone is not enough: the id
 * travels separately from the bytes that will actually be applied, so an
 * approval can be recorded against one artifact and spent on another.
 *
 * Both sides of the system can compute the same hash from what they hold:
 *   - the observe flow holds the candidate diff + target file
 *   - the promote flow holds PatchProposal.change + targetFile
 * so promotion can ask "was an authoritative human approval recorded for
 * exactly these bytes?" without depending on the two id spaces lining up.
 */

import { createHash } from 'node:crypto'

export interface ApprovalArtifact {
  /** File the change applies to. */
  targetFile?: string | null
  /** The diff / change text. */
  change?: string | null
}

/**
 * Stable hash of an artifact. Length-prefixed fields so no pair of different
 * inputs can collide by shifting the separator (e.g. targetFile "a\0b" vs
 * targetFile "a" + change "b").
 */
export function artifactHash(artifact: ApprovalArtifact): string {
  const target = String(artifact.targetFile ?? '')
  const change = String(artifact.change ?? '')
  const h = createHash('sha256')
  h.update('targetFile:')
  h.update(target)
  h.update('\u0000len:')
  h.update(String(target.length))
  h.update('\u0000change:')
  h.update(change)
  h.update('\u0000len:')
  h.update(String(change.length))
  return h.digest('hex').slice(0, 32)
}

/** True when both artifacts hash identically. */
export function sameArtifact(a: ApprovalArtifact, b: ApprovalArtifact): boolean {
  return artifactHash(a) === artifactHash(b)
}
