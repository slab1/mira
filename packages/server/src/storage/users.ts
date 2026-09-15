/**
 * Storage — User identity (Lane B)
 *
 * One row per authenticated owner (MIRA_TOKEN → "default", MIRA_API_KEYS → the
 * key's owner). Rows are auto-created on first GET /me with the default name
 * "user"; the web onboarding and `mira profile set` personalize the name.
 * Lane C reads the name via getUserNameForOwner to inject it into the system
 * prompt (agents address the user by name).
 */
import type { MiraDB } from './db.js'

export type UserRow = {
  id: string
  owner: string
  name: string
  createdAt: number
  updatedAt: number
}

/** Upsert a user row for an owner — auto-creates with the default name "user". */
export async function getUserByOwner(db: MiraDB, owner: string): Promise<UserRow> {
  const existing = await db.query.users.findFirst({
    where: (u, { eq }) => eq(u.owner, owner),
  })
  if (existing) return existing
  const now = Date.now()
  const row: UserRow = {
    id: crypto.randomUUID(),
    owner,
    name: 'user',
    createdAt: now,
    updatedAt: now,
  }
  // Race-safe: concurrent first GET /me for the same owner — one insert wins.
  await db.insert(db.schema.users).values(row).onConflictDoNothing()
  const after = await db.query.users.findFirst({
    where: (u, { eq }) => eq(u.owner, owner),
  })
  return after ?? row
}

/**
 * Name for prompt injection (Lane C). Returns undefined when the owner is
 * unknown (legacy sessions / unauthenticated paths) so callers can skip the
 * personalization line entirely — buildSystemPrompt stays byte-identical.
 */
export async function getUserNameForOwner(
  db: MiraDB,
  owner: string | null | undefined,
): Promise<string | undefined> {
  if (!owner) return undefined
  const u = await getUserByOwner(db, owner)
  return u.name
}
