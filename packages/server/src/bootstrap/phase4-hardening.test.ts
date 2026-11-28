import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createDatabase, migrate } from '../storage/db.js'
import { DEFAULT_CONFIG } from '../config/defaults.js'
import { initializeServices } from './services.js'
import { createApp } from './server.js'
import {
  generateReviewCoverageManifest,
  updateReviewManifest,
} from '../review/coverage.js'
import { reviewCoverageTool } from '../tools/review-coverage.js'

describe('Phase 4 Hardening: Auth/Route Alignment & Review Completeness', () => {
  const dirs: string[] = []
  const prevEnv = {
    NODE_ENV: process.env.NODE_ENV,
    MIRA_TOKEN: process.env.MIRA_TOKEN,
    VITE_MIRA_TOKEN: process.env.VITE_MIRA_TOKEN,
    MIRA_STRICT_AUTH: process.env.MIRA_STRICT_AUTH,
  }

  afterEach(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    while (dirs.length) {
      const d = dirs.pop()!
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {}
    }
  })

  test('createApp refuses unauthenticated production startup and rejects dev tokens in production', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mira-p4-auth-'))
    dirs.push(dir)
    const db = createDatabase(join(dir, 'test.db'))
    await migrate(db)
    const config = structuredClone(DEFAULT_CONFIG)
    const services = await initializeServices(config, db)

    process.env.NODE_ENV = 'production'
    delete process.env.MIRA_TOKEN
    delete process.env.MIRA_STRICT_AUTH
    process.env.VITE_MIRA_TOKEN = 'dev-vite-secret'

    expect(() =>
      createApp({
        config,
        db,
        services,
        apiKeys: new Map(),
        orgs: new Map(),
        memberships: [],
      }),
    ).toThrow(/required in production/)

    const app = createApp({
      config,
      db,
      services,
      apiKeys: new Map(),
      orgs: new Map(),
      memberships: [],
      requiredToken: 'prod-real-secret',
    })

    const devRes = await app.fetch(
      new Request('http://localhost/engines', {
        headers: { Authorization: 'Bearer dev-local-token-not-secret' },
      }),
    )
    expect(devRes.status).toBe(401)

    const viteRes = await app.fetch(
      new Request('http://localhost/engines', {
        headers: { Authorization: 'Bearer dev-vite-secret' },
      }),
    )
    expect(viteRes.status).toBe(401)

    const prodRes = await app.fetch(
      new Request('http://localhost/engines', {
        headers: { Authorization: 'Bearer prod-real-secret' },
      }),
    )
    expect(prodRes.status).toBe(200)

    const coordRes = await app.fetch(
      new Request('http://localhost/coordination/health', {
        headers: { Authorization: 'Bearer prod-real-secret' },
      }),
    )
    expect(coordRes.status).toBe(200)
  })

  test('review completeness blocks empty dispositions and unverified fixed findings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mira-p4-review-'))
    dirs.push(dir)
    spawnSync('git', ['init'], { cwd: dir })
    spawnSync('git', ['config', 'user.email', 'test@mira.dev'], { cwd: dir })
    spawnSync('git', ['config', 'user.name', 'Mira Test'], { cwd: dir })
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'app.ts'), 'export const a = 1;\n')
    spawnSync('git', ['add', '.'], { cwd: dir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: dir })
    writeFileSync(join(dir, 'src', 'app.ts'), 'export const a = 2;\n')

    const dbDir = mkdtempSync(join(tmpdir(), 'mira-p4-review-db-'))
    dirs.push(dbDir)
    const db = createDatabase(join(dbDir, 'review.db'))
    await migrate(db)
    const config = structuredClone(DEFAULT_CONFIG)
    const services = await initializeServices(config, db)
    const sess = await services.prompt.createSession({ title: 'Review Completeness', cwd: dir })

    const app = createApp({
      config,
      db,
      services,
      apiKeys: new Map(),
      orgs: new Map(),
      memberships: [],
      requiredToken: 'rev-secret',
    })

    const manifest = await generateReviewCoverageManifest({ db, sessionID: sess.id, cwd: dir })
    const item = manifest.items[0]!

    // Route rejects empty inspected / not_applicable / unverified fixed findings with 400
    const badPatch = await app.fetch(
      new Request(`http://localhost/review/coverage/${manifest.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer rev-secret',
        },
        body: JSON.stringify({
          item: { id: item.id, disposition: 'not_applicable' },
        }),
      }),
    )
    expect(badPatch.status).toBe(400)

    const badFinding = await app.fetch(
      new Request(`http://localhost/review/coverage/${manifest.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer rev-secret',
        },
        body: JSON.stringify({
          finding: {
            id: 'rf_1',
            title: 'Missing guard',
            severity: 'high',
            disposition: 'fixed',
            changedFiles: ['src/app.ts'],
            testRefs: [],
          },
        }),
      }),
    )
    expect(badFinding.status).toBe(400)

    // Direct store update without evidence also stays blocked (cannot mark complete)
    const unverifiedSection = await updateReviewManifest(db, manifest.id, {
      section: { id: 'changed_files', disposition: 'inspected', evidenceRefs: [] },
    })
    expect(unverifiedSection?.state).not.toBe('complete')
    expect(unverifiedSection?.blockers.some((b) => b.includes('changed_files'))).toBe(true)

    // Supplying real evidence for all pending sections, items, and fixed finding completes cleanly
    for (const sec of manifest.sections) {
      if (sec.disposition === 'pending') {
        await updateReviewManifest(db, manifest.id, {
          section: { id: sec.id, disposition: 'inspected', evidenceRefs: ['git diff src/app.ts'] },
        })
      }
    }
    for (const it of manifest.items) {
      await updateReviewManifest(db, manifest.id, {
        item: { id: it.id, disposition: 'tested', testCommand: 'bun test' },
      })
    }
    const completed = await reviewCoverageTool.execute(
      {
        action: 'record_finding',
        manifestId: manifest.id,
        finding: {
          id: 'rf_1',
          title: 'Missing guard',
          severity: 'high',
          disposition: 'fixed',
          changedFiles: ['src/app.ts'],
          testRefs: ['src/app.test.ts'],
          testCommand: 'bun test src/app.test.ts',
          testOutcome: 'passed',
        },
      },
      { db, sessionID: sess.id, cwd: dir, messageID: 'm1', signal: new AbortController().signal },
    )
    expect((completed as { state: string; blockers: string[] }).state).toBe('complete')
    expect((completed as { blockers: string[] }).blockers).toEqual([])
  })
})
