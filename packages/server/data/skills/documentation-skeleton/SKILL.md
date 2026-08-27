---
name: documentation-skeleton
description: Standardized templates for README, CHANGELOG, API docs, and ADR.
triggers:
  - documentation
  - README template
  - CHANGELOG
  - ADR
  - API docs
  - docs skeleton
---
# Documentation Skeleton

## README.md
- Title + one-line purpose.
- Quick start: install, configure, run.
- Core concepts + architecture diagram.
- Examples: minimal working snippet.
- Development: test, lint, build commands.
- Contributing guide + license.

## CHANGELOG.md
- Keep- a- changelog format: `## [Unreleased]`, `## [1.2.0] - 2026-08-27`.
- Categories: Added, Changed, Deprecated, Removed, Fixed, Security.
- Link PRs/issues.

## API docs
- OpenAPI/AsyncAPI spec generated from code.
- Endpoint tables: method, path, auth, request/response schemas.
- Error codes table + examples.

## ADR
- Title, date, status.
- Context, decision, consequences.
- Alternatives considered.

## Maintenance
- Keep docs close to code.
- Generate from source where possible.
- Review docs on every PR.
