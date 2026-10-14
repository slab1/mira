/**
 * Signed approval receipts.
 *
 * The threat: an actor who can write the database can mint an approval row that
 * hashes correctly and therefore passes the artifact check. A signature keyed
 * from the environment — never stored in the DB — raises that from "write
 * access to a file" to "access to a secret".
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SIGNING_KEY_ENV,
  WARNING_SIGNING_DISABLED,
  loadSigningKeys,
  signReceipt,
  signingEnabled,
  verifyReceipt,
  type ApprovalReceipt,
} from './approval-signing.js'
import { ApprovalGate, createSqliteApprovalStore } from './approval.js'
import { createDatabase } from '../storage/db.js'
import type { ImprovementProposal } from './proposal.js'
import type { RiskAssessment } from './risk.js'

const KEY = 'k'.repeat(40)
const OTHER_KEY = 'z'.repeat(40)

const RECEIPT: ApprovalReceipt = {
  id: 'prop_1',
  approved: true,
  authoritative: true,
  approver: 'alice',
  artifactHash: 'a'.repeat(32),
  decidedAt: 1_700_000_000_000,
}

let prevKey: string | undefined
beforeEach(() => {
  prevKey = process.env[SIGNING_KEY_ENV]
  delete process.env[SIGNING_KEY_ENV]
})
afterEach(() => {
  if (prevKey === undefined) delete process.env[SIGNING_KEY_ENV]
  else process.env[SIGNING_KEY_ENV] = prevKey
})

describe('key loading', () => {
  test('unset means signing is disabled', () => {
    expect(loadSigningKeys(undefined)).toEqual([])
    expect(signingEnabled(undefined)).toBe(false)
  })

  test('a single key loads', () => {
    expect(loadSigningKeys(KEY)).toEqual([KEY])
  })

  test('a comma-separated list preserves order (first signs, all verify)', () => {
    expect(loadSigningKeys(`${KEY},${OTHER_KEY}`)).toEqual([KEY, OTHER_KEY])
  })

  test('whitespace and empty entries are ignored', () => {
    expect(loadSigningKeys(`  ${KEY} , ,${OTHER_KEY} `)).toEqual([KEY, OTHER_KEY])
    expect(loadSigningKeys('')).toEqual([])
  })

  test('the warning names the env var and the consequence', () => {
    expect(WARNING_SIGNING_DISABLED).toContain(SIGNING_KEY_ENV)
    expect(WARNING_SIGNING_DISABLED).toContain('forge')
  })
})

describe('sign / verify', () => {
  test('signing is disabled without a key', () => {
    expect(signReceipt(RECEIPT, undefined)).toBeNull()
  })

  test('a signature verifies against the key that made it', () => {
    const sig = signReceipt(RECEIPT, KEY)!
    expect(sig).toBeTruthy()
    expect(verifyReceipt(RECEIPT, sig, KEY)).toBe(true)
  })

  test('a signature does not verify under a different key', () => {
    const sig = signReceipt(RECEIPT, KEY)!
    expect(verifyReceipt(RECEIPT, sig, OTHER_KEY)).toBe(false)
  })

  test('a rotated-out key still verifies its old receipts', () => {
    const old = signReceipt(RECEIPT, KEY)!
    // KEY has been rotated out but is still listed for verification.
    expect(verifyReceipt(RECEIPT, old, `${OTHER_KEY},${KEY}`)).toBe(true)
  })

  test('every field in the receipt is covered by the signature', () => {
    const sig = signReceipt(RECEIPT, KEY)!
    for (const field of ['id', 'approver', 'artifactHash', 'decidedAt'] as const) {
      const tampered = { ...RECEIPT, [field]: `${RECEIPT[field]}x` }
      expect(verifyReceipt(tampered, sig, KEY)).toBe(false)
    }
  })

  test('a missing signature never verifies, even with a key set', () => {
    expect(verifyReceipt(RECEIPT, undefined, KEY)).toBe(false)
  })

  test('verification with no key configured is false, not "allowed"', () => {
    // Critical: "no key" must never read as "valid".
    const sig = signReceipt(RECEIPT, KEY)!
    expect(verifyReceipt(RECEIPT, sig, undefined)).toBe(false)
  })

  test('a malformed (non-hex / wrong-length) signature is rejected without throwing', () => {
    expect(verifyReceipt(RECEIPT, 'not-hex', KEY)).toBe(false)
    expect(verifyReceipt(RECEIPT, 'abcd', KEY)).toBe(false)
    expect(verifyReceipt(RECEIPT, 'z'.repeat(64), KEY)).toBe(false)
  })

  test('signature is deterministic for the same receipt and key', () => {
    expect(signReceipt(RECEIPT, KEY)).toBe(signReceipt(RECEIPT, KEY))
  })
})

describe('the gate signs and enforces receipts', () => {
  const ARTIFACT = { targetFile: 'src/a.ts', change: 'diff-A' }
  const HIGH: RiskAssessment = { level: 'high', score: 0.9, reasons: ['x'] }
  const proposal = { id: 'p1', createdBy: 'agent' } as unknown as ImprovementProposal
  const op = { owner: 'alice', authenticated: true, role: 'operator' as const }

  let dir = ''
  function gate() {
    return new ApprovalGate({ store: createSqliteApprovalStore(createDatabase(join(dir, 'a.db'))) })
  }
  function approveWithKey(artifact = ARTIFACT) {
    const g = gate()
    g.requestApproval(proposal, 1, HIGH, artifact)
    g.approve('p1', op)
    return g
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mira-signing-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('with signing on, an approved artifact is authorized', () => {
    process.env[SIGNING_KEY_ENV] = KEY
    expect(approveWithKey().authorizesArtifact(ARTIFACT).ok).toBe(true)
  })

  test('the stored decision carries a signature', () => {
    process.env[SIGNING_KEY_ENV] = KEY
    const g = gate()
    g.requestApproval(proposal, 1, HIGH, ARTIFACT)
    const r = g.approve('p1', op)
    expect(r.signature).toBeTruthy()
    expect(r.decidedAt).toBeGreaterThan(0)
  })

  test('with signing off, no signature is produced and behaviour is unchanged', () => {
    const g = gate()
    g.requestApproval(proposal, 1, HIGH, ARTIFACT)
    const r = g.approve('p1', op)
    expect(r.signature).toBeUndefined()
    expect(g.authorizesArtifact(ARTIFACT).ok).toBe(true)
  })

  test('a receipt signed before signing was enabled is refused once the key is set', () => {
    const g = approveWithKey() // recorded unsigned
    process.env[SIGNING_KEY_ENV] = KEY
    const r = g.authorizesArtifact(ARTIFACT)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('no signed receipt')
    expect(r.reason).toContain('re-approve')
  })

  test('a receipt signed under a different key is refused', () => {
    process.env[SIGNING_KEY_ENV] = KEY
    const g = approveWithKey()
    process.env[SIGNING_KEY_ENV] = OTHER_KEY
    const r = g.authorizesArtifact(ARTIFACT)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('failed signature verification')
  })

  test('a signed receipt survives a restart and still verifies', () => {
    process.env[SIGNING_KEY_ENV] = KEY
    const dbPath = join(dir, 'restart.db')
    const g1 = new ApprovalGate({ store: createSqliteApprovalStore(createDatabase(dbPath)) })
    g1.requestApproval(proposal, 1, HIGH, ARTIFACT)
    g1.approve('p1', op)

    const g2 = new ApprovalGate({ store: createSqliteApprovalStore(createDatabase(dbPath)) })
    expect(g2.authorizesArtifact(ARTIFACT).ok).toBe(true)
  })

  test('a tampered approver in the store fails verification after restart', () => {
    process.env[SIGNING_KEY_ENV] = KEY
    const dbPath = join(dir, 'tamper.db')
    const g1 = new ApprovalGate({ store: createSqliteApprovalStore(createDatabase(dbPath)) })
    g1.requestApproval(proposal, 1, HIGH, ARTIFACT)
    g1.approve('p1', op)

    // Forge: rewrite the persisted decision to name a different approver.
    const db = createDatabase(dbPath)
    const row = db.sqlite
      .query(`SELECT payload FROM evolution_approvals WHERE id = ? AND kind = 'decided'`)
      .get('p1') as { payload: string }
    const payload = JSON.parse(row.payload)
    payload.approver = 'mallory'
    db.sqlite
      .query(`UPDATE evolution_approvals SET payload = ? WHERE id = ? AND kind = 'decided'`)
      .run(JSON.stringify(payload), 'p1')

    const g2 = new ApprovalGate({ store: createSqliteApprovalStore(db) })
    const r = g2.authorizesArtifact(ARTIFACT)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('failed signature verification')
  })

  test('a policy auto-approval produces no receipt and never authorizes', () => {
    process.env[SIGNING_KEY_ENV] = KEY
    const g = gate()
    const res = g.requestApproval(
      { id: 'low', createdBy: 'system' } as unknown as ImprovementProposal,
      0,
      { level: 'low', score: 0.1, reasons: [] },
      ARTIFACT,
    )
    expect(res.approved).toBe(true)
    expect(res.signature).toBeUndefined()
    expect(g.authorizesArtifact(ARTIFACT).ok).toBe(false)
  })
})
