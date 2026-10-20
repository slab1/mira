/**
 * Durable Budget Store - SQLite-backed atomic budget accounting
 * 
 * Addresses P1: "Cost counters reset after restart" from the risk mitigation plan.
 * Provides atomic budget reservation, settlement, and reconciliation.
 * 
 * This is the AUTHORITATIVE budget store for long-running autonomous platforms.
 * When used, in-memory counters in resources.ts become a best-effort cache.
 */

import type { MiraDB } from '../storage/db.js'
import type { BudgetCaps } from './resources.js'

export interface BudgetScope {
  tenant: string
  agent: string
  mission: string
  day: string
}

export interface BudgetReservation {
  id: string
  scope: BudgetScope
  reservedUSD: number
  actualUSD: number | null
  state: 'reserved' | 'settled' | 'released' | 'expired'
  reason?: string
  createdAt: number
  settledAt?: number
  expiresAt: number
}

export interface BudgetSpend {
  tenant: number
  agent: number
  mission: number
  daily: number
}

export interface ReservationOptions {
  idempotencyKey?: string
  ttlMs?: number
}

export interface BudgetStoreConfig {
  /** Fail closed when DB is unavailable */
  failClosed: boolean
  /** Default TTL for reservations (ms) */
  defaultTtlMs: number
  /** Maximum reservation TTL (ms) */
  maxTtlMs: number
}

const DEFAULT_CONFIG: BudgetStoreConfig = {
  failClosed: true,
  defaultTtlMs: 30 * 60 * 1000, // 30 minutes
  maxTtlMs: 24 * 60 * 60 * 1000, // 24 hours
}

const SCHEMA = `
  -- Budget reservations (atomic accounting)
  CREATE TABLE IF NOT EXISTS budget_reservations (
    id TEXT PRIMARY KEY,
    tenant TEXT NOT NULL,
    agent TEXT NOT NULL,
    mission TEXT NOT NULL,
    day TEXT NOT NULL,
    reserved_usd REAL NOT NULL,
    actual_usd REAL,
    state TEXT NOT NULL CHECK(state IN ('reserved', 'settled', 'released', 'expired')),
    reason TEXT,
    idempotency_key TEXT,
    created_at INTEGER NOT NULL,
    settled_at INTEGER,
    expires_at INTEGER NOT NULL
  );
  
  CREATE INDEX IF NOT EXISTS idx_budget_reservations_tenant ON budget_reservations(tenant);
  CREATE INDEX IF NOT EXISTS idx_budget_reservations_agent ON budget_reservations(agent);
  CREATE INDEX IF NOT EXISTS idx_budget_reservations_mission ON budget_reservations(mission);
  CREATE INDEX IF NOT EXISTS idx_budget_reservations_day ON budget_reservations(day);
  CREATE INDEX IF NOT EXISTS idx_budget_reservations_state ON budget_reservations(state);
  CREATE INDEX IF NOT EXISTS idx_budget_reservations_idempotency ON budget_reservations(idempotency_key);
  CREATE INDEX IF NOT EXISTS idx_budget_reservations_expires ON budget_reservations(expires_at);
  
  -- Budget caps configuration
  CREATE TABLE IF NOT EXISTS budget_caps (
    tenant TEXT PRIMARY KEY,
    per_task REAL NOT NULL DEFAULT 0.5,
    per_agent REAL NOT NULL DEFAULT 10,
    per_mission REAL NOT NULL DEFAULT 20,
    daily REAL NOT NULL DEFAULT 50,
    updated_at INTEGER NOT NULL
  );
  
  -- Budget spend tracking (materialized view for quick queries)
  CREATE TABLE IF NOT EXISTS budget_spend (
    tenant TEXT NOT NULL,
    agent TEXT NOT NULL,
    mission TEXT NOT NULL,
    day TEXT NOT NULL,
    total_usd REAL NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (tenant, agent, mission, day)
  );
`

export class DurableBudgetStore {
  private db: MiraDB
  private config: BudgetStoreConfig
  private initialized = false

  constructor(db: MiraDB, config: Partial<BudgetStoreConfig> = {}) {
    this.db = db
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  async init(): Promise<void> {
    if (this.initialized) return
    
    // Create schema
    this.db.sqlite.exec(SCHEMA)
    
    // Add missing columns for backward compatibility
    try {
      this.db.sqlite.exec(`ALTER TABLE budget_reservations ADD COLUMN tenant TEXT NOT NULL DEFAULT 'default'`)
    } catch {}
    
    try {
      this.db.sqlite.exec(`ALTER TABLE budget_reservations ADD COLUMN idempotency_key TEXT`)
    } catch {}
    
    // Create default caps if not exists
    await this.ensureDefaultCaps()
    
    this.initialized = true
  }

  private async ensureDefaultCaps(): Promise<void> {
    const result = await this.db.sqlite.exec({
      sql: 'SELECT COUNT(*) as count FROM budget_caps WHERE tenant = ?',
      args: ['default'],
    })
    
    if (Number(result.rows[0]?.count) === 0) {
      await this.db.sqlite.exec({
        sql: `INSERT INTO budget_caps (tenant, per_task, per_agent, per_mission, daily, updated_at) 
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: ['default', 0.5, 10, 20, 50, Date.now()],
      })
    }
  }

  /**
   * Get budget caps for a tenant
   */
  async getCaps(tenant: string = 'default'): Promise<BudgetCaps> {
    const result = await this.db.sqlite.exec({
      sql: 'SELECT per_task, per_agent, per_mission, daily FROM budget_caps WHERE tenant = ?',
      args: [tenant],
    })
    
    if (result.rows.length > 0) {
      const row = result.rows[0]
      return {
        perTask: Number(row.per_task),
        perAgent: Number(row.per_agent),
        perMission: Number(row.per_mission),
        daily: Number(row.daily),
      }
    }
    
    // Return defaults
    return {
      perTask: 0.5,
      perAgent: 10,
      perMission: 20,
      daily: 50,
    }
  }

  /**
   * Set budget caps for a tenant
   */
  async setCaps(tenant: string, caps: BudgetCaps): Promise<void> {
    await this.db.sqlite.exec({
      sql: `INSERT OR REPLACE INTO budget_caps (tenant, per_task, per_agent, per_mission, daily, updated_at) 
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [tenant, caps.perTask, caps.perAgent, caps.perMission, caps.daily, Date.now()],
    })
  }

  /**
   * Reserve budget atomically
   * Returns reservation ID if successful, null if denied
   */
  async reserve(
    tenant: string,
    agent: string,
    mission: string,
    cost: number,
    caps?: BudgetCaps,
    options?: ReservationOptions
  ): Promise<{ allowed: boolean; reservationId: string | null; reason?: string }> {
    const effectiveCaps = caps ?? await this.getCaps(tenant)
    const day = new Date().toISOString().slice(0, 10)
    const ttlMs = options?.ttlMs ?? this.config.defaultTtlMs
    const expiresAt = Date.now() + Math.min(ttlMs, this.config.maxTtlMs)
    const idempotencyKey = options?.idempotencyKey ?? this.generateId()
    
    // Check if idempotent reservation already exists
    const existing = await this.getReservationByIdempotencyKey(idempotencyKey)
    if (existing) {
      return { allowed: true, reservationId: existing.id }
    }
    
    const reservationId = this.generateId()
    
    // Use a transaction for atomic check-and-reserve
    try {
      const result = await this.db.sqlite.exec({
        sql: `
          BEGIN;
          
          -- Check per-task cap
          SELECT COUNT(*) as over_task FROM budget_reservations 
          WHERE agent = ? AND day = ? AND state IN ('reserved', 'settled')
          GROUP BY agent HAVING SUM(reserved_usd) + ? > ?;
          
          -- Check per-agent cap  
          SELECT COUNT(*) as over_agent FROM budget_reservations
          WHERE agent = ? AND day = ? AND state IN ('reserved', 'settled')
          GROUP BY agent HAVING SUM(reserved_usd) + ? > ?;
          
          -- Check per-mission cap
          SELECT COUNT(*) as over_mission FROM budget_reservations
          WHERE mission = ? AND day = ? AND state IN ('reserved', 'settled')
          GROUP BY mission HAVING SUM(reserved_usd) + ? > ?;
          
          -- Check daily cap
          SELECT COUNT(*) as over_daily FROM budget_reservations
          WHERE tenant = ? AND day = ? AND state IN ('reserved', 'settled')
          GROUP BY tenant, day HAVING SUM(reserved_usd) + ? > ?;
          
          -- If all checks pass, create reservation
          INSERT INTO budget_reservations 
            (id, tenant, agent, mission, day, reserved_usd, actual_usd, state, idempotency_key, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, NULL, 'reserved', ?, ?, ?, ?)
          WHERE NOT EXISTS (
            SELECT 1 FROM budget_reservations 
            WHERE idempotency_key = ?
          );
          
          COMMIT;
        `,
        args: [
          agent, day, cost, effectiveCaps.perTask,
          agent, day, cost, effectiveCaps.perAgent,
          mission, day, cost, effectiveCaps.perMission,
          tenant, day, cost, effectiveCaps.daily,
          reservationId, tenant, agent, mission, day, cost, idempotencyKey, Date.now(), expiresAt,
          idempotencyKey,
        ],
      })
      
      // Check if reservation was created
      const created = await this.getReservation(reservationId)
      if (created) {
        return { allowed: true, reservationId: created.id }
      }
      
      // Reservation failed - check which cap was exceeded
      const checks = [
        { scope: 'per-task', over: await this.isOverLimit('agent', agent, day, cost, effectiveCaps.perTask) },
        { scope: 'per-agent', over: await this.isOverLimit('agent', agent, day, cost, effectiveCaps.perAgent) },
        { scope: 'per-mission', over: await this.isOverLimit('mission', mission, day, cost, effectiveCaps.perMission) },
        { scope: 'daily', over: await this.isOverLimit('tenant', tenant, day, cost, effectiveCaps.daily) },
      ]
      
      const denied = checks.find(c => c.over)
      return { 
        allowed: false, 
        reservationId: null, 
        reason: denied ? `${denied.scope} budget exceeded` : 'budget denied'
      }
      
    } catch (e) {
      if (this.config.failClosed) {
        return { allowed: false, reservationId: null, reason: `budget service unavailable: ${String(e)}` }
      }
      // Fallback: allow but log
      console.error('[budget] reservation failed, allowing due to failClosed=false:', e)
      return { allowed: true, reservationId: null }
    }
  }

  /**
   * Settle a reservation with actual cost
   */
  async settle(reservationId: string, actualUSD: number): Promise<boolean> {
    try {
      const result = await this.db.sqlite.exec({
        sql: `UPDATE budget_reservations 
              SET actual_usd = ?, state = 'settled', settled_at = ?
              WHERE id = ? AND state = 'reserved'`,
        args: [actualUSD, Date.now(), reservationId],
      })
      
      // Update materialized spend
      await this.updateSpendCache()
      
      return result.changes > 0
    } catch (e) {
      console.error('[budget] settle failed:', e)
      return false
    }
  }

  /**
   * Release a reservation (work didn't happen or was cancelled)
   */
  async release(reservationId: string, reason?: string): Promise<boolean> {
    try {
      const result = await this.db.sqlite.exec({
        sql: `UPDATE budget_reservations 
              SET state = 'released', reason = ?, settled_at = ?
              WHERE id = ? AND state = 'reserved'`,
        args: [reason ?? 'released by caller', Date.now(), reservationId],
      })
      
      // Update materialized spend
      await this.updateSpendCache()
      
      return result.changes > 0
    } catch (e) {
      console.error('[budget] release failed:', e)
      return false
    }
  }

  /**
   * Expire old reservations
   */
  async expireOldReservations(): Promise<number> {
    const now = Date.now()
    const result = await this.db.sqlite.exec({
      sql: `UPDATE budget_reservations 
            SET state = 'expired', reason = 'TTL expired'
            WHERE state = 'reserved' AND expires_at < ?`,
      args: [now],
    })
    
    await this.updateSpendCache()
    return result.changes
  }

  /**
   * Get current spend for scopes
   */
  async getSpend(scope: BudgetScope): Promise<BudgetSpend> {
    // Check materialized cache first
    const cached = await this.getCachedSpend(scope)
    if (cached) {
      return cached
    }
    
    // Calculate from reservations
    return this.calculateSpend(scope)
  }

  /**
   * Get reservation by ID
   */
  async getReservation(id: string): Promise<BudgetReservation | null> {
    const result = await this.db.sqlite.exec({
      sql: 'SELECT * FROM budget_reservations WHERE id = ?',
      args: [id],
    })
    
    if (result.rows.length === 0) return null
    
    const row = result.rows[0]
    return {
      id: row.id as string,
      scope: {
        tenant: row.tenant as string,
        agent: row.agent as string,
        mission: row.mission as string,
        day: row.day as string,
      },
      reservedUSD: Number(row.reserved_usd),
      actualUSD: row.actual_usd ? Number(row.actual_usd) : null,
      state: row.state as 'reserved' | 'settled' | 'released' | 'expired',
      reason: row.reason as string | undefined,
      createdAt: Number(row.created_at),
      settledAt: row.settled_at ? Number(row.settled_at) : undefined,
      expiresAt: Number(row.expires_at),
    }
  }

  /**
   * Get reservation by idempotency key
   */
  async getReservationByIdempotencyKey(key: string): Promise<BudgetReservation | null> {
    const result = await this.db.sqlite.exec({
      sql: 'SELECT * FROM budget_reservations WHERE idempotency_key = ?',
      args: [key],
    })
    
    if (result.rows.length === 0) return null
    
    const row = result.rows[0]
    return {
      id: row.id as string,
      scope: {
        tenant: row.tenant as string,
        agent: row.agent as string,
        mission: row.mission as string,
        day: row.day as string,
      },
      reservedUSD: Number(row.reserved_usd),
      actualUSD: row.actual_usd ? Number(row.actual_usd) : null,
      state: row.state as 'reserved' | 'settled' | 'released' | 'expired',
      reason: row.reason as string | undefined,
      createdAt: Number(row.created_at),
      settledAt: row.settled_at ? Number(row.settled_at) : undefined,
      expiresAt: Number(row.expires_at),
    }
  }

  /**
   * List all active reservations
   */
  async listReservations(state?: string): Promise<BudgetReservation[]> {
    const sql = state 
      ? 'SELECT * FROM budget_reservations WHERE state = ?'
      : 'SELECT * FROM budget_reservations'
    
    const result = await this.db.sqlite.exec({
      sql,
      args: state ? [state] : [],
    })
    
    return result.rows.map((row) => ({
      id: row.id as string,
      scope: {
        tenant: row.tenant as string,
        agent: row.agent as string,
        mission: row.mission as string,
        day: row.day as string,
      },
      reservedUSD: Number(row.reserved_usd),
      actualUSD: row.actual_usd ? Number(row.actual_usd) : null,
      state: row.state as 'reserved' | 'settled' | 'released' | 'expired',
      reason: row.reason as string | undefined,
      createdAt: Number(row.created_at),
      settledAt: row.settled_at ? Number(row.settled_at) : undefined,
      expiresAt: Number(row.expires_at),
    }))
  }

  /**
   * Clean up expired reservations
   */
  async cleanup(): Promise<{ expired: number; released: number }> {
    const expired = await this.expireOldReservations()
    
    // Remove very old completed reservations
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000)
    const result = await this.db.sqlite.exec({
      sql: `DELETE FROM budget_reservations 
            WHERE state IN ('settled', 'released', 'expired') AND created_at < ?`,
      args: [thirtyDaysAgo],
    })
    
    return { expired, released: result.changes }
  }

  /**
   * Get budget health report
   */
  async getHealthReport(tenant: string = 'default'): Promise<{
    caps: BudgetCaps
    spend: BudgetSpend
    reservations: {
      reserved: number
      settled: number
      released: number
      expired: number
    }
    budgetHealth: 'healthy' | 'warning' | 'critical'
    warnings: string[]
  }> {
    const caps = await this.getCaps(tenant)
    const spend = await this.getSpend({
      tenant,
      agent: 'all',
      mission: 'all',
      day: new Date().toISOString().slice(0, 10),
    })
    
    const reservations = await this.listReservations()
    const byState = {
      reserved: reservations.filter(r => r.state === 'reserved').length,
      settled: reservations.filter(r => r.state === 'settled').length,
      released: reservations.filter(r => r.state === 'released').length,
      expired: reservations.filter(r => r.state === 'expired').length,
    }
    
    const warnings: string[] = []
    let budgetHealth: 'healthy' | 'warning' | 'critical' = 'healthy'
    
    // Check budget utilization
    const dailyUtilization = spend.daily / caps.daily
    if (dailyUtilization > 0.9) {
      warnings.push(`Daily budget utilization: ${(dailyUtilization * 100).toFixed(1)}%`)
      budgetHealth = 'warning'
    }
    if (dailyUtilization > 0.95) {
      budgetHealth = 'critical'
    }
    
    // Check for expired reservations
    if (byState.expired > 0) {
      warnings.push(`${byState.expired} expired reservations need cleanup`)
    }
    
    // Check for old reserved reservations
    const oldReservations = reservations.filter(r => 
      r.state === 'reserved' && 
      r.expiresAt < Date.now() - (24 * 60 * 60 * 1000)
    )
    if (oldReservations.length > 0) {
      warnings.push(`${oldReservations.length} reservations expired >24h ago`)
      budgetHealth = 'warning'
    }
    
    return {
      caps,
      spend,
      reservations: byState,
      budgetHealth,
      warnings,
    }
  }

  private async isOverLimit(
    scopeType: 'tenant' | 'agent' | 'mission',
    scopeValue: string,
    day: string,
    cost: number,
    cap: number
  ): Promise<boolean> {
    const result = await this.db.sqlite.exec({
      sql: `
        SELECT COALESCE(SUM(reserved_usd), 0) as total 
        FROM budget_reservations 
        WHERE ${scopeType} = ? AND day = ? AND state IN ('reserved', 'settled')
      `,
      args: [scopeValue, day],
    })
    
    const current = Number(result.rows[0]?.total ?? 0)
    return current + cost > cap
  }

  private async calculateSpend(scope: BudgetScope): Promise<BudgetSpend> {
    const day = scope.day ?? new Date().toISOString().slice(0, 10)
    
    // Calculate effective spend (settled actual, or reserved if not settled)
    const result = await this.db.sqlite.exec({
      sql: `
        SELECT 
          SUM(CASE WHEN state = 'settled' THEN actual_usd ELSE reserved_usd END) as total
        FROM budget_reservations 
        WHERE tenant = ? AND day = ? AND state IN ('reserved', 'settled')
      `,
      args: [scope.tenant, day],
    })
    
    const total = Number(result.rows[0]?.total ?? 0)
    
    return {
      tenant: total,
      agent: total, // Simplified for now
      mission: total,
      daily: total,
    }
  }

  private async getCachedSpend(scope: BudgetScope): Promise<BudgetSpend | null> {
    const day = scope.day ?? new Date().toISOString().slice(0, 10)
    
    const result = await this.db.sqlite.exec({
      sql: 'SELECT tenant, agent, mission, day, total_usd FROM budget_spend WHERE tenant = ? AND day = ?',
      args: [scope.tenant, day],
    })
    
    if (result.rows.length === 0) return null
    
    const row = result.rows[0]
    return {
      tenant: Number(row.tenant),
      agent: Number(row.agent),
      mission: Number(row.mission),
      daily: Number(row.day),
    }
  }

  private async updateSpendCache(): Promise<void> {
    // Recalculate and update materialized spend for today
    const day = new Date().toISOString().slice(0, 10)
    
    await this.db.sqlite.exec({
      sql: `
        DELETE FROM budget_spend WHERE day = ?
      `,
      args: [day],
    })
    
    // Recalculate per tenant/agent/mission
    const reservations = await this.listReservations()
    
    for (const r of reservations) {
      if (r.scope.day !== day) continue
      
      const effective = r.actualUSD ?? r.reservedUSD
      
      await this.db.sqlite.exec({
        sql: `
          INSERT INTO budget_spend (tenant, agent, mission, day, total_usd, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (tenant, agent, mission, day) 
          DO UPDATE SET total_usd = total_usd + ?
        `,
        args: [
          r.scope.tenant, r.scope.agent, r.scope.mission, day,
          effective, Date.now(), effective
        ],
      })
    }
  }

  private generateId(): string {
    return `budget_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
  }
}

export function createDurableBudgetStore(db: MiraDB, config?: Partial<BudgetStoreConfig>): DurableBudgetStore {
  return new DurableBudgetStore(db, config)
}
