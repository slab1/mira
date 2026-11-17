import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fingerprintWorkspace } from './workspace-fingerprint.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'ignore', stderr: 'ignore' })
  const exitCode = await proc.exited
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed`)
}

describe('fingerprintWorkspace', () => {
  test('binds hashes to HEAD and exact tracked/untracked candidate contents', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'mira-candidate-hash-'))
    tempDirs.push(cwd)
    await git(cwd, 'init', '-q')
    await git(cwd, 'config', 'user.email', 'test@example.invalid')
    await git(cwd, 'config', 'user.name', 'Mira Test')
    await writeFile(join(cwd, 'tracked.txt'), 'base\n')
    await git(cwd, 'add', 'tracked.txt')
    await git(cwd, 'commit', '-qm', 'base')

    const base = await fingerprintWorkspace(cwd)
    expect(base?.baseHash).toMatch(/^[0-9a-f]{40,64}$/)
    expect(base?.candidateHash).toMatch(/^sha256:[0-9a-f]{64}$/)

    await writeFile(join(cwd, 'tracked.txt'), 'candidate\n')
    await writeFile(join(cwd, 'new-test.ts'), 'export {}\n')
    const changed = await fingerprintWorkspace(cwd)
    expect(changed?.baseHash).toBe(base?.baseHash)
    expect(changed?.candidateHash).not.toBe(base?.candidateHash)

    await git(cwd, 'add', 'tracked.txt', 'new-test.ts')
    await git(cwd, 'commit', '-qm', 'candidate')
    const committed = await fingerprintWorkspace(cwd)
    expect(committed?.baseHash).not.toBe(base?.baseHash)
    expect(committed?.candidateHash).not.toBe(changed?.candidateHash)
  })

  test('returns undefined when no Git base/candidate can be identified', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'mira-no-git-'))
    tempDirs.push(cwd)
    expect(await fingerprintWorkspace(cwd)).toBeUndefined()
  })
})
