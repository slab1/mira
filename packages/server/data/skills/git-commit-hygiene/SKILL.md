---
name: git-commit-hygiene
description: Conventional Commits, atomic single-concern commits, clean history.
triggers:
  - commit
  - commit message
  - conventional commits
  - git history
  - squash
---

# Git Commit Hygiene

## Format (Conventional Commits)
```
<type>: <imperative summary, ≤50 chars>

Optional body wrapped at 72 chars: WHY the change was made,
not a line-by-line listing of what the diff shows.
```
Types: feat, fix, refactor, test, docs, chore, perf, ci.

## Atomicity rules
- One concern per commit: a fix commit contains ONLY the fix (+ its regression test).
- The commit must build and pass tests on its own — no "broken intermediate" commits.
- Stage deliberately (`git add <files>`), never blanket `git add .` when unrelated
  changes exist in the worktree.

## Message rules
- Imperative mood: "add retry", NOT "added retry" or "fixes bug".
- No ticket prefix unless the repo convention requires it.
- Breaking changes: `!` after type + `BREAKING CHANGE:` footer explaining migration.

## History care
- Never amend/rebase shared branches without explicit instruction.
- Before committing: `git status` + `git diff` — check for generated files,
  secrets, debug prints, and unrelated edits sneaking into the stage.
