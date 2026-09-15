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
