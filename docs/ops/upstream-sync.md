# Upstream Sync Strategy

**Problem:** Our fork (`johnnietse/solana-developer-platform`) and the upstream
(`solana-foundation/solana-developer-platform`) have **unrelated git histories**
— different root commit SHAs. This means `git merge` and `git rebase` both fail
with hundreds of `add/add` conflicts on every file.

- Our fork: root `09cfbd18 chore: initial open source snapshot` (273 commits)
- Upstream: root `ec00280b chore: initial open source snapshot` (269 commits)
- Common ancestor: **none**
- Fork is **269 commits behind** upstream

## Options

### Option A: Fresh fork (recommended)

Clone upstream fresh, then selectively apply our changes on top.

```bash
# 1. Clone upstream fresh into a temp directory
cd /tmp
git clone https://github.com/solana-foundation/solana-developer-platform.git sdp-fresh
cd sdp-fresh

# 2. Add our fork as a second remote
git remote add ours https://github.com/johnnietse/solana-developer-platform.git
git fetch ours

# 3. Cherry-pick our meaningful commits on top of upstream/main
git cherry-pick <commit-hash-1> <commit-hash-2> ...
```

**Pros:**
- Clean history on top of latest upstream
- No merge conflicts (cherry-pick each change deliberately)
- Ripcord: upstream merges become trivial going forward

**Cons:**
- Need to identify which of our 273 commits are meaningful vs. redundant
- Force-push required (breaks anyone who cloned from our fork)
- Loses our full commit history

### Option B: Accept divergence (pragmatic)

Keep our fork as-is. Upstream changes that matter are cherry-picked manually.

```bash
# Cherry-pick specific upstream changes we want
git fetch upstream
git cherry-pick <upstream-commit>
```

**Pros:**
- Zero risk, no history rewrite
- Our full commit history preserved
- Can pick specific upstream features/bugfixes as needed

**Cons:**
- Will always be behind upstream
- Can't create upstream PRs from our fork
- Manual tracking of what we've merged

### Option C: Sparse checkout / file-level sync

Treat our repo as independent. Copy specific files/directories from upstream
when we want their latest versions.

```bash
git fetch upstream
git checkout upstream/main -- path/to/specific-file.ts
```

**Pros:**
- Simplest approach
- Full control over what we take
- No git history complexity

**Cons:**
- Most manual
- No git blame continuity for copied files
- Easy to miss things

## Our changes worth keeping

Based on our work so far, our meaningful changes are:

| Area | Files | What changed |
|------|-------|-------------|
| Health-check | `apps/sdp-api/src/routes/health-check.ts` | try/catch around gatherMetrics, removed unused import |
| Docker config | `docker-compose.yml` | Port mapping 5433:5432 (conflict with local PG) |
| Dashboard analytics | `apps/sdp-web/src/app/dashboard/analytics/databricks-dashboard.tsx` | Redesigned card, env-var-driven config, no hardcoded IDs |
| Env templates | `apps/sdp-web/.env.local.example` | Added NEXT_PUBLIC_DATABRICKS_* vars |
| Dev tooling | `start-api.mjs`, `scripts/start-local-dev.mjs`, `scripts/stop-local-dev.mjs` | Local dev scripts |
| Git history | N/A | Removed hardcoded Databricks identifiers from b6c0117 |
| Skil | `.opencode/skills/sdp-local-dev/SKILL.md` | Local dev skill |

## Decision (2026-07-13)

**Adopted: Option B — accept divergence, cherry-pick when needed.**

Upstream is 269 commits ahead but most are unrelated feature branches. If/when we
need specific upstream changes (e.g., a critical bugfix or API change), cherry-pick
them individually. This requires no force-push, preserves our full history, and is
zero-risk.

If we later want to contribute back to upstream, do a fresh fork clone at that
point and cherry-pick our changes on top.

## Security: Secret Scanning

The repo has a **pre-commit secret scanner** to prevent accidental leaks:

- **Hook**: `.githooks/pre-commit` — runs on every `git commit`
- **Scanner**: `scripts/scan-secrets.mjs` — manual: `--all` (working tree), `--history` (git log)
- **Install**: `node scripts/install-secret-scan.mjs`
- **Skill**: `.opencode/skills/secret-scan/SKILL.md`

After any history rewrite (amend, rebase, filter-repo), always run:
```bash
node scripts/scan-secrets.mjs --history
```
Then force-push and rotate any secrets that were exposed.
