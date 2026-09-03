# Bun Store Fallback — pnpm Workspaces (Install Only)

> **Context:** Bun store on proot/aarch64 (Termux) can EPERM/skeletonize with `symlink` backend.
> Fix 2 sets `bunfig.toml` to `backend = "copy"` (most resilient) and pins `bun@1.3.14`.
> If `bun install --backend=copy` still EPERMs, use pnpm for **install only** — keep Bun runtime for server.

## Primary (current)

- `bunfig.toml`:
  ```toml
  [install]
  backend = "copy"
  exact = false

  [install.cache]
  disable = false
  ```
- `packageManager: bun@1.3.14`
- `Dockerfile: FROM oven/bun:1.4` (or 1.3.14) — runtime stays Bun
- `turbo.json` unchanged (works with pnpm or bun)

Verify:
```bash
cat bunfig.toml
cat package.json | grep packageManager
bun install --backend=copy   # or --backend=hardlink as middle ground
```

## Fallback: pnpm workspaces (1-hour migration, install only)

Keep Bun runtime (`bun run`, `bun build`, `bun --watch`) — only swap the installer.

1. Convert workspaces:
   ```bash
   # create pnpm-workspace.yaml from package.json workspaces
   cat > pnpm-workspace.yaml <<'YAML'
   packages:
     - "packages/*"
   YAML
   ```

2. Generate lockfile:
   ```bash
   pnpm import  # or pnpm install (creates pnpm-lock.yaml from package.json)
   # keep bun.lock for reference, but pnpm-lock.yaml becomes source of truth for CI
   ```

3. Keep `turbo.json` as is — Turbo is package-manager agnostic.

4. Update CI/Dockerfile install step:
   ```dockerfile
   # before
   RUN bun install --frozen-lockfile
   # fallback
   RUN pnpm install --frozen-lockfile
   ```

5. Keep `packageManager` as `pnpm@9.x` if fully switched, or keep `bun@1.3.14` and use pnpm only for install (document in README).

6. Verify:
   ```bash
   pnpm install
   pnpm turbo run build --continue --filter=@mira/server --filter=@mira/shared --filter=@mira/web
   bun --watch packages/server/src/index.ts  # runtime still Bun
   ```

## Decision Tree

- `bun install --backend=copy` works → stay on Bun (simplest, no migration)
- `copy` still EPERMs → try `backend = "hardlink"` (faster than copy, still resilient)
- `hardlink` also fails → pnpm fallback above (1 hour, reversible — just delete `pnpm-workspace.yaml` + `pnpm-lock.yaml` and `bun install` again)
