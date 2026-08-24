---
name: error-handling
description: Fail fast at boundaries, typed errors, no silent catches, actionable messages.
triggers:
  - error handling
  - exception
  - try catch
  - throw
  - error propagation
---

# Error Handling

## Principles
- **Fail fast at boundaries**: validate inputs at the edge; throw early with context.
- **Errors are part of the API**: model expected failures as typed results/exceptions,
  not `null` returns or magic sentinel values.
- **Preserve context**: wrap low-level errors with operation context
  (`throw new Error(\`loadConfig: ${path}\`, { cause: err })`) — never swallow the cause.

## Rules
- No empty catch blocks. If you catch, you must handle (retry/fallback) or re-throw enriched.
- Never catch-and-log-then-continue past a broken invariant — that corrupts state quietly.
- User-facing messages: what happened + what to do next. Internal details go to logs.
- Retry only transient failures, with backoff + jitter and a retry budget.
- Cleanup belongs in finally / defer / try-finally — not scattered across branches.

## Review checklist
- Can this failure leave partial writes? Wrap in a transaction or make it idempotent.
- Are error codes stable identifiers callers can branch on?
- Does every await have a failure path? Unhandled promise rejections crash runtimes.
