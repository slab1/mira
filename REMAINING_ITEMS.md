# Remaining Items After P0/P1 Fixes

**Date:** 2026-10-13
**Status:** Codebase ready for controlled engineering tests; infrastructure items pending

---

## Items Requiring GitHub Admin Access

### 1. Branch Protection for `main` (P0)

**Cross-check finding:** GitHub reports `protected: false`, rulesets endpoint returns `[]`

**Required configuration:**

- Protect `main` branch with:
  - Pull requests required (no direct pushes)
  - Required CI checks: `test`, `typecheck`, `build`, `security`, `repo-hygiene`, `auth-guard`
  - Required security checks: CodeQL, dependency audit, secrets scan
  - Required review: at least 1 approving reviewer
  - CODEOWNERS review for safety-critical paths (`**/guardrails/**`, `**/approval/**`, `**/sandbox/**`, `**/evolution/**`)
  - Dismiss stale approvals on new commits
  - Require conversation resolution
  - Restrict force-push and branch deletion
  - Restrict bypass permissions

**How to configure:**

1. Go to Repository Settings → Branches → Branch protection rules
2. Or use Repository Rulesets (recommended): Settings → Rules → Rulesets
3. Apply to `main` branch with the above requirements

**Verification:**

```bash
gh api repos/slab1/mira/branches/main/protection
# Should return protected: true with required checks listed
```

---

### 2. Repository Rulesets (P0)

**Cross-check finding:** Rulesets endpoint returned empty list

**Required:** Create a ruleset that enforces the same protections as branch protection, plus:

- Required status checks from CI workflow
- Required workflows (CI must pass)
- Optional: additional security owner review for high-risk paths

---

## Items Requiring Deploy Infrastructure

### 3. Enable Production Deployment (P1)

**Current state:** CD deploy job skipped because `vars.DEPLOY_ENABLED != 'true'`

**Required GitHub repository variables (Settings → Secrets and variables → Actions):**

| Variable          | Description                           | Example                              |
| ----------------- | ------------------------------------- | ------------------------------------ |
| `DEPLOY_ENABLED`  | Set to `'true'` to enable deploy      | `true`                               |
| `DEPLOY_HOOK_URL` | Webhook endpoint for deployment       | `https://deploy.example.com/webhook` |
| `DEPLOY_URL`      | Base URL for post-deploy health check | `https://api.example.com`            |

**Required GitHub repository secrets:**

| Secret         | Description                                    |
| -------------- | ---------------------------------------------- |
| `DEPLOY_TOKEN` | Bearer token for deploy webhook authentication |

**Once configured:**

- Deploy job will run on push to `main`
- Health check becomes a **hard gate** (fails deployment if `/health` doesn't return `ok`)
- Deployed SHA recorded as workflow output for audit trail

---

### 4. Configure Health Endpoint

**Required:** Production deployment must expose `/health` endpoint that returns `ok`

The server already has `GET /health` via `mountHealthRoutes`. Ensure the deployed instance:

- Is accessible at `DEPLOY_URL`
- Returns `{"ok": true, ...}` or contains `"ok"` in response body
- Responds within 10 seconds (health check retries 5x with 10s intervals)

---

## Items Already Implemented in Code (Verified)

All P0 and P1 code changes from the cross-check review are **complete and tested**:

| Item                                   | Status                | Evidence                                                                 |
| -------------------------------------- | --------------------- | ------------------------------------------------------------------------ |
| Approval route false-verified fix      | ✅ Runtime-integrated | `evolution.ts:1295-1350`                                                 |
| Self-approval protection (`createdBy`) | ✅ Runtime-integrated | `proposal.ts:51,138,152`, `approval.ts:155-164`                          |
| Candidate governance wiring            | ✅ Runtime-integrated | `learning/index.ts:133-170`, `canary.ts`, `measurement.ts`, `variant.ts` |
| Rollback verification                  | ✅ Runtime-integrated | `rollback.ts`, `evolution.ts:1495-1660`                                  |
| Mission budget enforcement             | ✅ Runtime-integrated | `orchestrate.ts`, `mission-budget.ts`                                    |
| Budget reservations lifecycle          | ✅ Runtime-integrated | `evolution.ts:672,1612-1656`, `resources.ts`                             |
| Sandbox profiles (fail-closed)         | ✅ Implemented        | `isolation.ts` defaults to `isolated-experiment`                         |
| CD health check hard gate              | ✅ Implemented        | `.github/workflows/cd.yml`                                               |
| Deployed SHA recording                 | ✅ Implemented        | `.github/workflows/cd.yml` outputs                                       |
| Documentation freshness                | ✅ Updated            | `LONG_TERM_RISK_AND_SCALABILITY_PLAN.md:16`                              |

**All 1,665 tests pass. Typecheck clean across 7 packages.**

---

## Recommended Next Steps

1. **Immediate:** Configure branch protection/rulesets (GitHub admin)
2. **Immediate:** Set deploy variables/secrets if production deployment is intended
3. **Then:** Run controlled engineering tests per cross-check recommendation
4. **Before production:** Execute load/failure/recovery tests, verify deployed SHA + health

---

## Verification Commands

```bash
# Verify branch protection
gh api repos/slab1/mira/branches/main/protection

# Verify rulesets
gh api repos/slab1/mira/rulesets

# Verify deploy variables (will show *** for secrets)
gh variable list --repo slab1/mira
gh secret list --repo slab1/mira

# Run full test suite
cd /workspaces/mira && bun test

# Run typecheck
cd /workspaces/mira && bun run typecheck
```
