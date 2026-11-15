import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { remapImportedSnapshotPath, safeWorkspacePath } from './snapshot-paths.js'

describe('snapshot workspace path boundary', () => {
  test('accepts legitimate project files and rejects traversal/outside paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'mira-safe-snapshot-'))
    try {
      expect(safeWorkspacePath(join(root, 'src', 'main.ts'), root)).toBe(
        join(root, 'src', 'main.ts'),
      )
      expect(safeWorkspacePath(join(root, '..', 'outside.txt'), root)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('rejects symlink escapes and rebases imported project-relative paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'mira-safe-snapshot-'))
    const source = join(root, 'source')
    const target = join(root, 'target')
    const outside = join(root, 'outside')
    try {
      mkdirSync(source)
      mkdirSync(target)
      mkdirSync(outside)
      symlinkSync(outside, join(target, 'escape'))
      expect(safeWorkspacePath(join(target, 'escape', 'secret'), target)).toBeNull()
      expect(remapImportedSnapshotPath(join(source, 'src', 'a.ts'), source, target)).toBe(
        join(target, 'src', 'a.ts'),
      )
      expect(
        remapImportedSnapshotPath(join(source, '..', 'outside', 'secret'), source, target),
      ).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
