/**
 * Signed approval receipts.
 *
 * The artifact binding (artifact-hash.ts) is tamper *evidence*, not tamper
 * *proof*: the diff it hashes lives in the same database row the promotion
 * pipeline trusts, so an actor who can write the store can write a row that
 * hashes correctly and carries a fabricated approval.
 *
 * A signature moves the trust boundary. The HMAC key comes from the process
 * environment and is never written to the database, so a database-level
 * attacker cannot forge a receipt — they would also need the key. This does
 * not defend against an attacker who already controls the running process or
 * its environment; it raises the bar from "write access to a file" to "access
 * to a secret".
 *
 * Key handling
 *   MIRA_APPROVAL_SIGNING_KEY is a comma-separated list. The FIRST key signs
 *   new receipts; ALL of them verify existing ones, so rotating the key does
 *   not invalidate receipts signed under the previous one.
 *
 *   Unset => no receipts are signed and the guarantee is simply absent. A
 *   server does not refuse to start for it, because that would break every
 *   existing deployment, but it warns loudly at boot.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

export const SIGNING_KEY_ENV = 'MIRA_APPROVAL_SIGNING_KEY'

/** The exact content an approval receipt commits to. */
export interface ApprovalReceipt {
  /** Proposal id — included so a receipt cannot be replayed for another id. */
  id: string
  approved: true
  authoritative: true
  approver: string
  /** Hash of the artifact this approval authorizes. */
  artifactHash: string
  decidedAt: number
}

export const WARNING_SIGNING_DISABLED =
  `[mira] ${SIGNING_KEY_ENV} is not set — approval receipts are UNSIGNED. Anyone able to ` +
  'write the database can forge an approval and promote a change they never reviewed. ' +
  `Set ${SIGNING_KEY_ENV} to a random 32+ character secret to enable receipt signatures.`

/** All configured keys, in order. Empty when signing is disabled. */
export function loadSigningKeys(raw: string | undefined = process.env[SIGNING_KEY_ENV]): string[] {
  return (raw ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
}

/** True when receipts are being signed. */
export function signingEnabled(raw?: string): boolean {
  return loadSigningKeys(raw).length > 0
}

/**
 * Canonical serialization. Built from a fixed key order so the same receipt
 * always produces the same bytes; any field an attacker could change is inside
 * the signed material.
 */
function canonicalize(r: ApprovalReceipt): string {
  return JSON.stringify({
    id: r.id,
    approved: r.approved,
    authoritative: r.authoritative,
    approver: r.approver,
    artifactHash: r.artifactHash,
    decidedAt: r.decidedAt,
  })
}

function hmac(key: string, message: string): Buffer {
  return createHmac('sha256', key).update(message).digest()
}

/** Sign a receipt with the first configured key. Returns null when disabled. */
export function signReceipt(receipt: ApprovalReceipt, raw?: string): string | null {
  const key = loadSigningKeys(raw)[0]
  if (!key) return null
  return hmac(key, canonicalize(receipt)).toString('hex')
}

/**
 * Verify a receipt against every configured key (first = current, rest =
 * rotated-out keys still accepted). Returns false when signing is disabled, so
 * a caller cannot mistake "no key" for "valid signature".
 */
export function verifyReceipt(
  receipt: ApprovalReceipt,
  signature: string | undefined,
  raw?: string,
): boolean {
  const keys = loadSigningKeys(raw)
  if (!keys.length) return false
  if (!signature) return false
  const provided = Buffer.from(signature, 'hex')
  // Compare against every key without short-circuiting on mismatch, and
  // ignore length mismatches (a wrong-length hex buffer cannot be valid).
  if (provided.length !== 32) return false
  const message = canonicalize(receipt)
  let ok = false
  for (const key of keys) {
    const expected = hmac(key, message)
    // timingSafeEqual throws on length mismatch; lengths are pinned to 32 here.
    if (timingSafeEqual(expected, provided)) ok = true
  }
  return ok
}
