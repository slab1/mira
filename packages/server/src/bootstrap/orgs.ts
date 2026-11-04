/**
 * Organization Tenancy
 * Load orgs and memberships from database
 */

import type { MiraDB } from '../storage/db.js'
import { log, warn } from '../util/logger.js'

export interface Org {
  id: string
  name: string
  createdAt: string
}

export interface OrgMembership {
  id: string
  orgId: string
  userId: string
  role: string
  createdAt: string
}

/**
 * Load organizations from database
 */
export async function loadOrgs(db: MiraDB): Promise<Map<string, Org>> {
  const orgs = new Map<string, Org>()

  try {
    const rows = db.sqlite.prepare('SELECT id, name, createdAt FROM orgs').all() as Org[]

    for (const row of rows) {
      orgs.set(row.id, row)
    }

    log(`loaded ${orgs.size} organizations`)
  } catch (e) {
    warn(`failed to load organizations: ${e}`)
  }

  return orgs
}

/**
 * Load organization memberships from database
 */
export async function loadOrgMemberships(db: MiraDB): Promise<OrgMembership[]> {
  try {
    const rows = db.sqlite
      .prepare('SELECT id, orgId, userId, role, createdAt FROM org_memberships')
      .all() as OrgMembership[]

    log(`loaded ${rows.length} organization memberships`)
    return rows
  } catch (e) {
    warn(`failed to load organization memberships: ${e}`)
    return []
  }
}

/**
 * Get org by ID
 */
export function getOrg(orgs: Map<string, Org>, orgId: string): Org | undefined {
  return orgs.get(orgId)
}

/**
 * Get memberships for a user
 */
export function getMembershipsForUser(memberships: OrgMembership[], userId: string): OrgMembership[] {
  return memberships.filter((m) => m.userId === userId)
}
