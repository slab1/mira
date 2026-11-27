import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase, migrate, type MiraDB } from '../storage/db.js'
import { mountWorkspaceRoutes } from './workspace.js'
import { mountWorkspacesRoutes } from './workspaces.js'

let db: MiraDB
let server: { stop: (c?: boolean) => void; port: number | undefined }
let BASE: string
let workDir: string
let outsideDir: string

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'mira-ws-test-'))
  outsideDir = mkdtempSync(join(tmpdir(), 'mira-ws-outside-'))
  mkdirSync(join(workDir, 'src'), { recursive: true })
  writeFileSync(join(workDir, 'src/hello.ts'), 'export const greet = () => "hi"\n', 'utf-8')
  writeFileSync(join(workDir, '.env'), 'SECRET=topsecret\n', 'utf-8')
  writeFileSync(join(workDir, '.env.example'), 'SECRET=\n', 'utf-8')
  writeFileSync(join(workDir, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff]))
  writeFileSync(join(outsideDir, 'leak.txt'), 'nope\n', 'utf-8')

  db = createDatabase(':memory:')
  await migrate(db)
  const app = new Hono<{ Variables: { requestId: string } }>()
  mountWorkspaceRoutes(app, { db })
  mountWorkspacesRoutes(app, { db })
  server = Bun.serve({ port: 0, fetch: app.fetch })
  BASE = `http://127.0.0.1:${server.port}`
})

afterEach(() => {
  try {
    server.stop(true)
  } catch {}
  try {
    rmSync(workDir, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
  } catch {}
})

describe('Workspace file & git-status routes', () => {
  test('GET /workspace/file reads allowed text files inside workspace', async () => {
    const res = await fetch(
      `${BASE}/workspace/file?cwd=${encodeURIComponent(workDir)}&path=${encodeURIComponent('src/hello.ts')}`,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.ok).toBe(true)
    expect(body.content).toContain('export const greet')
    expect(body.binary).toBe(false)
    expect(body.lines).toBe(2)
  })

  test('GET /workspace/file allows .env.example but blocks .env and traversal', async () => {
    const exampleRes = await fetch(
      `${BASE}/workspace/file?cwd=${encodeURIComponent(workDir)}&path=.env.example`,
    )
    expect(exampleRes.status).toBe(200)

    const envRes = await fetch(
      `${BASE}/workspace/file?cwd=${encodeURIComponent(workDir)}&path=.env`,
    )
    expect(envRes.status).toBe(403)

    const travRes = await fetch(
      `${BASE}/workspace/file?cwd=${encodeURIComponent(workDir)}&path=${encodeURIComponent('../leak.txt')}`,
    )
    expect(travRes.status).toBe(400)

    const gitRes = await fetch(
      `${BASE}/workspace/file?cwd=${encodeURIComponent(workDir)}&path=${encodeURIComponent('.git/config')}`,
    )
    expect(gitRes.status).toBe(403)
  })

  test('GET /workspace/file detects binary files without dumping raw bytes', async () => {
    const res = await fetch(
      `${BASE}/workspace/file?cwd=${encodeURIComponent(workDir)}&path=binary.bin`,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.binary).toBe(true)
    expect(body.content).toBeNull()
  })

  test('GET /workspace/file blocks symlinks escaping workspace root', async () => {
    symlinkSync(join(outsideDir, 'leak.txt'), join(workDir, 'escape.txt'))
    const res = await fetch(
      `${BASE}/workspace/file?cwd=${encodeURIComponent(workDir)}&path=escape.txt`,
    )
    expect(res.status).toBe(403)
  })

  test('PUT and POST /workspace/file write/create files and record snapshots for /changes', async () => {
    // Update existing file
    const putRes = await fetch(`${BASE}/workspace/file`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cwd: workDir,
        path: 'src/hello.ts',
        content: 'export const greet = () => "updated"\n',
      }),
    })
    expect(putRes.status).toBe(200)
    const putBody = (await putRes.json()) as any
    expect(putBody.ok).toBe(true)
    expect(putBody.created).toBe(false)
    expect(typeof putBody.snapshotId).toBe('string')
    expect(readFileSync(join(workDir, 'src/hello.ts'), 'utf-8')).toContain('updated')

    // Create new file via POST
    const postRes = await fetch(`${BASE}/workspace/file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cwd: workDir,
        path: 'src/nested/newFile.ts',
        content: 'export const n = 1\n',
      }),
    })
    expect(postRes.status).toBe(200)
    const postBody = (await postRes.json()) as any
    expect(postBody.created).toBe(true)

    // POST on existing file fails with 409
    const conflictRes = await fetch(`${BASE}/workspace/file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cwd: workDir,
        path: 'src/nested/newFile.ts',
        content: 'overwrite?',
      }),
    })
    expect(conflictRes.status).toBe(409)

    // Verify /changes captured both browser edit snapshots
    const changesRes = await fetch(`${BASE}/changes`)
    expect(changesRes.status).toBe(200)
    const changes = (await changesRes.json()) as Array<Record<string, unknown>>
    expect(changes.length).toBeGreaterThanOrEqual(2)
  })

  test('GET /workspace/git-status returns structured status on git and non-git dirs', async () => {
    const nonGitRes = await fetch(
      `${BASE}/workspace/git-status?cwd=${encodeURIComponent(workDir)}`,
    )
    expect(nonGitRes.status).toBe(200)
    const nonGit = (await nonGitRes.json()) as any
    expect(nonGit.isGitRepo).toBe(false)
    expect(nonGit.files).toEqual({})

    Bun.spawnSync(['git', 'init'], { cwd: workDir })
    const gitRes = await fetch(
      `${BASE}/workspace/git-status?cwd=${encodeURIComponent(workDir)}`,
    )
    expect(gitRes.status).toBe(200)
    const gitBody = (await gitRes.json()) as any
    expect(gitBody.isGitRepo).toBe(true)
    expect(gitBody.files['src/hello.ts']).toBe('?')
  })
})
