/**
 * Storage — Org tenancy (P3.3)
 *
 * Orgs group owners so they share session visibility (REST + WS): a session
 * stamped with an orgID is accessible to the owner and same-org members.
 * Single-org-per-owner is enforced by UNIQUE(owner) on org_members — the
 * membership lookup owner → {org, role} is a function, keeping session
 * stamping and access predicates deterministic.
 */
import { and, eq } from 'drizzle-orm'
import type { MiraDB } from './db.js'

export type OrgRole = 'admin' | 'member'

export function isOrgRole(v: string): v is OrgRole {
  return v === 'admin' || v === 'member'
}

export type OrgRow = {
  id: string
  name: string
  createdBy: string
  createdAt: number
}

export type OrgMemberRow = {
  orgID: string
  owner: string
  role: OrgRole
  createdAt: number
}

export async function createOrg(
  db: MiraDB,
  input: { name: string; createdBy: string },
): Promise<OrgRow> {
  const row: OrgRow = {
    id: crypto.randomUUID(),
    name: input.name,
    createdBy: input.createdBy,
    createdAt: Date.now(),
  }
  await db.insert(db.schema.orgs).values(row)
  return row
}

export async function getOrg(db: MiraDB, id: string): Promise<OrgRow | undefined> {
  return db.query.orgs.findFirst({ where: (o, { eq }) => eq(o.id, id) })
}

export async function getOrgByName(db: MiraDB, name: string): Promise<OrgRow | undefined> {
  return db.query.orgs.findFirst({ where: (o, { eq }) => eq(o.name, name) })
}

export async function addOrgMember(
  db: MiraDB,
  input: { orgID: string; owner: string; role: OrgRole },
): Promise<OrgMemberRow> {
  const row: OrgMemberRow = {
    orgID: input.orgID,
    owner: input.owner,
    role: input.role,
    createdAt: Date.now(),
  }
  await db.insert(db.schema.orgMembers).values(row)
  return row
}

/** Normalize a drizzle row's `role: string` into the OrgRole union. */
function memberRow(r: {
  orgID: string
  owner: string
  role: string
  createdAt: number
}): OrgMemberRow {
  return { ...r, role: isOrgRole(r.role) ? r.role : 'member' }
}

export async function findOrgMember(
  db: MiraDB,
  orgID: string,
  owner: string,
): Promise<OrgMemberRow | undefined> {
  const members = await db.query.orgMembers.findMany({ where: (m, { eq }) => eq(m.orgID, orgID) })
  const hit = members.find((m) => m.owner === owner)
  return hit ? memberRow(hit) : undefined
}

/** Remove a membership. Returns false when the owner is not in this org. */
export async function removeOrgMember(db: MiraDB, orgID: string, owner: string): Promise<boolean> {
  const existing = await findOrgMember(db, orgID, owner)
  if (!existing) return false
  await db
    .delete(db.schema.orgMembers)
    .where(and(eq(db.schema.orgMembers.orgID, orgID), eq(db.schema.orgMembers.owner, owner)))
  return true
}

export async function listOrgMembers(db: MiraDB, orgID: string): Promise<OrgMemberRow[]> {
  const members = await db.query.orgMembers.findMany({ where: (m, { eq }) => eq(m.orgID, orgID) })
  return members.map(memberRow)
}

/** The single membership for an owner (UNIQUE(owner)), if any. */
export async function getOrgMember(db: MiraDB, owner: string): Promise<OrgMemberRow | undefined> {
  const m = await db.query.orgMembers.findFirst({ where: (mem, { eq }) => eq(mem.owner, owner) })
  return m ? memberRow(m) : undefined
}
