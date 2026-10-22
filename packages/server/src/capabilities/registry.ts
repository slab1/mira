/**
 * Capability Registry
 * 
 * Tracks the implementation and verification status of every major capability.
 * This prevents documentation drift and provides a single source of truth.
 * 
 * Status levels (from docs/LONG_TERM_RISK_AND_SCALABILITY_PLAN.md):
 * - proposed: planned, not implemented
 * - implemented: code exists
 * - integrated: connected to real application path
 * - test-verified: relevant tests pass in recorded run
 * - production-verified: observed working under intended deployment conditions
 */

import type { MiraDB } from '../storage/db.js'

export type CapabilityStatus = 
  | 'proposed'
  | 'implemented'
  | 'integrated'
  | 'test-verified'
  | 'production-verified'

export interface CapabilityEntry {
  /** Unique capability identifier */
  id: string
  /** Human-readable name */
  name: string
  /** Current status */
  status: CapabilityStatus
  /** Category/tag */
  category: string
  /** Short description */
  description: string
  /** Implementation path (file:line or module) */
  implementation?: string
  /** Test file(s) that verify this capability */
  tests?: string | string[]
  /** Known limitations */
  limitations?: string[]
  /** Owner/team */
  owner: string
  /** Date status was last verified */
  lastVerified?: string
  /** Commit that introduced/changed this */
  commit?: string
  /** Related documentation */
  docs?: string[]
  /** Dependencies on other capabilities */
  dependsOn?: string[]
}

export interface CapabilityRegistry {
  [key: string]: CapabilityEntry
}

/** Default registry - can be extended via database */
export const DEFAULT_CAPABILITY_REGISTRY: CapabilityRegistry = {
  // =========================================================================
  // P0: Fail-Closed Governance
  // =========================================================================
  
  'governance.benchmark.fail-closed': {
    id: 'governance.benchmark.fail-closed',
    name: 'Benchmark fails closed on missing evidence',
    status: 'test-verified',
    category: 'P0',
    description: 'BenchmarkRunner returns BLOCKED when tracker or measurements are missing',
    implementation: 'packages/server/src/patching/governance/benchmark.ts',
    tests: 'packages/server/src/patching/governance/gate-fail-closed.test.ts',
    owner: '@slab1',
    lastVerified: '2026-10-20',
    commit: '20b1ca4',
    docs: ['docs/LONG_TERM_RISK_AND_SCALABILITY_PLAN.md', 'docs/MIRA_LONG_TERM_RISK_MITIGATION_AND_SCALABILITY.md'],
  },

  'governance.canary.fail-closed': {
    id: 'governance.canary.fail-closed',
    name: 'Canary fails closed on missing evidence',
    status: 'test-verified',
    category: 'P0',
    description: 'CanaryRunner returns BLOCKED when tracker, SLO, or sufficient samples are missing',
    implementation: 'packages/server/src/patching/governance/canary.ts',
    tests: 'packages/server/src/patching/governance/gate-fail-closed.test.ts',
    owner: '@slab1',
    lastVerified: '2026-10-20',
    commit: '20b1ca4',
    docs: ['docs/LONG_TERM_RISK_AND_SCALABILITY_PLAN.md'],
  },

  'governance.security.fail-closed': {
    id: 'governance.security.fail-closed',
    name: 'Security review fails closed on missing scanner',
    status: 'test-verified',
    category: 'P0',
    description: 'SecurityReview returns BLOCKED when scanner is unconfigured',
    implementation: 'packages/server/src/patching/governance/security-review.ts',
    tests: 'packages/server/src/patching/governance/gate-fail-closed.test.ts',
    owner: '@slab1',
    lastVerified: '2026-10-20',
    commit: '20b1ca4',
  },

  'governance.promotion.approval-required': {
    id: 'governance.promotion.approval-required',
    name: 'Promotion requires human approval',
    status: 'test-verified',
    category: 'P0',
    description: 'Promotion gate checks for approvalCheck before applying changes',
    implementation: 'packages/server/src/patching/governance/index.ts',
    tests: 'packages/server/src/patching/governance/promote-approval.test.ts',
    owner: '@slab1',
    lastVerified: '2026-10-20',
    commit: 'f183e2c',
    dependsOn: ['governance.benchmark.fail-closed', 'governance.canary.fail-closed'],
  },

  'governance.promotion.signed-receipts': {
    id: 'governance.promotion.signed-receipts',
    name: 'Approval receipts are signed to prevent forgery',
    status: 'test-verified',
    category: 'P0',
    description: 'Approval system uses signed receipts so DB writer cannot forge approvals',
    implementation: 'packages/server/src/evolution/approval.ts',
    tests: 'packages/server/src/patching/governance/approval-reachability.test.ts',
    owner: '@slab1',
    lastVerified: '2026-10-20',
    commit: '0d4b6a2',
  },

  'governance.regression.gate': {
    id: 'governance.regression.gate',
    name: 'Regression gate blocks promotion on metric degradation',
    status: 'test-verified',
    category: 'P0',
    description: 'Promotion checks regression detection before applying changes',
    implementation: 'packages/server/src/patching/governance/index.ts',
    tests: 'packages/server/src/patching/governance/regression-integrity.test.ts',
    owner: '@slab1',
    lastVerified: '2026-10-20',
    commit: '4ba82e5',
    dependsOn: ['governance.benchmark.fail-closed', 'governance.canary.fail-closed'],
  },

  // =========================================================================
  // P0: Isolation
  // =========================================================================
  
  'sandbox.isolation.docker': {
    id: 'sandbox.isolation.docker',
    name: 'Docker container isolation',
    status: 'integrated',
    category: 'P0',
    description: 'Sandbox supports Docker container isolation for untrusted code',
    implementation: 'packages/server/src/sandbox/isolation.ts',
    tests: 'packages/server/src/sandbox/isolation.test.ts',
    owner: '@slab1',
    lastVerified: '2026-10-20',
    commit: '229018c',
    limitations: ['Disabled by default', 'Requires Docker runtime'],
  },

  'sandbox.isolation.podman': {
    id: 'sandbox.isolation.podman',
    name: 'Podman container isolation',
    status: 'integrated',
    category: 'P0',
    description: 'Sandbox supports Podman container isolation for untrusted code',
    implementation: 'packages/server/src/sandbox/isolation.ts',
    tests: 'packages/server/src/sandbox/isolation.test.ts',
    owner: '@slab1',
    lastVerified: '2026-10-20',
    commit: '229018c',
    limitations: ['Disabled by default', 'Requires Podman runtime'],
  },

  'sandbox.isolation.fail-closed': {
    id: 'sandbox.isolation.fail-closed',
    name: 'Sandbox defaults to fail-closed for autonomous execution',
    status: 'integrated',
    category: 'P0',
    description: 'Autonomous execution requires isolation; fails closed if unavailable',
    implementation: 'packages/server/src/sandbox/isolation.ts',
    owner: '@slab1',
    lastVerified: '2026-10-20',
    commit: '229018c',
  },

  // =========================================================================
  // P0: Rollback
  // =========================================================================
  
  'rollback.file-restoration': {
    id: 'rollback.file-restoration',
    name: 'File restoration on rollback',
    status: 'integrated',
    category: 'P0',
    description: 'RollbackManager can restore files from rollback points',
    implementation: 'packages/server/src/evolution/rollback.ts',
    tests: 'packages/server/src/evolution/rollback.test.ts',
    owner: '@slab1',
    lastVerified: '2026-10-20',
    limitations: ['Does not handle dependency changes', 'Does not handle database migrations'],
  },

  'rollback.coordination': {
    id: 'rollback.coordination',
    name: 'Durable rollback coordination state',
    status: 'integrated',
    category: 'P0',
    description: 'Rollback state is persisted and coordinated across restarts',
    implementation: 'packages/server/src/evolution/rollback.ts',
    owner: '@slab1',
    lastVerified: '2026-10-20',
    commit: '97f78a9',
  },

  // =========================================================================
  // P1: Memory & Provenance
  // =========================================================================
  
  'memory.provenance.levels': {
    id: 'memory.provenance.levels',
    name: 'Provenance levels enum',
    status: 'partial',
    category: 'P1',
    description: 'ProvenanceLevel enum with 5 levels exists',
    implementation: 'packages/server/src/memory/provenance.ts',
    owner: '@slab1',
    lastVerified: '2026-10-20',
    limitations: ['Not all levels fully implemented', 'normalization module pending'],
    docs: ['docs/PROVENANCE_DESIGN.md'],
  },

  'memory.provenance.columns': {
    id: 'memory.provenance.columns',
    name: 'Provenance and confidence columns',
    status: 'partial',
    category: 'P1',
    description: 'provenance and confidence columns exist on knowledge_entries',
    implementation: 'learning/knowledge.ts',
    owner: '@slab1',
    lastVerified: '2026-10-20',
    limitations: ['Nullable columns', 'Defaults not applied', 'Backfill migration pending'],
    docs: ['docs/PROVENANCE_DESIGN.md'],
  },

  'memory.eviction': {
    id: 'memory.eviction',
    name: 'Memory eviction system',
    status: 'implemented',
    category: 'P1',
    description: 'Eviction system for managing memory growth',
    implementation: 'packages/server/src/memory/eviction.ts',
    owner: '@slab1',
    lastVerified: '2026-10-20',
    limitations: ['No automated tests at scale', 'No tenant isolation verification'],
  },

  // =========================================================================
  // P1: Orchestration
  // =========================================================================
  
  'orchestration.task-limits': {
    id: 'orchestration.task-limits',
    name: 'Task count and concurrency limits',
    status: 'integrated',
    category: 'P1',
    description: 'Orchestration bounds task count and parallelism',
    implementation: 'packages/server/src/tools/orchestrate.ts',
    owner: '@slab1',
    lastVerified: '2026-10-20',
    limitations: ['No aggregate budget across nested missions', 'No retry budget'],
  },

  'orchestration.aggregate-budget': {
    id: 'orchestration.aggregate-budget',
    name: 'Aggregate budget across task tree',
    status: 'proposed',
    category: 'P1',
    description: 'Shared token, monetary, wall-clock budgets across entire mission',
    owner: '@slab1',
    dependsOn: ['orchestration.task-limits'],
  },

  // =========================================================================
  // P1: Cost Accounting
  // =========================================================================
  
  'budget.in-memory': {
    id: 'budget.in-memory',
    name: 'In-memory spend counters',
    status: 'integrated',
    category: 'P1',
    description: 'In-memory spend tracking for evolution operations',
    implementation: 'packages/server/src/evolution/resources.ts',
    owner: '@slab1',
    lastVerified: '2026-10-20',
    limitations: ['Resets on process restart', 'Not authoritative for long-running'],
  },

  'budget.durable': {
    id: 'budget.durable',
    name: 'Durable budget accounting',
    status: 'proposed',
    category: 'P1',
    description: 'Atomic budget reservation and reconciliation in durable storage',
    implementation: 'packages/server/src/evolution/resources.ts',
    owner: '@slab1',
    dependsOn: ['budget.in-memory'],
  },

  // =========================================================================
  // P1: Tenant Isolation
  // =========================================================================
  
  'security.tenant-isolation': {
    id: 'security.tenant-isolation',
    name: 'Multi-tenant isolation invariants',
    status: 'implemented',
    category: 'P1',
    description: 'Tenant isolation enforced at data boundaries',
    implementation: 'packages/server/src/security/tenant.ts',
    owner: '@slab1',
    lastVerified: '2026-10-20',
    limitations: ['Cross-tenant access not explicitly tested'],
  },

  // =========================================================================
  // P1: Documentation
  // =========================================================================
  
  'docs.risk-plan': {
    id: 'docs.risk-plan',
    name: 'Long-term risk mitigation and scalability plan',
    status: 'production-verified',
    category: 'P1',
    description: 'Comprehensive remediation plan for autonomous self-improvement',
    implementation: 'docs/MIRA_LONG_TERM_RISK_MITIGATION_AND_SCALABILITY.md',
    owner: '@slab1',
    lastVerified: '2026-10-20',
    commit: '93f6650',
  },

  'docs.provenance-design': {
    id: 'docs.provenance-design',
    name: 'Provenance system design document',
    status: 'production-verified',
    category: 'P1',
    description: 'Design document for trust and provenance system',
    implementation: 'docs/PROVENANCE_DESIGN.md',
    owner: '@slab1',
    lastVerified: '2026-10-20',
    limitations: ['Documentation drift with implementation'],
  },

  'docs.evolution-spec': {
    id: 'docs.evolution-spec',
    name: 'Mira Evolution Specification',
    status: 'production-verified',
    category: 'P1',
    description: 'Specification for autonomous evolution pipeline',
    implementation: 'MIRA_EVOLUTION_SPEC.md',
    owner: '@slab1',
    lastVerified: '2026-10-20',
  },
}

/**
 * Database-backed capability registry for runtime updates
 */
export class CapabilityRegistryStore {
  private static instance: CapabilityRegistryStore | null = null
  
  constructor(private db: MiraDB) {}

  static async getInstance(db: MiraDB): Promise<CapabilityRegistryStore> {
    if (!CapabilityRegistryStore.instance) {
      CapabilityRegistryStore.instance = new CapabilityRegistryStore(db)
      await CapabilityRegistryStore.instance.init()
    }
    return CapabilityRegistryStore.instance
  }

  async init(): Promise<void> {
    // Create capabilities table if not exists
    await this.db.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS capabilities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        category TEXT NOT NULL,
        description TEXT NOT NULL,
        implementation TEXT,
        tests TEXT,
        limitations TEXT,
        owner TEXT NOT NULL,
        last_verified TEXT,
        commit TEXT,
        docs TEXT,
        depends_on TEXT
      )
    `)
    
    // Seed with default registry
    for (const [id, cap] of Object.entries(DEFAULT_CAPABILITY_REGISTRY)) {
      const existing = await this.get(id)
      if (!existing) {
        await this.set(id, cap)
      }
    }
  }

  async get(id: string): Promise<CapabilityEntry | null> {
    const result = await this.db.sqlite.exec({
      sql: 'SELECT * FROM capabilities WHERE id = ?',
      args: [id],
    })
    
    if (result.rows.length === 0) return null
    
    const row = result.rows[0]
    return {
      id: row.id as string,
      name: row.name as string,
      status: row.status as CapabilityStatus,
      category: row.category as string,
      description: row.description as string,
      implementation: row.implementation as string | undefined,
      tests: row.tests ? (row.tests as string).split(',') : undefined,
      limitations: row.limitations ? JSON.parse(row.limitations as string) : undefined,
      owner: row.owner as string,
      lastVerified: row.last_verified as string | undefined,
      commit: row.commit as string | undefined,
      docs: row.docs ? (row.docs as string).split(',') : undefined,
      dependsOn: row.depends_on ? (row.depends_on as string).split(',') : undefined,
    }
  }

  async set(id: string, entry: CapabilityEntry): Promise<void> {
    await this.db.sqlite.exec({
      sql: `INSERT OR REPLACE INTO capabilities (id, name, status, category, description, implementation, tests, limitations, owner, last_verified, commit, docs, depends_on) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        entry.name,
        entry.status,
        entry.category,
        entry.description,
        entry.implementation ?? null,
        Array.isArray(entry.tests) ? entry.tests.join(',') : entry.tests ?? null,
        entry.limitations ? JSON.stringify(entry.limitations) : null,
        entry.owner,
        entry.lastVerified ?? null,
        entry.commit ?? null,
        Array.isArray(entry.docs) ? entry.docs.join(',') : null,
        entry.dependsOn ? entry.dependsOn.join(',') : null,
      ],
    })
  }

  async list(category?: string): Promise<CapabilityEntry[]> {
    const result = await this.db.sqlite.exec({
      sql: category 
        ? 'SELECT * FROM capabilities WHERE category = ?'
        : 'SELECT * FROM capabilities',
      args: category ? [category] : [],
    })
    
    return result.rows.map((row) => ({
      id: row.id as string,
      name: row.name as string,
      status: row.status as CapabilityStatus,
      category: row.category as string,
      description: row.description as string,
      implementation: row.implementation as string | undefined,
      tests: row.tests ? (row.tests as string).split(',') : undefined,
      limitations: row.limitations ? JSON.parse(row.limitations as string) : undefined,
      owner: row.owner as string,
      lastVerified: row.last_verified as string | undefined,
      commit: row.commit as string | undefined,
      docs: row.docs ? (row.docs as string).split(',') : undefined,
      dependsOn: row.depends_on ? (row.depends_on as string).split(',') : undefined,
    }))
  }

  async getStatusReport(): Promise<Record<CapabilityStatus, number>> {
    const all = await this.list()
    const report: Record<CapabilityStatus, number> = {
      'proposed': 0,
      'implemented': 0,
      'integrated': 0,
      'test-verified': 0,
      'production-verified': 0,
    }
    
    for (const cap of all) {
      report[cap.status]++
    }
    
    return report
  }

  async verifyDependencies(): Promise<string[]> {
    // Find capabilities that depend on non-existent or proposed capabilities
    const all = await this.list()
    const errors: string[] = []
    
    for (const cap of all) {
      if (cap.dependsOn) {
        for (const depId of cap.dependsOn) {
          const dep = await this.get(depId)
          if (!dep) {
            errors.push(`${cap.id} depends on non-existent capability: ${depId}`)
          } else if (dep.status === 'proposed') {
            errors.push(`${cap.id} depends on proposed capability: ${depId} (status: ${dep.status})`)
          }
        }
      }
    }
    
    return errors
  }
}

/**
 * Get capability status summary for logging/dashboards
 */
export function getCapabilitySummary(registry: CapabilityRegistry = DEFAULT_CAPABILITY_REGISTRY): {
  total: number
  byStatus: Record<CapabilityStatus, number>
  byCategory: Record<string, number>
  p0Complete: boolean
  p1Complete: boolean
} {
  const byStatus: Record<CapabilityStatus, number> = {
    'proposed': 0,
    'implemented': 0,
    'integrated': 0,
    'test-verified': 0,
    'production-verified': 0,
  }
  
  const byCategory: Record<string, number> = {}
  
  for (const cap of Object.values(registry)) {
    byStatus[cap.status]++
    byCategory[cap.category] = (byCategory[cap.category] || 0) + 1
  }
  
  // P0 complete means no P0 capabilities are 'proposed' or 'implemented'
  const p0Caps = Object.values(registry).filter(c => c.category === 'P0')
  const p0Complete = p0Caps.every(c => c.status === 'test-verified' || c.status === 'production-verified')
  
  // P1 complete means no P1 capabilities are 'proposed'
  const p1Caps = Object.values(registry).filter(c => c.category === 'P1')
  const p1Complete = p1Caps.every(c => c.status !== 'proposed')
  
  return {
    total: Object.keys(registry).length,
    byStatus,
    byCategory,
    p0Complete,
    p1Complete,
  }
}

/**
 * Export registry for use in other modules
 */
export const capabilityRegistry = DEFAULT_CAPABILITY_REGISTRY
