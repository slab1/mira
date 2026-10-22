# ADR-0003: Branch Protection for Main

**Status:** ✅ Accepted  
**Date:** 2026-10-14  
**Author:** Mira Engineering Team  
**Related:** MIRA_EVOLUTION_SPEC.md §5, PR #4

---

## Context

During the initial review of Mira, it was discovered that the **`main` branch has branch protection DISABLED**. This is a critical production safety issue because:

1. **Self-Modifying Code:** Mira contains autonomous self-improvement capabilities that can modify its own code
2. **No Review Gate:** Without branch protection, autonomous changes could be pushed directly to main
3. **No CI Requirement:** Tests and checks could be bypassed
4. **No Human Approval:** High-risk changes could reach production without human review
5. **Documentation Requirement:** `MIRA_EVOLUTION_SPEC.md` §5 explicitly requires protected release paths

### The Problem

GitHub branch protection was disabled, which means:

- Direct pushes to `main` are allowed
- Pull requests are not required
- Status checks are not enforced
- Code owners are not required to review
- No restrictions on who can push

This creates a **critical safety gap** for an autonomous self-improvement system.

### Safety Implications

Without branch protection:

- **Unauthorized Changes:** Malicious or buggy code could reach production
- **Bypassing Governance:** Autonomous changes could bypass the governance pipeline
- **No Audit Trail:** Hard to track who made changes and why
- **No Quality Gate:** Tests could be skipped
- **Violation of Spec:** Explicitly contradicts `MIRA_EVOLUTION_SPEC.md`

---

## Decision

**Enable comprehensive branch protection on the `main` branch with the following rules:**

### 1. Required Status Checks

- ✅ **All CI tests must pass** before merge
- ✅ **Type checking** (`tsc --noEmit`) must pass
- ✅ **Linting** must pass
- ✅ **Build** must succeed
- ✅ **Security scanning** must pass (if configured)

### 2. Required Pull Requests

- ✅ **Pull requests required** for all changes to `main`
- ✅ **No direct pushes** allowed (even for admins)
- ✅ **No force pushes** allowed

### 3. Required Reviews

- ✅ **At least 1 human approval** for all changes
- ✅ **Code owners** automatically requested for review
- ✅ **Minimum 1 reviewer** (configurable per repo size)

### 4. Additional Protections

- ✅ **Require signed commits** (GPG verification)
- ✅ **Require linear history** (no merge commits)
- ✅ **Require up-to-date branches** before merge
- ✅ **Require resolution of all conversations**
- ✅ **Include administrators** in protection rules

### 5. Deployment Safety

- ✅ **Require deployment to staging** before production
- ✅ **Require manual approval** for production deployment
- ✅ **Block self-approval** (cannot approve own PRs)

---

## Implementation

### Configuration File: `.github/branch_protection.json`

```json
{
  "branch": "main",
  "required_status_checks": {
    "strict": true,
    "contexts": ["ci", "build", "lint", "typecheck", "test", "security"]
  },
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": true,
    "required_approving_review_count": 1
  },
  "restrictions": {
    "users": [],
    "teams": [],
    "apps": []
  },
  "enforce_admins": true,
  "require_signed_commits": true,
  "require_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true,
  "require_up_to_date_before_merge": true
}
```

### Verification Workflow: `.github/workflows/branch-protection.yml`

```yaml
name: Branch Protection Verification

on:
  schedule:
    - cron: '0 0 * * *' # Daily at midnight UTC
  workflow_dispatch:

jobs:
  verify-branch-protection:
    runs-on: ubuntu-latest
    steps:
      - name: Check branch protection
        uses: actions/github-script@v6
        with:
          script: |
            const { data: branch } = await github.rest.repos.getBranch({
              owner: context.repo.owner,
              repo: context.repo.repo,
              branch: 'main'
            })

            if (!branch.protected) {
              core.setFailed('main branch is NOT protected!')
            }

            const protection = branch.protection

            // Verify required checks
            if (!protection?.required_status_checks) {
              core.setFailed('Required status checks not configured')
            }

            // Verify PR requirements
            if (!protection?.required_pull_request_reviews) {
              core.setFailed('Required PR reviews not configured')
            }

            // Verify admin enforcement
            if (!protection?.enforce_admins) {
              core.setFailed('Admin enforcement not enabled')
            }

            console.log('✅ Branch protection verified')
```

### API-Based Configuration

For programmatic configuration verification:

```typescript
// packages/server/src/github/branch-protection.ts
export async function verifyBranchProtection(
  owner: string,
  repo: string,
  branch: string = 'main',
): Promise<BranchProtectionStatus> {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/branches/${branch}`, {
    headers: {
      Authorization: `token ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
    },
  })

  const data = await response.json()

  return {
    protected: data.protection?.enabled ?? false,
    requiredChecks: data.protection?.required_status_checks?.contexts ?? [],
    requiredReviews:
      data.protection?.required_pull_request_reviews?.required_approving_review_count ?? 0,
    enforceAdmins: data.protection?.enforce_admins ?? false,
    requireSignedCommits: data.protection?.require_signed_commits ?? false,
    allowForcePushes: data.protection?.allow_force_pushes ?? true,
  }
}
```

---

## Consequences

### Positive

1. **Safety:** No unauthorized changes can reach main
2. **Audit Trail:** All changes go through PR with review
3. **Quality Gate:** CI must pass before merge
4. **Compliance:** Meets `MIRA_EVOLUTION_SPEC.md` §5 requirements
5. **Team Collaboration:** Forces code review culture

### Negative

1. **Development Friction:** Extra steps to merge changes
2. **Emergency Fixes:** Cannot push hotfixes directly to main
3. **Admin Override:** Admins can still force-push (but we enforce admin protection)

### Trade-offs

We accepted **development friction** and **emergency fix limitations** in exchange for **production safety**. This is the correct choice because:

1. Safety > Convenience for autonomous systems
2. Emergency fixes can use a separate `hotfix` branch with its own protection
3. The friction encourages better testing and review practices

---

## Emergency Procedures

### Hotfix Process

1. Create branch from `main`: `git checkout -b hotfix/description`
2. Make minimal changes to fix the issue
3. Push to `hotfix/description`
4. Create PR to `main` with **1+ human approvals**
5. After approval, merge to `main`

### Break Glass Procedure

If branch protection must be temporarily disabled:

1. **Require 2+ admin approvals** (via Slack/email)
2. **Set time limit** (e.g., 1 hour max)
3. **Document reason** in incident report
4. **Re-enable immediately** after fix
5. **Audit all changes** made during the window

---

## Verification

### Manual Verification

```bash
# Check branch protection via GitHub API
curl -H "Authorization: token YOUR_TOKEN" \
  https://api.github.com/repos/slab1/mira/branches/main

# Check if protected field is true
```

### Automated Verification

```bash
# Run branch protection verification workflow
gh workflow run branch-protection.yml
```

### Expected Output

```json
{
  "protected": true,
  "requiredChecks": ["ci", "build", "lint", "typecheck", "test"],
  "requiredReviews": 1,
  "enforceAdmins": true,
  "requireSignedCommits": true,
  "allowForcePushes": false
}
```

---

## Related Decisions

- [ADR-0001: Governance Gates Must Fail Closed](../adr/0001-governance-fail-closed.md) - Foundational safety
- [ADR-0002: Memory Provenance on ALL Memories](../adr/0002-memory-provenance.md) - Knowledge safety
- [ADR-0004: Durable Budget Accounting](../adr/0004-durable-budget.md) - Cost control
- [ADR-0005: Complete Rollback System](../adr/0005-complete-rollback.md) - Recovery guarantee

---

## Amendments

None. This decision is foundational and should not be changed without a full safety review.

---

## Supersedes

- The disabled branch protection state on `main`
- Any previous policy allowing direct pushes to `main`
