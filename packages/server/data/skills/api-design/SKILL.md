---
name: api-design
description: REST/RPC contract design — resource modeling, versioning, validation, error semantics.
triggers:
  - api design
  - endpoint
  - rest
  - rpc
  - api contract
  - openapi
---

# API Design

## Resource modeling
- Nouns not verbs: `POST /sessions`, not `/createSession`.
- Nest only for true ownership: `/sessions/:id/messages`; flat + filter params otherwise.
- Plural collections; consistent casing (snake_case or camelCase — pick repo convention).

## Contract discipline
- Validate every input at the boundary (Zod/schema); reject unknown fields explicitly.
- Design the error envelope first: `{ error: { code, message, details } }` — machine-readable codes.
- Status codes: 2xx success, 400 validation, 401 unauthenticated, 403 unauthorized,
  404 not-found, 409 conflict, 422 semantic, 429 rate-limit, 5xx server fault.

## Evolution
- Additive changes only within a version; additive optional fields are safe.
- Version from day one if external (`/v1/`) — headers or path, be consistent.
- Deprecate with notice: document removal timeline in the response header/docs.

## Checklist before shipping
- Idempotency for retries (PUT/DELETE idempotent; POST gets idempotency keys if retried).
- Pagination on any unbounded list (cursor-based preferred).
- Authz checked per-object, not just per-route.
