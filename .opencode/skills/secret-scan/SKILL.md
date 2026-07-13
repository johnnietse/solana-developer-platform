---
name: secret-scan
description: Secret scanning and prevention for the SDP repo. Use before committing, when reviewing PRs, or when investigating potential leaks. Scans staged files, working tree, and git history for accidentally committed secrets (Clerk keys, API tokens, private keys, passwords).
---

# Secret Scanning

## Overview

The SDP repo has a secret scanning system that prevents accidentally committing secrets:

1. **Pre-commit hook** — blocks commits containing secrets
2. **`scripts/scan-secrets.mjs`** — manual scanning tool
3. **`scripts/install-secret-scan.mjs`** — installs the hook

## Quick Start

The hook is already installed (`.githooks/pre-commit`). It runs automatically on `git commit`.

To verify it's active:
```bash
git config core.hooksPath
# Should output: .githooks
```

## Manual Scanning

```bash
# Scan all staged files (same as pre-commit)
node scripts/scan-secrets.mjs

# Scan all tracked files
node scripts/scan-secrets.mjs --all

# Scan git history
node scripts/scan-secrets.mjs --history

# Check GitHub for secret scanning alerts
node scripts/scan-secrets.mjs --github
```

## What's Scanned

| Pattern | Example |
|---------|---------|
| Clerk secret keys | `sk_test_...`, `sk_live_...` |
| Clerk publishable keys | `pk_test_...`, `pk_live_...` |
| Clerk webhook secrets | `whsec_...` |
| GitHub tokens | `ghp_...`, `gho_...`, `ghu_...`, `ghs_...` |
| AWS access keys | `AKIA...` |
| Private keys | `-----BEGIN RSA/EC/PRIVATE KEY-----` |
| Databricks tokens | `dapi...` |
| Slack tokens | `xoxb-...`, `xoxp-...` |
| JWT tokens | `eyJ...` |

## If a Secret Is Found

**If the hook blocks your commit:**
```bash
# 1. Unstage the file
git restore --staged <file>

# 2. Remove the secret value, replace with placeholder
#    (e.g., "sk_test_your_clerk_secret_key")

# 3. Re-stage and commit
git add <file>
git commit
```

**If a secret was already committed:**
```bash
# 1. Fix the file content
# 2. Amend the commit (if last commit)
git add <file>
git commit --amend

# 3. Or use interactive rebase for older commits
git rebase -i <commit-before-the-leak>
# Change 'pick' to 'edit' for the leaky commit
# Fix the file, git add, git rebase --continue

# 4. Force push after history rewrite
git push --force-with-lease
```

**Important:** After fixing history, rotate the leaked secret immediately (regenerate the key/token).

## False Positives

The scanner excludes:
- Test files (`*.test.ts`, `*.spec.ts`, `*.fixture.*`)
- Example files (`*.example`)
- Commented-out examples
- PEM formatting utilities

If you encounter a false positive, add an exclusion pattern to `scripts/scan-secrets.mjs`.
