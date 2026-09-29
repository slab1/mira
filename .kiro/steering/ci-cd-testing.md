---
inclusion: manual
name: ci-cd-testing
description: Mira CI/CD pipeline details, GitHub Actions workflows, eval tiers, Docker build, and test execution guide.
---

# Mira — CI/CD & Testing Guide

## GitHub Actions workflows

| File           | Trigger                           | Purpose                                                            |
| -------------- | --------------------------------- | ------------------------------------------------------------------ |
| `ci.yml`       | push/PR to `main`                 | Type-check, build, test, eval PR tier, auth guard, repo hygiene    |
| `cd.yml`       | push `main` / `workflow_dispatch` | Build → Docker multi-arch → GHCR → deploy                          |
| `eval.yml`     | nightly 02:00 UTC / manual        | Full eval suites (judge, SWE-bench, Terminal-Bench, LoCoMo memory) |
| `pages.yml`    | `packages/web/**` changes         | Build web client → GitHub Pages                                    |
| `security.yml` | push/PR `main` + weekly Mon 06:00 | `bun audit`, Gitleaks secrets scan, CodeQL                         |

## CI pipeline (ci.yml) — job order

```
changes (path-filter)
  ├─ repo-hygiene     — fails if node_modules is tracked in git
  ├─ auth-guard       — verifies .env.example placeholder, no real secrets in src,
  │                     STRICT_AUTH fail-closed check (server must refuse start)
  ├─ typecheck        — bunx turbo run typecheck --continue
  └─ build (needs: changes, typecheck)
       └─ test (needs: changes, build)
            └─ eval (needs: test)
```

**Path filtering:** docs-only PRs skip build/test (status = "skipped", never vacuous green).

**Affected-only builds (PRs):**

```bash
FILTER="...[origin/main...HEAD]"
bunx turbo run build --filter="$FILTER" --dry=json  # check task count
bunx turbo run build --filter="$FILTER" --continue --cache-dir=.turbo
# Falls back to full build if filter resolves 0 tasks — never green on empty
```

**Turbo remote cache:** set `TURBO_TOKEN` + `TURBO_TEAM` secrets in GitHub repo settings.
Forks without secrets gracefully use local `.turbo/` cache.

**Blocking packages** (must pass — tri-state check): `@mira/server`, `@mira/shared`.
Non-blocking packages produce warnings, not failures.

## Running tests locally

```bash
# All packages via Turbo
bun run test

# Server unit tests only
bun test                                          # from packages/server/

# Server E2E (boots real server)
bun test e2e/server.e2e.test.ts                  # from packages/server/
bun test e2e/queue.test.ts

# Server eval — fast PR tier (no keys required beyond stubs)
bun run --cwd packages/server src/eval/index.ts --tier pr

# Server eval — full nightly
bun run --cwd packages/server src/eval/index.ts --suite=judge --tier=full

# Single package
bunx turbo run test --filter=@mira/server
bunx turbo run test --filter=@mira/shared
```

**Live-gated tests** auto-skip when credentials/binaries are absent:

- LLM roundtrip → skips without `OPENROUTER_API_KEY` or `NVIDIA_API_KEY`
- Vision → skips without `NVIDIA_API_KEY`
- gopls LSP → skips without `gopls` binary in PATH

## Eval tiers

| Tier               | When                 | Command                         |
| ------------------ | -------------------- | ------------------------------- |
| `fast` / `pr`      | Every PR in CI       | `src/eval/index.ts --tier pr`   |
| `full` / `nightly` | Nightly at 02:00 UTC | `src/eval/index.ts --tier full` |
| `prod`             | Post-deploy          | Prod-drift check via `/metrics` |

Self-improvement gate: `MIRA_EVAL_GATE=1` — synthesized patches only apply after the PR eval tier passes.

## Docker build & push

```bash
# Local build
docker build -t ghcr.io/slab1/mira:latest .

# Multi-arch (mirrors CD pipeline)
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/slab1/mira:latest --push .
```

**Smoke test baked into builder stage:**

```dockerfile
RUN test -f packages/server/dist/index.js && test -f packages/web/dist/index.html
```

If either artifact is missing the build fails fast.

**Tags produced by CD:**

- `ghcr.io/slab1/mira:<sha>` — always
- `ghcr.io/slab1/mira:latest` — on default branch
- `ghcr.io/slab1/mira:<semver>` — on version tags (from semantic-release)

## Deploying

CD runs automatically on push to `main` when `vars.DEPLOY_ENABLED=true`.

Required GitHub repo vars/secrets:

| Key               | Type   | Purpose                                     |
| ----------------- | ------ | ------------------------------------------- |
| `DEPLOY_ENABLED`  | var    | `true` to enable deploy job                 |
| `DEPLOY_HOOK_URL` | var    | Webhook URL that triggers actual deployment |
| `DEPLOY_TOKEN`    | secret | Bearer token for deploy hook                |
| `DEPLOY_URL`      | var    | Health-check URL (`GET $DEPLOY_URL/health`) |
| `GITHUB_TOKEN`    | auto   | GHCR push + GitHub release                  |
| `NPM_TOKEN`       | secret | (optional) npm publish for `mira-cli-ts`    |
| `TURBO_TOKEN`     | secret | (optional) Turbo remote cache               |
| `TURBO_TEAM`      | var    | (optional) Turbo remote cache team          |

## Semantic release (CLI package)

`packages/cli` uses `semantic-release` on push to `main`.
Without `NPM_TOKEN`, it falls back to a GitHub release tag only (no npm publish).

## Security CI checks

```bash
# Local equivalents of security.yml jobs
bun audit                                  # dependency audit
# Gitleaks — install separately: https://github.com/gitleaks/gitleaks
gitleaks detect --source . --verbose
```

High/critical vulnerabilities block CI. Allowlist for known false positives is maintained
inside `security.yml` (pacote, sigstore, undici).

## Turbo task graph

```
build → [^build]  (shared must build before server/web/cli)
test  → [build]
eval  → [build]
typecheck → [^build]
dev   → persistent, no cache
```

Cache outputs: `dist/**` per package. Invalidated by `.env.*local` changes globally.

## Common CI failure remedies

| Failure                               | Fix                                                          |
| ------------------------------------- | ------------------------------------------------------------ |
| `node_modules files are tracked`      | `git ls-files \| grep node_modules \| xargs git rm --cached` |
| `refusing to start without auth`      | Expected — STRICT_AUTH check. No action needed in CI         |
| `Cannot find package X` after install | Free disk space, re-run `scripts/install.sh`                 |
| `bun.lock changed but frozenLockfile` | Run `scripts/install.sh`, commit updated `bun.lock`          |
| Turbo cache miss on PR                | Normal without TURBO_TOKEN; local `.turbo/` still used       |
