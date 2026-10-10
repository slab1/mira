/**
 * Test preload — hermetic ledger + memory bank (registered via bunfig.toml [test].preload).
 * Full design + precedence rules: docs/TEST_HERMETICITY.md
 *
 * Two redirections, both unset in production:
 *  1. MIRA_CONTEXT_PATH   — the RCSI ledger (shared/context.json) whose resolver
 *     prefers existing repo directories; any test touching appendDecision /
 *     approval / governance wiring would otherwise write the repo's ledger.
 *  2. MIRA_MEMORY_BANK_DIR — the team-memory mirror (memory_bank/*.md) used by
 *     decision-log writers without an explicit cwd.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MIRA_CONTEXT_PATH ??= join(
  mkdtempSync(join(tmpdir(), 'mira-test-ledger-')),
  'context.json',
)
process.env.MIRA_MEMORY_BANK_DIR ??= mkdtempSync(join(tmpdir(), 'mira-test-bank-'))
