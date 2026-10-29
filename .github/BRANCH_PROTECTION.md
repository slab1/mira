# GitHub Branch Protection Configuration for slab1/mira

## Branch Protection Rules for main

Create branch protection via GitHub API or UI.

### Required Checks
- test
- typecheck  
- build
- security
- repo-hygiene
- auth-guard
- ci

### Configuration Steps

#### Via GitHub CLI
```bash
gh api repos/slab1/mira/branches/main/protection -X PUT -f required_status_checks.strict=true -f \
required_status_checks.contexts[]=test -f \
required_status_checks.contexts[]=typecheck -f \
required_status_checks.contexts[]=build -f \
required_status_checks.contexts[]=security -f \
required_status_checks.contexts[]=repo-hygiene -f \
required_status_checks.contexts[]=auth-guard -f \
required_status_checks.contexts[]=ci -f \
-enforce_admins=true -f \
required_pull_request_reviews.dismissal_reviews_too_old=true -f \
required_pull_request_reviews.dismissal_restrictions.users[]=slab1 -f \
required_pull_request_reviews.dismissal_restrictions.teams=[] -f \
required_pull_request_reviews.require_code_owner_reviews=true -f \
required_pull_request_reviews.required_approving_review_count=1 -f \
required_pull_request_reviews.require_last_push_approval=true -f \
restrictions.users[]=slab1 -f \
restrictions.teams=[]
```

#### Via GitHub API
POST /repos/slab1/mira/branches/main/protection
```json
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "test",
      "typecheck",
      "build",
      "security",
      "repo-hygiene",
      "auth-guard",
      "ci"
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismissal_restrictions": {
      "users": ["slab1"],
      "teams": []
    },
    "dismissal_reviews_too_old": true,
    "require_code_owner_reviews": true,
    "require_last_push_approval": true
  },
  "restrictions": {
    "users": ["slab1"],
    "teams": []
  }
}
```

### Ruleset Configuration

Create repository ruleset via:
Settings → Rules → Rulesets → New

**Ruleset Name:** mira-main-protection
**Target:** Branch - branch name pattern = `main`
**Enforcement:** Active

Rules:
1. Require pull request before merging
   - Require approvals: 1
   - Require code owner review: On
   - Dismiss stale approvals: On
   - Require review from Code Owners: On

2. Require status checks to pass before merging
   - Require branches to be up to date: On
   - Status checks:
     * test
     * typecheck
     * build
     * security
     * repo-hygiene
     * auth-guard
     * ci

3. Require signed commits
   - Require signed commits: On

4. Restrict who can push
   - Limit pushes to: slab1

5. Prevent force pushes
   - Allow force pushes: Off
   - Allow deletions: Off

### CODEOWNERS

File: .github/CODEOWNERS
```
# Safety-critical paths
/packages/server/src/evolution/ @slab1
/packages/server/src/shadow/ @slab1
/packages/server/src/security/ @slab1
/packages/server/src/guardrails/ @slab1

# Core engine
/packages/server/src/engines/ @slab1

# Routes
/packages/server/src/routes/evolution.ts @slab1
/packages/server/src/routes/shadow.ts @slab1
```

### Required Environments

Create protected environment `production`:
Settings → Environments → New environment
Name: production
Required reviewers: slab1
Wait timer: 0
Deployment branches: main only

### Secrets Required

For deployment:
- DEPLOY_ENABLED=true
- DEPLOY_HOOK_URL
- DEPLOY_URL  
- DEPLOY_TOKEN (secret)

### Verification

Check current protection:
```bash
gh api repos/slab1/mira/branches/main/protection
```

Check rulesets:
```bash
gh api repos/slab1/mira/rulesets
```

### Remaining Items from docs

Per REMAINING_ITEMS.md 2026-10-13:
- [ ] Implement GitHub admin: add branch protection rules for main
- [ ] Implement GitHub admin: require PR with approval, require checks (test, typecheck, build, security, repo-hygiene, auth-guard)
- [ ] Implement GitHub admin: add repository ruleset for main
- [ ] Add CODEOWNERS for safety-critical paths
- [ ] Configure deployment environment protection with required reviewers
- [ ] Add DEPLOY_ENABLED vars/secrets
