# Contributing to Mira

## Branch Naming

| Pattern | Purpose | Example |
|---------|---------|---------|
| `feat/<short-name>` | New feature | `feat/memory-search` |
| `fix/<short-name>` | Bug fix | `fix/session-timeout` |
| `refactor/<short-name>` | Code restructuring | `refactor/tool-registry` |
| `chore/<short-name>` | Tooling/config | `chore/update-deps` |
| `docs/<short-name>` | Documentation | `docs/api-reference` |

## Commit Convention

Mira uses [Conventional Commits](https://www.conventionalcommits.org/). Enforced by commitlint on every commit.

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Types:** `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `chore`, `style`, `revert`, `ci`, `init`

**Scopes:** `server`, `web`, `tui`, `cli`, `shared`, `slack`, `vscode`, `deps`, `ci`, `dx`, `eval`, `gateway`, `memory`, `auth`, `guardrails`, `lsp`, `mcp`

**Examples:**
```
feat(memory): add semantic search retrieval
fix(server): handle concurrent session writes
chore(deps): bump hono to 4.7.0
```

## Development Workflow

```bash
# 1. Create feature branch
git checkout -b feat/my-feature

# 2. Make changes (hooks run automatically on commit)
git add .
git commit -m "feat(server): add new endpoint"

# 3. Push and create PR
git push -u origin feat/my-feature

# 4. CI runs automatically (typecheck → build → test → eval)

# 5. Merge after approval + green CI
```

## Pre-commit Hooks

Installed via Husky. On every `git commit`:

1. **lint-staged** runs Prettier + ESLint on staged files
2. **commitlint** validates commit message format

To bypass (emergency only):
```bash
git commit --no-verify -m "chore: emergency fix"
```

## Pull Requests

1. Fill out the PR template completely
2. Link the issue it fixes
3. Ensure CI is green
4. Get at least 1 approval
5. Squash-merge (keeps main history clean)

## Project Structure

```
mira/
├── packages/
│   ├── server/    — Core engine (Bun + Hono)
│   ├── web/       — SolidJS web client
│   ├── tui/       — SolidJS terminal UI
│   ├── cli/       — CLI tool (npx mira)
│   ├── shared/    — Shared types/utils
│   ├── slack/     — Slack integration
│   └── vscode-mira/ — VS Code extension
├── turbo.json     — Turborepo task config
└── .github/       — CI/CD workflows
```
