/**
 * Evolution System Rollback — §6 system-level rollback metadata
 *
 * Docs: MIRA_WEAKNESSES_AND_OBSTACLES.md §6 (Canary Promotion and System-Level
 * Rollback, P0): file snapshots ≠ system rollback. Self-evolution can change
 * dependencies, models, prompts, configuration, engines — every candidate needs:
 *   Candidate Version / Parent Version / Changed Components / Dependencies /
 *   Configuration / Migration State / Benchmark Results / Rollback Metadata.
 *
 * Design: capture system-state snapshots (component versions from collectors,
 * dependency versions, config-file content hashes) BEFORE a candidate is
 * applied, diff AFTER, and persist rollback metadata per proposal. Restoring
 * component state executes via the existing per-engine rollback() (EngineRegistry)
 * and file snapshots (RollbackManager) — this module supplies the METADATA and
 * the diff that make system rollback actionable instead of best-effort.
 *
 * Documentation Maintenance — 10 items:
 * | # | Item | Status | Evidence |
 * |---|------|--------|----------|
 * | 1 | Implementation path | Implemented | packages/server/src/evolution/system-rollback.ts |
 * | 2 | Public interfaces | Implemented | SystemRollbackManager.capture(); recordCandidate(id, before, after?); metadata(id); list(); diffSnapshots() |
 * | 3 | Events | Implemented | caller emits evolution.system_rollback via Bus (module is pure) |
 * | 4 | Configuration | Implemented | collectors injected (engines/deps/config paths); MIRA_SYSTEM_ROLLBACK_MAX (default 200) |
 * | 5 | Tests | Implemented | packages/server/src/evolution/system-rollback.test.ts (capture/diff/metadata/caps) |
 * | 6 | Security boundaries | Implemented | config files hashed (sha256) — content never stored, so no secret leakage; collectors fail-soft to {} |
 * | 7 | Operational procedures | Implemented | capture() at rollback-point time in observe; metadata exposed via GET /evolution/rollback/:id/metadata |
 * | 8 | Migration strategy | Implemented | additive, in-memory; complements (does not replace) RollbackManager file snapshots |
 * | 9 | Rollback strategy | Implemented | this module IS the §6 rollback strategy: diff + metadata drive engine rollback()/snapshot restore |
 * | 10 | Known limitations | Implemented | in-memory metadata (restarts reset); migration-state capture is Target; DB-schema components not yet tracked |
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'

export interface ComponentState {
  version: string
  hash?: string
}

export interface SystemStateSnapshot {
  /** Component name → version (+ optional content hash). */
  components: Record<string, ComponentState>
  dependencies: Record<string, string>
  /** Config file path → sha256 of content (content itself never stored). */
  configHashes: Record<string, string>
  /** Free-form migration marker for components that expose one. */
  migrationState?: Record<string, string>
  timestamp: number
}

export interface SystemRollbackMetadata {
  proposalId: string
  /** §6: Candidate Version — the post-state component versions (when captured). */
  candidateVersion: Record<string, string> | null
  /** §6: Parent Version — the pre-state component versions. */
  parentVersion: Record<string, string>
  /** §6: Changed Components — diff between before/after. */
  changedComponents: string[]
  /** §6: Dependencies — added/removed/changed dependency names. */
  changedDependencies: string[]
  /** §6: Configuration — config files whose hash changed. */
  changedConfig: string[]
  /** §6: Migration State snapshot reference. */
  migrationState?: Record<string, string>
  /** §6: Rollback Metadata — how to restore. */
  rollback: {
    strategy: 'engine-rollback' | 'config-restore' | 'manual'
    steps: string[]
    capturedAt: number
  }
}

export interface SystemRollbackCollectors {
  /** Live component versions (e.g. from EngineRegistry.list()). */
  componentVersions?: () => Record<string, string>
  /** Live dependency versions (e.g. from package.json). */
  dependencyVersions?: () => Record<string, string>
  /** Config files whose content is hash-tracked (paths). */
  configPaths?: string[]
}

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

/** Diff two snapshots — changed components/deps/config names. */
export function diffSnapshots(
  before: SystemStateSnapshot,
  after: SystemStateSnapshot | null,
): { changedComponents: string[]; changedDependencies: string[]; changedConfig: string[] } {
  if (!after) return { changedComponents: [], changedDependencies: [], changedConfig: [] }
  const changedComponents = Object.keys(after.components).filter(
    (k) => before.components[k]?.version !== after.components[k]?.version,
  )
  const deps = new Set([...Object.keys(before.dependencies), ...Object.keys(after.dependencies)])
  const changedDependencies = [...deps].filter(
    (k) => before.dependencies[k] !== after.dependencies[k],
  )
  const configs = new Set([...Object.keys(before.configHashes), ...Object.keys(after.configHashes)])
  const changedConfig = [...configs].filter((k) => before.configHashes[k] !== after.configHashes[k])
  return { changedComponents, changedDependencies, changedConfig }
}

export class SystemRollbackManager {
  private collectors: SystemRollbackCollectors
  private candidates = new Map<
    string,
    {
      before: SystemStateSnapshot
      after: SystemStateSnapshot | null
      metadata: SystemRollbackMetadata
    }
  >()
  private readonly maxEntries: number

  constructor(collectors: SystemRollbackCollectors = {}, opts: { maxEntries?: number } = {}) {
    this.collectors = collectors
    this.maxEntries = opts.maxEntries ?? envInt('MIRA_SYSTEM_ROLLBACK_MAX', 200)
  }

  /** Capture the CURRENT system state (call before a candidate is applied). */
  capture(now = Date.now()): SystemStateSnapshot {
    const components: Record<string, ComponentState> = {}
    try {
      for (const [name, version] of Object.entries(this.collectors.componentVersions?.() ?? {})) {
        components[name] = { version: String(version).slice(0, 100) }
      }
    } catch {}
    let dependencies: Record<string, string> = {}
    try {
      dependencies = this.collectors.dependencyVersions?.() ?? {}
    } catch {}
    const configHashes: Record<string, string> = {}
    for (const p of this.collectors.configPaths ?? []) {
      try {
        if (p && existsSync(p)) configHashes[p] = sha256(readFileSync(p, 'utf-8'))
      } catch {}
    }
    return { components, dependencies, configHashes, timestamp: now }
  }

  /** Record a candidate's §6 rollback metadata from before/after snapshots. */
  recordCandidate(
    proposalId: string,
    before: SystemStateSnapshot,
    after?: SystemStateSnapshot | null,
    now = Date.now(),
  ): SystemRollbackMetadata {
    const d = diffSnapshots(before, after ?? null)
    const steps: string[] = []
    if (d.changedComponents.length > 0) {
      steps.push(
        `rollback affected engines via EngineRegistry.rollback(): ${d.changedComponents.join(', ')}`,
      )
    }
    if (d.changedConfig.length > 0) {
      steps.push(`restore config files from snapshots: ${d.changedConfig.join(', ')}`)
    }
    if (d.changedDependencies.length > 0) {
      steps.push(`revert dependency changes: ${d.changedDependencies.join(', ')}`)
    }
    if (steps.length === 0) steps.push('no system-level changes recorded — file snapshots suffice')

    const metadata: SystemRollbackMetadata = {
      proposalId,
      candidateVersion: after
        ? Object.fromEntries(Object.entries(after.components).map(([k, v]) => [k, v.version]))
        : null,
      parentVersion: Object.fromEntries(
        Object.entries(before.components).map(([k, v]) => [k, v.version]),
      ),
      changedComponents: d.changedComponents,
      changedDependencies: d.changedDependencies,
      changedConfig: d.changedConfig,
      migrationState: after?.migrationState ?? before.migrationState,
      rollback: {
        strategy:
          d.changedComponents.length > 0
            ? 'engine-rollback'
            : d.changedConfig.length > 0
              ? 'config-restore'
              : 'manual',
        steps,
        capturedAt: now,
      },
    }
    this.candidates.set(proposalId, { before, after: after ?? null, metadata })
    if (this.candidates.size > this.maxEntries) {
      const oldest = [...this.candidates.keys()][0]
      if (oldest) this.candidates.delete(oldest)
    }
    return metadata
  }

  metadata(proposalId: string): SystemRollbackMetadata | undefined {
    return this.candidates.get(proposalId)?.metadata
  }

  list(): SystemRollbackMetadata[] {
    return [...this.candidates.values()].map((c) => c.metadata)
  }

  count(): number {
    return this.candidates.size
  }
}
