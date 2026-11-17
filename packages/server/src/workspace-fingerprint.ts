import { createHash } from 'node:crypto'
import { lstat, readFile, readlink, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export interface WorkspaceFingerprint {
  baseHash: string
  candidateHash: string
}

const GIT_TIMEOUT_MS = 2_000
const MAX_GIT_LIST_BYTES = 2 * 1024 * 1024
const MAX_FILE_BYTES = 16 * 1024 * 1024
const MAX_TOTAL_BYTES = 64 * 1024 * 1024

async function gitOutput(cwd: string, args: string[]): Promise<Buffer | undefined> {
  try {
    const proc = Bun.spawn(['git', ...args], {
      cwd,
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: GIT_TIMEOUT_MS,
    })
    const [exitCode, output] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).arrayBuffer(),
    ])
    if (exitCode !== 0 || output.byteLength > MAX_GIT_LIST_BYTES) return undefined
    return Buffer.from(output)
  } catch {
    return undefined
  }
}

function nulSeparated(buffer: Buffer): string[] | undefined {
  const entries: string[] = []
  let start = 0
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] !== 0) continue
    const bytes = buffer.subarray(start, i)
    const entry = bytes.toString('utf8')
    if (!Buffer.from(entry, 'utf8').equals(bytes)) return undefined
    if (entry.length > 0) entries.push(entry)
    start = i + 1
  }
  if (start < buffer.length) return undefined
  return entries
}

/**
 * Fingerprint a Git candidate without modifying its index or working tree.
 * The hash includes HEAD plus current contents (or deletion markers) for every
 * tracked change and non-ignored untracked file. Large/invalid workspaces fail
 * closed by returning undefined; callers may still run the command, but must
 * not treat its result as candidate-bound verification.
 */
export async function fingerprintWorkspace(cwd: string): Promise<WorkspaceFingerprint | undefined> {
  try {
    const [rootText, baseText] = await Promise.all([
      gitOutput(cwd, ['rev-parse', '--show-toplevel']),
      gitOutput(cwd, ['rev-parse', 'HEAD']),
    ])
    if (!rootText || !baseText) return undefined

    const root = await realpath(rootText.toString('utf8').trim())
    const baseHash = baseText.toString('utf8').trim()
    if (!root || !baseHash) return undefined

    const [trackedOutput, untrackedOutput] = await Promise.all([
      gitOutput(root, ['diff', '--name-only', '-z', '--no-ext-diff', '--no-renames', 'HEAD', '--']),
      gitOutput(root, ['ls-files', '--others', '--exclude-standard', '-z']),
    ])
    if (!trackedOutput || !untrackedOutput) return undefined

    const trackedNames = nulSeparated(trackedOutput)
    const untrackedNames = nulSeparated(untrackedOutput)
    if (!trackedNames || !untrackedNames) return undefined
    const names = [...new Set([...trackedNames, ...untrackedNames])].sort()
    const hash = createHash('sha256')
    hash.update(`base:${baseHash}\n`)
    let totalBytes = 0

    for (const name of names) {
      const absolutePath = resolve(root, name)
      const rel = relative(root, absolutePath)
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined
      hash.update(`path:${name}\0`)

      try {
        const stat = await lstat(absolutePath)
        hash.update(`mode:${stat.mode & 0o777}\0`)
        if (stat.isSymbolicLink()) {
          const target = await readlink(absolutePath)
          const bytes = Buffer.from(target)
          totalBytes += bytes.byteLength
          if (bytes.byteLength > MAX_FILE_BYTES || totalBytes > MAX_TOTAL_BYTES) return undefined
          hash.update('symlink\0')
          hash.update(bytes)
        } else if (stat.isFile()) {
          if (stat.size > MAX_FILE_BYTES) return undefined
          const bytes = await readFile(absolutePath)
          totalBytes += bytes.byteLength
          if (totalBytes > MAX_TOTAL_BYTES) return undefined
          hash.update('file\0')
          hash.update(bytes)
        } else {
          hash.update('non-file\0')
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined
        hash.update('deleted\0')
      }
      hash.update('\0')
    }

    return { baseHash, candidateHash: `sha256:${hash.digest('hex')}` }
  } catch {
    return undefined
  }
}
