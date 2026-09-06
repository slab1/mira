/**
 * Symbol Watcher — fs.watch + didChange hook
 * Watches workspace files and invalidates symbol cache / notifies LSP on change.
 */

import { watch, type FSWatcher } from 'node:fs'
import { resolve } from 'node:path'
import { symbolCache } from './cache.js'

type ChangeCallback = (filePath: string, content: string) => void | Promise<void>

export class SymbolWatcher {
  private watchers = new Map<string, FSWatcher>()
  private callbacks = new Set<ChangeCallback>()
  private root: string
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(root = process.cwd()) {
    this.root = resolve(root)
  }

  /**
   * Register a callback for file changes (e.g., LSP didChange).
   */
  onDidChange(cb: ChangeCallback): () => void {
    this.callbacks.add(cb)
    return () => this.callbacks.delete(cb)
  }

  /**
   * Watch a single file for changes. Invalidates symbol cache and fires didChange hooks.
   */
  watchFile(filePath: string): void {
    const abs = filePath.startsWith('/') ? filePath : resolve(this.root, filePath)
    if (this.watchers.has(abs)) return

    try {
      const watcher = watch(abs, async (eventType) => {
        if (eventType !== 'change' && eventType !== 'rename') return

        // Debounce rapid changes
        const existing = this.debounceTimers.get(abs)
        if (existing) clearTimeout(existing)

        const timer = setTimeout(async () => {
          this.debounceTimers.delete(abs)
          // Invalidate symbol cache
          symbolCache.invalidate(abs)
          symbolCache.invalidate(filePath)

          // Read new content and notify callbacks
          let content = ''
          try {
            content = await Bun.file(abs).text()
          } catch {
            // file deleted or unreadable
          }

          for (const cb of this.callbacks) {
            try {
              await cb(abs, content)
            } catch {}
          }
        }, 50)

        this.debounceTimers.set(abs, timer)
      })

      watcher.on('error', () => {
        this.watchers.delete(abs)
      })

      this.watchers.set(abs, watcher)
    } catch {
      // file may not exist yet — ignore
    }
  }

  /**
   * Watch a directory recursively (best-effort).
   */
  watchDir(dirPath: string): void {
    const abs = dirPath.startsWith('/') ? dirPath : resolve(this.root, dirPath)
    if (this.watchers.has(abs)) return

    try {
      const watcher = watch(abs, { recursive: true }, async (eventType, filename) => {
        if (!filename) return
        const full = resolve(abs, filename.toString())
        // Only care about source files
        if (!/\.(ts|tsx|js|jsx|go|py|rs)$/.test(full)) return

        const existing = this.debounceTimers.get(full)
        if (existing) clearTimeout(existing)

        const timer = setTimeout(async () => {
          this.debounceTimers.delete(full)
          symbolCache.invalidate(full)

          let content = ''
          try {
            content = await Bun.file(full).text()
          } catch {}

          for (const cb of this.callbacks) {
            try {
              await cb(full, content)
            } catch {}
          }
        }, 50)

        this.debounceTimers.set(full, timer)
      })

      watcher.on('error', () => {
        this.watchers.delete(abs)
      })

      this.watchers.set(abs, watcher)
    } catch {}
  }

  /**
   * Manually trigger didChange for a file (e.g., after an edit).
   */
  async didChange(filePath: string, content: string): Promise<void> {
    const abs = filePath.startsWith('/') ? filePath : resolve(this.root, filePath)
    symbolCache.invalidate(abs)
    symbolCache.invalidate(filePath)
    for (const cb of this.callbacks) {
      try {
        await cb(abs, content)
      } catch {}
    }
  }

  /**
   * Stop watching a file.
   */
  unwatch(filePath: string): void {
    const abs = filePath.startsWith('/') ? filePath : resolve(this.root, filePath)
    const w = this.watchers.get(abs)
    if (w) {
      try {
        w.close()
      } catch {}
      this.watchers.delete(abs)
    }
    const t = this.debounceTimers.get(abs)
    if (t) {
      clearTimeout(t)
      this.debounceTimers.delete(abs)
    }
  }

  /**
   * Close all watchers.
   */
  close(): void {
    for (const [, w] of this.watchers) {
      try {
        w.close()
      } catch {}
    }
    this.watchers.clear()
    for (const [, t] of this.debounceTimers) {
      clearTimeout(t)
    }
    this.debounceTimers.clear()
  }

  size(): number {
    return this.watchers.size
  }
}

export const symbolWatcher = new SymbolWatcher()
