---
name: typescript-patterns
description: Type-level safety patterns — discriminated unions, satisfies, zod boundaries, no-any discipline.
triggers:
  - typescript
  - generics
  - type safe
  - zod
  - ts error
---

# TypeScript Patterns

## Model data precisely
- **Discriminated unions** over optional-field soup:
  `{ status: "ok", value: T } | { status: "error", error: E }` — narrowing does the work.
- `as const` + `satisfies` for literal configs: keeps inference AND validates shape.
- Prefer `readonly` arrays/objects on inputs; mutation is a caller surprise.
- Brand opaque ids: `type UserId = string & { __brand: "UserId" }` — stops id mix-ups.

## Boundaries
- Validate external data ONCE at the edge with zod (or similar); inside, trust the types.
- Derive types from schemas (`z.infer`), not the other way — one source of truth.
- No `any`. Use `unknown` + narrowing; use `as` only with a comment proving why it's sound.

## Function hygiene
- Explicit return types on exported functions (catches inference drift).
- Generics: constrain (`<T extends { id: string }>`) — unconstrained generics hide bugs.
- Exhaustiveness: `switch` over unions ends with `default: { const _x: never = x }`.

## Debugging TS errors
Read the error bottom-up: the last line names your actual mistake; the top lines are context.
If types fight you, simplify the type before reaching for casts.
