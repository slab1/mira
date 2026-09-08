/**
 * Mira Shared — cross-machine safe paths
 *
 * Centralizes binary + temp + DB path resolution so Windows / macOS / Linux
 * all behave the same. Fixes ENOENT `uv_spawn 'bun'` on Windows (where "bun"
 * resolves to a .ps1 shim that libuv cannot exec) and `/tmp/*.db` paths that
 * don't exist on Windows.
 */
import { tmpdir } from 'node:os'
import { join, isAbsolute, normalize } from 'node:path'

declare const Bun: { which?: (bin: string) => string | null } | undefined

/** Absolute bun binary safe for Bun.spawn / child_process on any OS. */
export function resolveBunBinary(): string {
  try {
    const exec = process.execPath ?? ''
    if (exec.toLowerCase().includes('bun')) return exec
  } catch {}
  try {
    // Bun.which exists in Bun runtime; falls back to PATH lookup
    const which = (Bun as unknown as { which?: (bin: string) => string | null })?.which
    if (which) {
      const found = which('bun')
      if (found) return found
    }
  } catch {}
  // Windows needs explicit .exe — "bun" alone hits the .ps1 shim via PATH
  if (typeof process !== 'undefined' && process.platform === 'win32') {
    return 'bun.exe'
  }
  return 'bun'
}

/** Cross-platform temp file under os.tmpdir() (never hardcode /tmp). */
export function safeTempFile(name: string): string {
  const base = name.replace(/^\/tmp\//, '')
  return join(tmpdir(), base)
}

/** Normalize a DB path: /tmp/*.db → os.tmpdir() on Windows, mkdir-safe otherwise. */
export function normalizeDbPath(p: string): string {
  if (!p || p === ':memory:') return p
  if (p.startsWith('/tmp/') && process.platform === 'win32') {
    return safeTempFile(p.slice(5))
  }
  return normalize(p)
}

/** Safe cwd join for spawn: import.meta.dir + "/.." → normalized absolute. */
export function serverCwd(importMetaDir: string): string {
  return normalize(join(importMetaDir, '..'))
}

/** True when path is safe to write (blocks /etc, /proc, /sys, .. traversal). */
export function isSafeWritePath(p: string): boolean {
  const n = normalize(p)
  if (n.includes('..')) return false
  if (n.startsWith('/etc/') || n.startsWith('/proc/') || n.startsWith('/sys/')) return false
  if (/^[A-Z]:\\Windows\\/i.test(n)) return false
  return true
}

/** Ensure absolute spawn args: [bun, ...] → [absBun, ...] on any machine. */
export function safeSpawnArgs(command: string[]): string[] {
  if (command.length === 0) return command
  const [head, ...rest] = command
  if (head === 'bun' || head === 'bun.exe') return [resolveBunBinary(), ...rest]
  // absolute-ize relative script paths is caller's job; just pass through
  void isAbsolute
  return command
}
