import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildSystemPrompt } from './prompt.js'

// Lane C: buildSystemPrompt(cwd?, userName?) — the personalization line must
// appear only for real names, and the output must stay byte-identical when no
// (or a default) name is passed, so existing prompt consumers are unaffected.

let dir: string

beforeAll(() => {
  // Empty temp dir — no AGENTS.md/CLAUDE.md/.mira/instructions.md, so the
  // base prompt is deterministic (the two fixed lines only).
  dir = mkdtempSync(join(tmpdir(), 'mira-prompt-'))
})

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
})

describe('buildSystemPrompt personalization (Lane C)', () => {
  test('byte-identical when userName is omitted', async () => {
    const base = await buildSystemPrompt(dir)
    expect(await buildSystemPrompt(dir, undefined)).toBe(base)
  })

  test('byte-identical for empty and whitespace-only names', async () => {
    const base = await buildSystemPrompt(dir)
    expect(await buildSystemPrompt(dir, '')).toBe(base)
    expect(await buildSystemPrompt(dir, '   ')).toBe(base)
  })

  test('byte-identical for the default name "user"', async () => {
    const base = await buildSystemPrompt(dir)
    expect(await buildSystemPrompt(dir, 'user')).toBe(base)
    expect(await buildSystemPrompt(dir, '  user  ')).toBe(base)
  })

  test('prepends a personalization line for a real name', async () => {
    const out = await buildSystemPrompt(dir, 'Ada Lovelace')
    expect(out).toContain('You are assisting Ada Lovelace')
    expect(out).toContain('Address them by name naturally')
    // The base lines are still present
    expect(out).toContain('You are Mira — a senior AI agent')
    expect(out).toContain('Follow plan-first workflow')
  })

  test('trims surrounding whitespace from the name', async () => {
    const out = await buildSystemPrompt(dir, '  Ada  ')
    expect(out).toContain('You are assisting Ada')
    expect(out).not.toContain('You are assisting   Ada')
  })
})

describe('buildSystemPrompt presence (P3.3)', () => {
  test('present member replaces the absent owner in the personalization', async () => {
    const out = await buildSystemPrompt(dir, 'Alice', 'Bob')
    expect(out).toContain('You are assisting Bob, working in Alice' + String.raw`'s session`)
    expect(out).toContain('Address them by name naturally')
    expect(out).not.toContain('You are assisting Alice.')
  })

  test('present == owner behaves exactly like the two-arg form', async () => {
    expect(await buildSystemPrompt(dir, 'Alice', 'Alice')).toBe(
      await buildSystemPrompt(dir, 'Alice'),
    )
  })

  test('present member with an unpersonalized owner has no owner reference', async () => {
    const out = await buildSystemPrompt(dir, 'user', 'Bob')
    expect(out).toContain('You are assisting Bob.')
    expect(out).not.toContain('working in')
  })

  test('default "user" present falls back to the owner line', async () => {
    const out = await buildSystemPrompt(dir, 'Alice', 'user')
    expect(out).toContain('You are assisting Alice')
  })

  test('byte-identical when presentUser is omitted (legacy callers)', async () => {
    const two = await buildSystemPrompt(dir, 'Alice')
    expect(await buildSystemPrompt(dir, 'Alice', undefined)).toBe(two)
    const base = await buildSystemPrompt(dir)
    expect(await buildSystemPrompt(dir, undefined, undefined)).toBe(base)
  })
})
