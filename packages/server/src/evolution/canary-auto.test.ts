import { describe, test, expect, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { createDatabase, migrate } from '../storage/db.js'
import { mountEvolutionProposalRoutes } from '../routes/evolution.js'
import type { GovernanceGateLike } from '../patching/governance/index.js'

// Auto-canary wiring: a successful promote calls the canaryStart hook with the
// proposal's engine kind and surfaces the canary id in the response.

let db: ReturnType<typeof createDatabase>

const gate = (applied: boolean): GovernanceGateLike =>
  ({
    get: async () => ({
      id: 'proposal_1',
      patchId: 'patch_1',
      kind: 'tool',
      status: 'verified',
    }),
    promote: async () => ({ applied }),
  }) as unknown as GovernanceGateLike

beforeEach(async () => {
  db = createDatabase(':memory:')
  await migrate(db)
})

const app = (canaryStart?: (engine: string) => { canaryId: string } | null) => {
  const a = new Hono<{ Variables: { requestId: string } }>()
  mountEvolutionProposalRoutes(a, {
    governance: gate(true),
    canaryStart,
  })
  return a
}
const promote = (a: ReturnType<typeof app>) =>
  a.request('/evolution/proposals/proposal_1/promote', { method: 'POST' })

describe('promote → auto-canary hook', () => {
  test('successful promote calls canaryStart with the engine kind', async () => {
    let got: string | undefined
    const res = await promote(
      app((engine) => {
        got = engine
        return { canaryId: 'canary_123' }
      }),
    )
    expect(res.status).toBe(200)
    expect(got).toBe('tool')
    const body = (await res.json()) as { canary?: string }
    expect(body.canary).toBe('canary_123')
  })

  test('hook absent → promote succeeds without canary field', async () => {
    const res = await promote(app(undefined))
    const body = (await res.json()) as { applied: boolean; canary?: string }
    expect(body.applied).toBe(true)
    expect(body.canary).toBeUndefined()
  })

  test('hook returning null (skip) → no canary field, still applied', async () => {
    const res = await promote(app(() => null))
    const body = (await res.json()) as { applied: boolean; canary?: string }
    expect(body.applied).toBe(true)
    expect(body.canary).toBeUndefined()
  })
})
