/**
 * Governance — candidate variant workspace.
 *
 * The measurement pipeline in this package only becomes meaningful once a
 * candidate can actually be RUN. Until now `trafficPct` had no variant to send
 * traffic to, so the canary could only ever observe zero candidate requests and
 * the benchmark had no independent candidate snapshot to compare.
 *
 * This module closes that gap the honest way: materialize a disposable copy of
 * the source tree, apply the patch into THAT copy, and register it with the
 * VariantRouter. Nothing is measured against production-on-purpose:
 *
 *   - the repository working tree is never modified;
 *   - the copy is disposable and removed on dispose();
 *   - a patch that will not apply produces NO variant, so the router keeps
 *     traffic on baseline and the gates block — rather than a candidate that
 *     silently differs from what would ship.
 *
 * Deliberately not faked: if the tree cannot be materialized the variant is
 * absent. That is the whole point — `shadow/benchmark.ts` "parity benchmark"
 * (candidate = {...production}) would make the benchmark compare production
 * against itself and pass by construction.
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Applier } from '../applier.js'
import type { Patch } from '../patcher.js'
import type { VerifyResult } from '../verifier.js'

export interface VariantCandidate {
  proposalId: string
  /** Absolute path to the materialized, patched tree. */
  dir: string
  /** How the tree was produced — recorded so an audit can tell. */
  origin: 'git-worktree' | 'copy'
  createdAt: number
}

export interface MaterializeResult {
  candidate: VariantCandidate | null
  reason: string
}

export interface VariantWorkspaceOptions {
  /** Root of the real repository — never written to. */
  rootDir?: string
  /** Where disposable copies are created. Defaults to the OS temp dir. */
  scratchRoot?: string
  /** Skip node_modules/.git when copying. Default true. */
  skipHeavy?: boolean
}

const IGNORED = ['node_modules', '.git', 'dist', '.turbo', 'coverage', '.mira', 'data']

export class VariantWorkspace {
  private readonly rootDir: string
  private readonly scratchRoot: string
  private readonly skipHeavy: boolean
  private live = new Map<string, VariantCandidate>()

  constructor(opts: VariantWorkspaceOptions = {}) {
    this.rootDir = opts.rootDir ?? process.cwd()
    this.scratchRoot = opts.scratchRoot ?? tmpdir()
    this.skipHeavy = opts.skipHeavy ?? true
  }

  /** Candidates currently materialized. */
  list(): VariantCandidate[] {
    return [...this.live.values()]
  }

  get(proposalId: string): VariantCandidate | undefined {
    return this.live.get(proposalId)
  }

  /**
   * Create a disposable, patched copy of the tree.
   *
   * Returns `candidate: null` when anything goes wrong. Callers must treat that
   * as "no variant exists" and keep traffic on baseline.
   */
  async materialize(
    proposalId: string,
    patch: Patch,
    verifyResult?: VerifyResult,
  ): Promise<MaterializeResult> {
    if (!existsSync(this.rootDir)) {
      return { candidate: null, reason: `rootDir does not exist: ${this.rootDir}` }
    }

    const dir = mkdtempSync(join(this.scratchRoot, `mira-variant-${sanitize(proposalId)}-`))
    try {
      const origin = this.copyTree(dir)

      // Apply into the COPY. No db is passed, so the pre-image is not snapshotted
      // into the evolution marker session — the worktree is disposable and there
      // is nothing to roll back to.
      const applier = new Applier({}, { rootDir: dir })
      const applied = await applier.apply(patch, verifyResult)
      if (!applied.applied) {
        rmSync(dir, { recursive: true, force: true })
        return {
          candidate: null,
          reason: `patch did not apply in the candidate tree: ${applied.reason}`,
        }
      }

      const candidate: VariantCandidate = { proposalId, dir, origin, createdAt: Date.now() }
      this.live.set(proposalId, candidate)
      return { candidate, reason: `materialized ${origin} with ${patch.id}` }
    } catch (e) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {}
      return { candidate: null, reason: `materialization failed: ${String(e)}` }
    }
  }

  /** Remove a candidate's tree. Safe to call more than once. */
  dispose(proposalId: string): boolean {
    const c = this.live.get(proposalId)
    if (!c) return false
    try {
      rmSync(c.dir, { recursive: true, force: true })
    } catch {
      return false
    }
    this.live.delete(proposalId)
    return true
  }

  disposeAll(): void {
    for (const id of [...this.live.keys()]) this.dispose(id)
  }

  /** git worktree when available (cheap, shares the object store), else copy. */
  private copyTree(dest: string): 'git-worktree' | 'copy' {
    const git = spawnSync('git', ['-C', this.rootDir, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf-8',
    })
    if (git.status === 0 && git.stdout.trim() === 'true') {
      const wt = spawnSync(
        'git',
        ['-C', this.rootDir, 'worktree', 'add', '--detach', '--no-checkout', dest],
        { encoding: 'utf-8' },
      )
      if (wt.status === 0) {
        // --no-checkout leaves the tree empty; populate it from HEAD.
        const co = spawnSync('git', ['-C', dest, 'checkout', '--detach', 'HEAD'], {
          encoding: 'utf-8',
        })
        if (co.status === 0) return 'git-worktree'
        spawnSync('git', ['-C', this.rootDir, 'worktree', 'remove', '--force', dest], {
          encoding: 'utf-8',
        })
        rmSync(dest, { recursive: true, force: true })
      }
    }

    cpSync(this.rootDir, dest, {
      recursive: true,
      ...(this.skipHeavy
        ? { filter: (src: string) => !IGNORED.some((i) => src.endsWith(`/${i}`)) }
        : {}),
    })
    return 'copy'
  }
}

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)
}
