import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/** Resolve an absolute path only when it and its canonical target stay in a workspace. */
export function safeWorkspacePath(path: string, workspace: string): string | null {
  if (!path || !workspace || !isAbsolute(path) || !isAbsolute(workspace)) return null
  try {
    const rootAbs = resolve(workspace)
    const rootReal = realpathSync(rootAbs)
    const targetAbs = resolve(path)
    if (!isWithin(rootAbs, targetAbs) || targetAbs === rootAbs) return null

    // Resolve the closest existing ancestor so symlinked directories cannot escape
    // the workspace even when the snapshot target itself has not been created yet.
    let ancestor = targetAbs
    const tail: string[] = []
    while (!existsSync(ancestor)) {
      const parent = resolve(ancestor, '..')
      if (parent === ancestor) return null
      tail.unshift(ancestor.slice(parent.length + 1))
      ancestor = parent
    }
    const canonicalTarget = resolve(realpathSync(ancestor), ...tail)
    if (!isWithin(rootReal, canonicalTarget) || canonicalTarget === rootReal) return null
    return targetAbs
  } catch {
    return null
  }
}

/** Rebase an imported snapshot relative to its exported project into this workspace. */
export function remapImportedSnapshotPath(
  path: string,
  sourceWorkspace: string | null | undefined,
  targetWorkspace = process.cwd(),
): string | null {
  if (!path || !isAbsolute(path)) return null
  const source = sourceWorkspace && isAbsolute(sourceWorkspace) ? sourceWorkspace : targetWorkspace
  const safeSourcePath = safeWorkspacePath(path, source)
  if (!safeSourcePath) return null
  try {
    const sourceRoot = realpathSync(source)
    const targetRoot = realpathSync(targetWorkspace)
    const rel = relative(sourceRoot, safeSourcePath)
    if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) return null
    const target = resolve(targetRoot, rel)
    return safeWorkspacePath(target, targetRoot)
  } catch {
    return null
  }
}
