/**
 * Session access rule (P3.3 org tenancy) — the single predicate behind
 * REST list filters, per-session gates (authorizedSession) and WS delivery:
 *
 *   readable ⟺ ownerless (legacy/shared) ∨ caller owns it ∨ caller is in
 *              the session's org
 *
 * Takes the resolved org of the caller (live membership map) so membership
 * changes apply immediately without touching stored rows.
 */

export type SessionAccessRow = { ownerID: string | null; orgID: string | null }

export function sessionVisibleTo(
  row: SessionAccessRow,
  owner: string | null | undefined,
  orgOfOwner: (o: string | null | undefined) => string | undefined,
): boolean {
  if (!row.ownerID) return true
  if (row.ownerID === owner) return true
  return row.orgID != null && orgOfOwner(owner) === row.orgID
}
