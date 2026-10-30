---
name: ci-pipelines
description: CI workflow authoring and repair — fast pipelines, cached deps, green-before-merge.
triggers:
  - ci
  - pipeline
  - github actions
  - workflow yaml
  - build failing
  - ci failing
---

# CI Pipelines

## Pipeline anatomy (fast first)
1. Install (cached: package-manager lockfile as cache key).
2. Static checks: typecheck + lint — cheapest, fail first.
3. Unit tests (parallel shards if suite >5min).
4. Build artifact / integration tests last.

## Authoring rules
- Pin action versions (`actions/checkout@v4`) — floating tags break silently.
- Trigger on PR + push to main; scope paths filters to avoid no-op runs.
- Fail loudly: set strict modes (`set -euo pipefail`); never `|| true` a real check.
- Secrets via masked env/context vars — never echoed, never in cache keys.

## Debugging red CI
1. Reproduce LOCALLY first with the same commands/versions — most failures are local.
2. Diff environment: node/runtime versions, env vars, OS-specific paths (Windows `\` vs `/`).
3. Read the FULL log from the first error, not just the tail — root cause is usually upstream.
4. Fix forward with a commit; avoid re-running-and-hoping.

## Hygiene
- Delete workflows nobody uses; a dead pipeline is a false sense of safety.
- Required checks must map to jobs that actually gate the merge.
