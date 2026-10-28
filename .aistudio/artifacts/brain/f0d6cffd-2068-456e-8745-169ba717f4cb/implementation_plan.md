# Mira Engine & Platform — Dev Server Fix & Production Readiness Plan

Immediate priority fix for the Mira dev server startup failure, followed by a full-stack production audit and deployment roadmap for containerized Cloud Run / Kubernetes deployment with Cloud SQL.

> [!IMPORTANT] Priority 1: Dev Server & Workspace Resolution Fix
> - **Immediate Blocker**: Turborepo fails to start with `Could not resolve workspace. Missing devEngines.packageManager or legacy packageManager field in package.json`.
> - **Resolution**: Add `"packageManager": "npm@10.8.2"` to root `package.json` and verify `npm run dev` workspace filters.
> - **Verification**: Run `compile_applet` to confirm the dev server builds and serves on port 3000 without errors.

---

## 1. Overview & Core Concept

Mira is a multi-agent autonomous engineering platform built as a monorepo (`packages/server`, `packages/web`, `packages/tui`, `packages/cli`, `packages/shared`, `packages/slack`, `packages/vscode-mira`). 

To resolve the dev server failure and prepare Mira for production deployment:

1. **Dev Server Fix**: Configure root `package.json` packageManager and workspace scripts so `turbo dev` / `npm run dev` starts the server and web frontend correctly on port 3000.
2. **Build Verification**: Run `compile_applet` to ensure typescript compilation, bundle resolution, and HMR server proxying succeed.
3. **Production Audit**: Provide targeted recommendations for Cloud SQL database persistence, multi-agent concurrency, Hono security middleware, and containerized deployment.

---

## 2. User Experience & Visual Design (SaaS Dashboard & Dev Status)

- **Layout Structure**: 240px collapsible sidebar + top bar header with contextual breadcrumbs, connection status (`LIVE // PORT 3000`), and model selector.
- **Visual Identity**:
  - *Palette*: Dark slate canvas (`#09090b`), surface background (`#15151a`), hairline border (`#232329`), violet brand accent (`#8b5cf6`), Emerald for live stream (`#34d399`).
  - *Typography*: Display sans (`Plus Jakarta Sans`) paired with monospace tabular figures (`JetBrains Mono` / `tabular-nums`) for latency, tokens, and execution steps.

---

## 3. Key Product Decisions & Trade-Offs

### Decision 1: Root `packageManager` Declaration
- **Chosen Approach**: Add `"packageManager": "npm@10.8.2"` to root `package.json`.
- **Why**: Turborepo v2 requires explicit packageManager declaration to resolve monorepo workspace packages properly.

### Decision 2: Monorepo Port & Proxy Alignment
- **Chosen Approach**: Ensure `@mira/web` Vite dev server serves on port 3000 (`0.0.0.0:3000`) and proxies API routes to `@mira/server`.
- **Why**: Satisfies AI Studio environment constraint requiring the main web app to listen on port 3000.

---

## 4. Technical Architecture & Implementation Steps

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             ROOT PACKAGE.JSON                               │
│                   "packageManager": "npm@10.8.2"                            │
│                     "dev": "turbo dev --continue"                           │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                      ┌────────────────┴────────────────┐
                      ▼                                 ▼
         ┌─────────────────────────┐       ┌─────────────────────────┐
         │     @mira/web (Vite)    │       │   @mira/server (Hono)   │
         │   Host: 0.0.0.0:3000    │◄──────┤    Port: 4096 (Local)    │
         └─────────────────────────┘ Proxy └─────────────────────────┘
```

### Action Plan:

1. **Step 1: Fix Root `package.json`**
   - Add `"packageManager": "npm@10.8.2"` to `package.json`.
   - Check script definitions for `dev` and workspace packages.

2. **Step 2: Verify Monorepo Build & Dev Server**
   - Execute `compile_applet` to verify compilation and dev server start.
   - Address any TypeScript or package resolution issues if found.

3. **Step 3: Comprehensive Production Codebase Audit**
   - Perform production audit for Cloud SQL integration, security guardrails, and container deployment.
