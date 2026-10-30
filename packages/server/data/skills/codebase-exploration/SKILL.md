---
name: codebase-exploration
description: Fast orientation in unfamiliar code — entry points, module map, call-path tracing.
triggers:
  - explore
  - where is
  - how does
  - find files
  - understand the codebase
  - project structure
---

# Codebase Exploration

## Orientation sequence
1. **Manifests**: package.json / Cargo.toml / go.mod — name, scripts, dependencies reveal the stack.
2. **Entry points**: main/index/bootstrap files; follow initialization top-down.
3. **Directory map**: `ls` the tree two levels deep; names cluster by layer or feature — note which.
4. **One vertical slice**: trace ONE request/command end-to-end (route → handler → service → storage).
   This teaches more than reading every file horizontally.

## Search tactics
- Glob for file names first; grep for unique strings (error messages, route paths) second;
  symbol search (LSP) third — definitions and references beat text search.
- Grep for TODO/FIXME/HACK — free archaeology about known weak spots.
- Check tests: they're executable documentation of intended behavior.

## Output discipline
Answer with exact `file:line` references. State confidence: "verified by tracing" vs
"inferred from naming". Map unknowns explicitly instead of guessing silently.

## Rules
- Read-only: exploration never modifies files.
- Time-box: if a question takes >10 minutes of digging, report findings-so-far and the blocker.
