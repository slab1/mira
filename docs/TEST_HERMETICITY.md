# Test Hermeticity & Environment Overrides

Date: 2026-10-10
Status: Active — introduced while wiring P0–P2 (decision log, team memory, governance auto-RCA)

---

## 1. The problem this solves

Several subsystems persist state to **repo-relative files** whose resolvers _prefer directories that already exist_:

| Store                | Resolver                                               | Default target                                  |
| -------------------- | ------------------------------------------------------ | ----------------------------------------------- |
| RCSI decision ledger | `resolveContextPath()` (`src/learning/ledger.ts`)      | `packages/shared/context.json` (tracked by git) |
| Team memory bank     | `resolveBankDir()` (`src/memory/memory_controller.ts`) | `data/memory_bank/*.md`                         |

The ledger resolver walks candidate paths and picks the first whose **directory exists** — in this repo that is always `packages/shared/context.json`, **regardless of the `rootDir` argument**. The result: any test that exercises `appendDecision()`, `ApprovalGate.approve/deny`, or governance terminal transitions (which all call `appendDecision`) wrote fake entries into a **tracked dev-data file**. A full test-suite run polluted it with ~220 lines of test decisions, mirrored into `shared/context.json` too.

Per-test snapshot/restore was tried first and rejected: it is whack-a-mole (every new caller needs it), races across parallel test files, and restores can interleave. The root fix is two environment overrides plus one test preload.

---

## 2. The two overrides

### `MIRA_CONTEXT_PATH` — redirect the decision ledger

- **Implemented in:** `resolveContextPath()` — checked first, wins over everything, including an explicit `rootDir`.
- **Effect:** all ledger reads/writes (`loadContext`, `saveContext`, `appendDecision`, `getWorkflowTrace`, baseline lookups) go to this single file. `saveContext()` **also skips its mirroring** to `packages/shared/context.json` and `shared/context.json` while the override is set.
- **Wins over:** rootDir argument, cwd candidates, ancestor search.

### `MIRA_MEMORY_BANK_DIR` — redirect the team-memory bank

- **Implemented in:** `resolveBankDir()` (`src/memory/memory_controller.ts`), used by `appendTeamMemory()` (the writer behind the decisions.md mirror, timeline→tech_debt.md mirror, and the `team_memory_write` tool).
- **Precedence (deliberately different from the ledger):**

  ```
  explicit cwd argument        → used as-is (production callers pass rootDir)
  else MIRA_MEMORY_BANK_DIR    → redirect here (incidental test writers)
  else MIRA_DB dirname logic   → production default (…/memory_bank)
  else                         → <cwd>/data/memory_bank
  ```

- **Why the asymmetry vs. the ledger:** in production, the decision-log mirror receives a real `rootDir` (the repo root) and must honor it — the override only needs to catch tests that call `appendDecision()` _without_ a rootDir. The ledger override, by contrast, must win outright because its `rootDir` handling was itself the bug (candidates ignore it when a repo dir exists).
- **Not covered (pre-existing behavior):** `appendActiveWork()` / `ensureMemoryBank()` use their own `MIRA_DB`/cwd resolution and do not consult this override.

---

## 3. When they are active

**Production: never.** Nothing in the server sets either variable; both resolvers fall through to their normal logic.

**Tests: always** — via a preload registered in `packages/server/bunfig.toml`:

```toml
[test]
preload = ["./tests/preload.ts"]
```

`tests/preload.ts` sets both to fresh temp dirs per test process (`??=` so an explicit env wins if you need to pin one):

- `MIRA_CONTEXT_PATH` → `$TMPDIR/mira-test-ledger-*/context.json`
- `MIRA_MEMORY_BANK_DIR` → `$TMPDIR/mira-test-bank-*/`

Because it is a preload, every test file — including ones you write tomorrow — is hermetic by default. You do not need to do anything; you would only notice if you **assert on ledger/bank files**, in which case read from the env vars (see §5).

---

## 4. Manual uses (beyond tests)

Both overrides are general-purpose isolation knobs, useful outside the suite:

- **Run a second, scratch server against the same checkout** without sharing decision history:
  `MIRA_CONTEXT_PATH=/tmp/scratch-context.json bun packages/server`
- **Try risky self-improvement / governance flows** with a throwaway ledger and memory bank, so the real `packages/shared/context.json` and `data/memory_bank/` stay untouched.
- **CI hermeticity:** if CI doesn't use the bunfig preload path (e.g. runs `bun test` from repo root), set both vars in the CI job before the test step.

---

## 5. Writing tests against these stores

| You want to…                                                          | Do this                                                                                                                      |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Assert on decisions written via `appendDecision(...)` without rootDir | Read `process.env.MIRA_CONTEXT_PATH` / `process.env.MIRA_MEMORY_BANK_DIR` (see `src/memory/team_memory.test.ts`)             |
| Assert on a specific bank location                                    | Pass an explicit `cwd`/`rootDir` — it wins over the redirect (`appendTeamMemory({ cwd })`, `appendDecision(entry, rootDir)`) |
| Assert on ledger content                                              | `loadContext()` — already redirected; assert by marker, not absolute counts, if other tests share the process                |
| Verify hermeticity                                                    | `git status` after a full suite: `packages/shared/context.json`, `shared/context.json`, `data/memory_bank/` must be clean    |

Fire-and-forget caveat: the decisions.md mirror inside `appendDecision()` is async (`void import(...).then(...)`), so tests poll briefly (~1s max) for the file to appear — see the existing polling loops in `team_memory.test.ts`.

---

## 6. File map

| File                                              | Role                                                                                |
| ------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `packages/server/tests/preload.ts`                | Sets both overrides for the test process                                            |
| `packages/server/bunfig.toml`                     | Registers the preload under `[test]`                                                |
| `packages/server/src/learning/ledger.ts`          | `MIRA_CONTEXT_PATH` check in `resolveContextPath()`; mirror skip in `saveContext()` |
| `packages/server/src/memory/memory_controller.ts` | `MIRA_MEMORY_BANK_DIR` check in `resolveBankDir()`; `appendTeamMemory()` writer     |
| `packages/server/src/memory/team_memory.test.ts`  | Reference tests for all of the above                                                |
