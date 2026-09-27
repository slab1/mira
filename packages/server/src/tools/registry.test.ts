import { describe, test, expect } from 'bun:test'
import { z } from 'zod'
import { ToolRegistry, type ToolDef, type ToolContext, type RegistryDeps } from './registry.js'

/**
 * Deterministic seam tests for ToolRegistry.
 *
 * Deps note: db/bus/permissions/gateway are stubbed with empty objects because the
 * code paths under test (timeout wrapper, maxCallsPerRun, result normalization,
 * tool.executed events) never dereference them for a non-mutating fake tool —
 * guardrails is left undefined so pre/post checks are skipped.
 */

function makeRegistry(): ToolRegistry {
  const deps = {
    db: {} as RegistryDeps['db'],
    bus: {} as RegistryDeps['bus'],
    permissions: {} as RegistryDeps['permissions'],
    gateway: {} as RegistryDeps['gateway'],
    // guardrails intentionally omitted
  } as RegistryDeps
  return new ToolRegistry(deps)
}

function fakeTool(overrides: Partial<ToolDef> & { name: string }): ToolDef {
  return {
    description: 'fake tool for tests',
    schema: z.object({}).passthrough(),
    category: 'other',
    execute: async () => ({ done: true }),
    ...overrides,
  } as ToolDef
}

const ctx = (overrides?: Partial<ToolContext>): ToolContext => ({
  sessionID: 'sess-1',
  messageID: 'msg-1',
  ...overrides,
})

describe('ToolRegistry.execute — timeout wrapper', () => {
  test('rejects with TOOL_TIMEOUT when tool.execute exceeds metadata.timeoutMs', async () => {
    const reg = makeRegistry()
    reg.register(
      fakeTool({
        name: 'slow_tool',
        metadata: {
          riskLevel: 'low',
          sideEffect: 'none',
          isReadOnly: true,
          isIdempotent: true,
          timeoutMs: 50, // per-tool timeoutMs is the injectable seam (default 30000)
        },
        execute: () => new Promise((resolve) => setTimeout(resolve, 500)),
      }),
    )
    let err: unknown
    try {
      await reg.execute('slow_tool', {}, ctx())
    } catch (e) {
      err = e
    }
    expect(String(err)).toContain('timed out after 50ms')
    expect((err as { code?: string })?.code).toBe('TOOL_TIMEOUT')
  })

  test('resolves normally when tool finishes within timeoutMs', async () => {
    const reg = makeRegistry()
    reg.register(
      fakeTool({
        name: 'fast_tool',
        metadata: {
          riskLevel: 'low',
          sideEffect: 'none',
          isReadOnly: true,
          isIdempotent: true,
          timeoutMs: 1000,
        },
        execute: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 10)),
      }),
    )
    const out = await reg.execute('fast_tool', {}, ctx())
    expect(out).toEqual({ ok: true })
  })

  test('tool.executed bus event has success:false + errorCode on timeout', async () => {
    const reg = makeRegistry()
    const events: Array<Record<string, unknown>> = []
    reg.register(
      fakeTool({
        name: 'slow_bus_tool',
        metadata: {
          riskLevel: 'low',
          sideEffect: 'none',
          isReadOnly: true,
          isIdempotent: true,
          timeoutMs: 40,
        },
        execute: () => new Promise((resolve) => setTimeout(resolve, 400)),
      }),
    )
    await expect(
      reg.execute(
        'slow_bus_tool',
        {},
        ctx({ bus: { emit: (t: string, p: Record<string, unknown>) => void events.push(p) } as never }),
      ),
    ).rejects.toThrow('timed out')
    expect(events).toHaveLength(1)
    expect(events[0].tool).toBe('slow_bus_tool')
    expect(events[0].success).toBe(false)
    expect(events[0].errorCode).toBe('TOOL_TIMEOUT')
  })
})

describe('ToolRegistry.execute — maxCallsPerRun rate limit', () => {
  test('throws TOOL_RATE_LIMIT after maxCallsPerRun, counts per session', async () => {
    const reg = makeRegistry()
    let calls = 0
    reg.register(
      fakeTool({
        name: 'limited_tool',
        metadata: {
          riskLevel: 'low',
          sideEffect: 'none',
          isReadOnly: true,
          isIdempotent: true,
          maxCallsPerRun: 2,
        },
        execute: async () => {
          calls++
          return { calls }
        },
      }),
    )
    await reg.execute('limited_tool', {}, ctx())
    await reg.execute('limited_tool', {}, ctx())
    let err: unknown
    try {
      await reg.execute('limited_tool', {}, ctx())
    } catch (e) {
      err = e
    }
    expect((err as { code?: string })?.code).toBe('TOOL_RATE_LIMIT')
    expect(String(err)).toContain('rate limit exceeded')
    expect(calls).toBe(2) // third call never executed

    // different session has an independent counter
    const other = await reg.execute('limited_tool', {}, ctx({ sessionID: 'sess-2' }))
    expect(other).toEqual({ calls: 3 })
  })
})

describe('ToolRegistry.execute — result normalization', () => {
  test('primitive (non-object) result is wrapped as { ok: true, data }', async () => {
    const reg = makeRegistry()
    reg.register(fakeTool({ name: 'prim_tool', execute: async () => 'hello' as never }))
    const out = (await reg.execute('prim_tool', {}, ctx())) as { ok: boolean; data: string }
    expect(out.ok).toBe(true)
    expect(out.data).toBe('hello')
  })

  test('object result passes through unwrapped', async () => {
    const reg = makeRegistry()
    reg.register(fakeTool({ name: 'obj_tool', execute: async () => ({ a: 1 }) as never }))
    const out = (await reg.execute('obj_tool', {}, ctx())) as Record<string, unknown>
    expect(out).toEqual({ a: 1 })
    // NOTE (gap): the { ok, data, error, errorCode } envelope is NOT built for
    // object results, and error/errorCode live only on the tool.executed bus
    // event — the return value on failure is a thrown exception, not a shape.
  })

  test('thrown Error propagates with message (stringified on bus event)', async () => {
    const reg = makeRegistry()
    const events: Array<Record<string, unknown>> = []
    reg.register(
      fakeTool({
        name: 'throwing_tool',
        execute: async () => {
          throw new Error('boom')
        },
      }),
    )
    const bus = { emit: (_t: string, p: Record<string, unknown>) => void events.push(p) }
    await expect(
      reg.execute('throwing_tool', {}, ctx({ bus: bus as never })),
    ).rejects.toThrow('boom')
    expect(events).toHaveLength(1)
    expect(events[0].success).toBe(false)
    expect(String(events[0].error)).toContain('boom')
    expect(events[0].errorCode).toBeUndefined() // plain Error has no .code
  })

  test('Error-like with .code surfaces the code on the bus event', async () => {
    const reg = makeRegistry()
    const events: Array<Record<string, unknown>> = []
    reg.register(
      fakeTool({
        name: 'coded_tool',
        execute: async () => {
          const e = new Error('nope') as Error & { code: string }
          e.code = 'E_CUSTOM'
          throw e
        },
      }),
    )
    await expect(
      reg.execute(
        'coded_tool',
        {},
        ctx({ bus: { emit: (_t: string, p: Record<string, unknown>) => void events.push(p) } as never }),
      ),
    ).rejects.toThrow('nope')
    expect(events[0].errorCode).toBe('E_CUSTOM')
  })

  test('successful call emits tool.executed with success:true', async () => {
    const reg = makeRegistry()
    const events: Array<Record<string, unknown>> = []
    reg.register(fakeTool({ name: 'ok_tool', execute: async () => ({ v: 42 }) as never }))
    await reg.execute(
      'ok_tool',
      {},
      ctx({
        sessionID: 'sess-x',
        messageID: 'msg-x',
        bus: { emit: (_t: string, p: Record<string, unknown>) => void events.push(p) } as never,
      }),
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ sessionID: 'sess-x', messageID: 'msg-x', tool: 'ok_tool', success: true })
  })
})

describe('ToolRegistry.execute — misc guards', () => {
  test('unknown tool name throws', async () => {
    const reg = makeRegistry()
    await expect(reg.execute('nope', {}, ctx())).rejects.toThrow('Unknown tool: nope')
  })

  test('invalid args fail Zod validation before execute runs', async () => {
    const reg = makeRegistry()
    let executed = false
    reg.register(
      fakeTool({
        name: 'strict_tool',
        schema: z.object({ required_str: z.string() }),
        execute: async () => {
          executed = true
          return {}
        },
      }),
    )
    await expect(reg.execute('strict_tool', { required_str: 5 }, ctx())).rejects.toThrow(
      'Invalid args for strict_tool',
    )
    expect(executed).toBe(false)
  })

  test('duplicate non-mcp registration is rejected', () => {
    const reg = makeRegistry()
    reg.register(fakeTool({ name: 'dup' }))
    expect(() => reg.register(fakeTool({ name: 'dup' }))).toThrow('already registered')
  })
})
