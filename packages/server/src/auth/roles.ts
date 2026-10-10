/**
 * RBAC role primitives (master findings P3.1) — replaces the binary
 * admin-vs-owner model with three roles:
 *
 *   viewer    — read-only: GET/HEAD only; all mutating requests 403
 *   operator  — full normal use (sessions, tools, config) — the default
 *               for existing keys (backward compatible)
 *   admin     — everything incl. /admin/* (key minting, audit, exports)
 *
 * Key format: MIRA_API_KEYS=key:owner[:role] — the optional third segment.
 * The master MIRA_TOKEN (owner "default") is always admin.
 */

export type Role = 'viewer' | 'operator' | 'admin'

export const ROLES: Role[] = ['viewer', 'operator', 'admin']

export const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 }

export function isRole(v: string): v is Role {
  return v === 'viewer' || v === 'operator' || v === 'admin'
}

/**
 * Parse one MIRA_API_KEYS pair. Backward compatible: a trailing `:role`
 * segment is stripped from the owner only when it is a valid role keyword
 * (owners that legitimately contain colons keep working when the tail is
 * not a role).
 */
export function parseKeyPair(pair: string): { key: string; owner: string; role: Role | undefined } {
  const i = pair.indexOf(':')
  if (i <= 0) return { key: pair, owner: pair, role: undefined }
  const key = pair.slice(0, i)
  let owner = pair.slice(i + 1)
  let role: Role | undefined
  const last = owner.lastIndexOf(':')
  if (last >= 0 && isRole(owner.slice(last + 1))) {
    role = owner.slice(last + 1) as Role
    owner = owner.slice(0, last)
  }
  return { key, owner, role }
}

/** Role for an owner given the owner→role map; 'default' is always admin. */
export function roleForOwner(owner: string | undefined, ownerRoles: Map<string, Role>): Role {
  if (owner === 'default') return 'admin'
  return ownerRoles.get(owner ?? '') ?? 'operator'
}

/** True when `role` satisfies the `min` requirement. */
export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min]
}
