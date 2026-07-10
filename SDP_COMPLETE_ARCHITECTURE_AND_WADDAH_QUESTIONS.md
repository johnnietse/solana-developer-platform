# Solana Developer Platform (SDP) — Complete Architecture & Waddah Questions

**Repository:** `C:\Users\Johnnie\Documents\MLH_Fellowship_2026\solana-developer-platform\solana-developer-platform`  
**Branch:** `main` (HEAD: `67e2403 feat(analytics): dynamic token registry with hybrid resolution & reverification`)  
**Status:** Pre-mainnet, enterprise-grade Solana development platform with wallets, token issuance, payments, compliance, analytics, and a hosted dashboard.

---

## PART 1 — WHAT'S IMPLEMENTED (THE ENTIRE PLATFORM)

### 1.1 Core Applications

| App | Tech | Port | Purpose |
|-----|------|------|---------|
| **sdp-api** | Hono (Cloudflare Workers + Node) | 8787 | Backend API: wallets, issuance, payments, compliance, analytics, api-keys, webhooks, rpc, projects, organizations, members, onboarding, places, allowlist |
| **sdp-web** | Next.js 16 (App Router) + Clerk | 3000 | Dashboard: wallets/custody, issuance, analytics, payments, counterparty, api-keys, settings, allowlist, members |
| **sdp-docs** | Next.js 16 + Fumadocs | 3001 | Public docs site, API reference, AI discovery (llms.txt), Postman collection |

### 1.2 Shared Packages (`packages/*`)

| Package | Purpose | Key Exports |
|---------|---------|-------------|
| `@sdp/types` | Shared runtime types + product constants | `organizations`, `counterparties`, `custody`, `api-keys`, `payments`, `site` (canonical URLs), `permissions`, `policy`, `custody` capabilities |
| `@sdp/rpc` | RPC client abstraction | `getSolanaConfig`, `resolveDefaultSolanaRpcUrl`, `SolanaConfig`, `SdpRpcError` |
| `@sdp/solana` | Solana helpers + Token-2022 service | `Token2022Service`, amount math, address helpers, Mosaic SDK integration |
| `@sdp/env-config` | Self-hosted environment configurator | Field catalog, `.env` generation, secret generation |
| `@sdp/custody` | Custody provider signing adapters | `SigningPort`, provider keychains (Fireblocks, Privy, CDP, Para, Turnkey, DFNS, Haven, Anchorage, Utila) |
| `@sdp/payments` | Fee payment + fiat ramp clients | `FeePaymentPort` (native/Kora), ramp clients (BVNK, Coinbase, Lightspark, MoneyGram, MoonPay) |
| `@sdp/api-integration` | Integration test harness | Vitest + Workers pool + Surfpool for Kora/Solana |

### 1.3 Infrastructure & Deployment

| Component | Details |
|-----------|---------|
| **Local Dev** | `pnpm install` → `.dev.vars` → `pnpm db:postgres:up` → `pnpm dev` (API:8787, Web:3000, Docs:3001) |
| **Docker Compose** | Root `docker-compose.yml` (postgres, redis, sdp-api, sdp-web, sdp-docs); `infra/self-hosted/compose.yml` for prebuilt images |
| **Self-Hosted** | `infra/self-hosted/install.sh` (cosign-verified), `configure.js` configurator, prebuilt `ghcr.io/solana-foundation/sdp/*` images |
| **CI/CD** | GitHub Actions: `ci.yml`, `release-please.yml`, `release-images.yml`, `deploy-sdp-api.yml`, `self-hosted-smoke.yml`, `ramp-rails-refresh.yml` |
| **Database** | Postgres (Docker), migrations in `apps/sdp-api/src/db/migrations/postgres/` (up to `0025_analytics_tokens_ingestion_columns.sql`), `schema_migrations` tracking |
| **Secrets** | Doppler for dev, `scripts/secret-keys.mjs` for committed worker var keys, `scripts/render-wrangler-config.mjs` for deploy |

---

## PART 2 — COMPLETE ARCHITECTURE & HOW EVERYTHING LINKS

### 2.1 System Overview Diagram (Textual)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            BROWSER (User)                                   │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  sdp-web (Next.js 16, Clerk Auth)                                   │   │
│  │  • Server Components → direct fetch to sdp-api                      │   │
│  │  • Client Components → /api/dashboard/* proxies → sdp-api           │   │
│  │  • Clerk JWT (template: sdp-api) → Authorization: Bearer <jwt>      │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  sdp-api (Hono on Cloudflare Workers / Node)                        │   │
│  │  • Global middleware: requestId → tracing → secureHeaders → CORS    │   │
│  │    → kvStore → rateLimit (skips KV_FREE_PATHS)                      │   │
│  │  • v1 group: unifiedAuthMiddleware({allowClerk, allowSession})      │   │
│  │    → projectContextMiddleware → requirePermissions(...)             │   │
│  │  • Route groups: wallets, issuance, payments, compliance,           │   │
│  │    data-products, counterparties, organizations, api-keys,          │   │
│  │    webhooks, rpc, projects, members, onboarding, places, auth       │   │
│  │  • Background: node-cron (Node) / scheduled (CF) for ingestion,     │   │
│  │    reconciliation, wallet enrichment, token discovery, retirement   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│           │                    │                    │                      │
│           ▼                    ▼                    ▼                      │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                │
│  │   Postgres   │    │    Redis     │    │  Databricks  │                │
│  │  (sdp-postgres│    │  (sdp-redis) │    │  (workspace  │                │
│  │   :5433)     │    │  :6379)      │    │  .default)   │                │
│  └──────────────┘    └──────────────┘    └──────────────┘                │
│           │                    │                    │                      │
│           ▼                    ▼                    ▼                      │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  EXTERNAL SERVICES                                                  │   │
│  │  • Clerk (auth, orgs, JWTs, webhooks via Svix relay)               │   │
│  │  • Solana RPC (devnet/mainnet via Helius/QuickNode/Triton/Alchemy) │   │
│  │  • Custody providers: Fireblocks, Privy, CDP, Para, Turnkey,       │   │
│  │    DFNS, Haven, Anchorage, Utila, Local                            │   │
│  │  • Compliance: TRM Labs, Chainalysis                               │   │
│  │  • Fiat ramps: MoonPay, BVNK, Coinbase, Lightspark, MoneyGram      │   │
│  │  • Fee payment: Native (local) / Kora                              │   │
│  │  • Sentry, Resend, Google Places, Kora, Svix                       │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Request Flow (Authenticated)

```
Browser (Clerk session)
    │
    ▼
sdp-web Server Component (e.g., /dashboard/analytics/page.tsx)
    │ auth() → {userId, getToken}
    │ getToken({template: "sdp-api"}) → Clerk JWT with org_id claim
    ▼
fetch(http://127.0.0.1:8787/v1/data-products/user-analytics, {
  headers: { Authorization: `Bearer ${clerkToken}` }
})
    │
    ▼
sdp-api (Hono)
    │ unifiedAuthMiddleware({allowClerk:true, allowSession:true})
    │   → extractApiKey (returns null for JWT)
    │   → extractBearerToken → looksLikeJwt → allowClerk=true
    │   → clerkAuthMiddleware()
    │       → verifyClerkJwtForRequest (jose + Clerk JWKS)
    │       → buildClerkContext
    │           → resolveClerkOrganization (Clerk org_id → SDP org_id via auth_organization_identities)
    │           → ensureClerkUser / ensureMembership
    │       → c.set("clerk", {organizationId: SDP_ORG_ID, ...})
    │ projectContextMiddleware() → c.set("projectId")
    ▼
Route handler (user-analytics.ts)
    │ orgId = c.get("clerk")?.organizationId
    │ SELECT * FROM issued_tokens WHERE organization_id = ?
    │ For each token: RPC getTokenSupply + getHolderCount (devnet)
    ▼
Response: { data: { tokens: [...], summary: {...} }, meta: {...} }
```

### 2.3 Auth Resolution Chain (Critical)

```
Request Authorization Header
    │
    ├─► extractApiKey() → "sk_test_..." → authMiddleware() → c.set("apiKey", {...})
    │
    ├─► Bearer JWT (3 dots) → looksLikeJwt=true
    │     └─► unifiedAuthMiddleware({allowClerk:true})
    │           └─► clerkAuthMiddleware()
    │                 └─► verifyClerkJwtForRequest (jose + Clerk JWKS)
    │                       └─► buildClerkContext
    │                             ├─► resolveExistingClerkContext (auth_organization_identities + auth_user_identities + organization_members)
    │                             │     → organization_id (SDP internal), user_id, role, permissions
    │                             └─► OR ensureClerkUser + resolveClerkOrganization + ensureMembership
    │                                   → organization_id (SDP internal)
    │                             └─► c.set("clerk", {organizationId: SDP_ORG_ID, ...})
    │
    └─► Session cookie (sdp_session) → sessionAuthMiddleware → c.set("session", {...})

Route handler reads: orgId = apiKey?.organizationId ?? session?.organizationId ?? clerk?.organizationId
```

### 2.4 Analytics Ingestion Pipeline (Cron, Every 5 Min)

```
node-cron (runner.ts: "*/5 * * * *")
    │
    ▼
handleAnalyticsIngestion(env)
    │
    ├─► resolveAnalyticsMints(env)
    │     ├─► ENV: ANALYTICS_MINTS (comma-separated)
    │     ├─► DB: analytics_tokens WHERE is_active=true (priority DESC)
    │     ├─► USER: issued_tokens WHERE status='deployed'
    │     └─► DISCOVERY: external (Jupiter, etc.)
    │
    ├─► For each mint:
    │     ├─► RPC getTokenSupply (devnet)
    │     ├─► RPC getProgramAccounts (token accounts for mint)
    │     ├─► Databricks INSERT token_supply_snapshots
    │     ├─► Databricks INSERT token_holders (batched 100)
    │     ├─► Databricks INSERT wallet_labels (geography/attribution)
    │     ├─► Databricks INSERT analytics_cache (computed JSON)
    │     └─► Postgres UPDATE analytics_tokens (last_ingestion_status, holder_count, supply, etc.)
    │
    └─► Returns { results: [{mint, success}], timestamp }
```

### 2.5 Token Issuance Flow (SPL Token-2022 via Mosaic)

```
User: POST /v1/issuance/tokens (create token record)
    │ status=pending, template=stablecoin|arcade|tokenized-security|custom
    ▼
User: POST /v1/issuance/tokens/{tokenId}/deploy
    │
    ├─► Custodial: server signs (createOrgSigner)
    │     mosaic.createToken → mint keypair + init tx
    │     Optional: ABL list (allowlist/blocklist) via getListConfigPda
    │     → setTokenDeployed (mint_address, authorities, status=active)
    │     → registerUserToken (analytics_tokens source_user_deployment=true)
    │
    ├─► Non-custodial: prepareDeploy → unsigned tx for client
    │     Client signs → confirmDeploy → verify signature + mint exists
    │
    └─► Transaction recorded in issuance_transactions
```

### 2.6 Custody Provider Model

```
SIGNING_PROVIDER (env) → createSigningAdapter(orgId, projectId)
    │
    ├─► local → KeychainMemoryAdapter (CUSTODY_PRIVATE_KEY, in-memory Ed25519)
    │     • Only provider supporting generateKeypair() for ephemeral mint keypairs
    │     • supportsAdditionalWalletCreation: FALSE (1 custody wallet by design)
    │
    ├─► fireblocks → KeychainFireblocksAdapter (POST /v1/vault/accounts)
    ├─► privy → KeychainPrivyAdapter (POST /wallets)
    ├─► coinbase_cdp → KeychainCdpAdapter (POST /v2/solana/accounts)
    ├─► para → KeychainParaAdapter (POST /v1/wallets, SOLANA/ED25519)
    ├─► turnkey → KeychainTurnkeyAdapter (create_private_keys v2)
    ├─► dfns / ibm_haven → KeychainDfnsAdapter (Dfns WaaS API)
    ├─► utila → KeychainUtilaAdapter (service-account JWT + POST /v2/vaults/{vault}/wallets)
    └─► anchorage → KeychainAnchorageAdapter (custody-only, NO signing)
```

**Capability Matrix** (`packages/sdp-types/src/custody.ts`):
- `supportsSigning`: all except `anchorage`
- `supportsAdditionalWalletCreation`: all except `local`
- `supportsWalletDeletion`: only `anchorage`

### 2.7 Payments & Fiat Ramps

```
POST /v1/payments/transfers (create transfer)
    │
    ├─► Fee payment: native (local SOL) or Kora
    ├─► Ramp providers (onramp/offramp):
    │     • MoonPay, BVNK, Coinbase, Lightspark, MoneyGram
    │     • Estimate → Quote → Simulate (sandbox) → Execute
    │
    ├─► Recurring payments (feature-flagged):
    │     • cron/recurring-payments.ts (every 5 min)
    │     • collectDueRecurringPayments → create transfers
    │
    └─► Counterparty screening (TRM/Chainalysis) before execution
```

### 2.8 Compliance Screening

```
POST /v1/compliance/address-screenings
    │
    ├─► TRM Labs (if TRM_API_KEY configured)
    └─► Chainalysis (if CHAINALYSIS_API_KEY configured)
    │
    └─► Returns risk score, flags, recommendation
    │
    └─► Paid accounts required for production; local dev = "Add it anyway?" click-through
```

---

## PART 3 — WHAT WE CHANGED IN THIS ENGAGEMENT (LOCAL DEV FIXES)

| # | File | Change | Root Cause |
|---|------|--------|------------|
| 1 | `apps/sdp-api/src/lib/runtime-env.ts` | Added `ANALYTICS_ENABLED`, `ANALYTICS_MINTS`, `ANALYTICS_RPC_URL` to `PROCESS_ENV_FALLBACK_KEYS` | `withProcessEnvFallback()` whitelist didn't include analytics vars → cron saw `undefined` → "Analytics ingestion disabled" |
| 2 | `apps/sdp-api/src/db/migrations/postgres/0025_analytics_tokens_ingestion_columns.sql` (NEW) | `ADD COLUMN IF NOT EXISTS` for 6 ingestion columns; deactivated 4 mainnet mints; activated our devnet USDC mint | Migration `0024` created `analytics_tokens` without ingestion columns; `updateTokenVerification()` writes them → crash |
| 3 | `apps/sdp-api/.dev.vars` | Added `ANALYTICS_MINTS=9fxDZ7rBCNdHureibbAVa6J73srhCYWoKYZWwegXe72Z` | Explicitly scope local ingestion to our devnet USDC mint |
| 4 | `apps/sdp-api/src/lib/databricks-query.ts` | Rewrite `:N` → `:pN` placeholders; add `name` to params | Databricks SQL only supports named `:name` params; `:1` positional failed silently (returned `null` instead of throwing) |
| 5 | `apps/sdp-web/src/app/dashboard/analytics/page.tsx` | Forward Clerk JWT via `getToken({template:"sdp-api"})` as Bearer header | Web fetched `/v1/data-products/user-analytics` with no auth → 401 |
| 6 | `apps/sdp-api/src/routes/data-products/user-analytics.ts` | Applied `unifiedAuthMiddleware({allowClerk:true, allowSession:true})` | Data-products routes had NO auth middleware → `c.get("clerk")` always undefined → 401 |

**Operational fixes:** Killed 7 stale API processes, restarted single clean instance, ran migration `0025`, manually triggered ingestion, verified endpoints.

---

## PART 4 — CURRENT STATE & KNOWN GAPS

| Area | Status | Notes |
|------|--------|-------|
| **Auth (Clerk ↔ SDP org)** | ✅ Working | Clerk org `org_3Fjuo...` → SDP org `org_c386fee9...` via `auth_organization_identities` |
| **Project access** | ✅ Working | User is admin on Default Sandbox + Default Production |
| **Custody wallet** | ✅ Working | `F1CEcVA7...` funded with devnet SOL |
| **USDC token deployed** | ✅ Working | `tok_209170fe`, mint `9fxDZ7r...`, status `active` |
| **Full analytics (`/v1/data-products/analytics`)** | ✅ Working | Returns fresh data for our devnet USDC mint (supply=1000, holders=0) |
| **User analytics (`/v1/data-products/user-analytics`)** | ✅ Fixed | Now returns 200 with our token (was 401) |
| **Analytics ingestion cron** | ✅ Working | Runs every 5 min, writes to Databricks, health-check shows `ingestion: pass` |
| **Databricks writes** | ✅ Fixed | Param binding bug fixed; `analytics_cache` now has fresh row (id 3) |
| **Analytics history charts** | ⚠️ Partial | `holdersHistory`/`supplyHistory`/`geography` queries return `FAILED` (Databricks date syntax `DATE_SUB`/`DATE()` likely invalid) |
| **Holder count = 0** | ⚠️ Expected | Devnet public RPC `getProgramAccounts` returns no holders for fresh token |
| **Production projects** | 🔒 Locked | UI shows "Mainnet support coming soon" — only sandbox works |
| **Recurring payments** | 🔒 Flagged off | `NEXT_PUBLIC_PAYMENTS_RECURRING_ENABLED` not set |
| **Allowlist / Members pages** | 🚧 Stub | "Coming soon" cards |
| **Paid features (TRM, MoonPay, multi-wallet custody)** | 🔒 Gated | Require business accounts; local = "Add it anyway?" |

---

## PART 5 — QUESTIONS FOR WADDAH (COMPREHENSIVE)

### 5.1 Architecture & Deployment Intent ★★★

1. **Runtime strategy:** Is the **Node `dev:node` runtime** the intended local-dev path, or is `wrangler dev` (Cloudflare Workers) the primary? The repo runs on Node locally but targets CF Workers — any gotchas we should know (e.g., bindings, KV, Hyperdrive differences)?

2. **Dual identity systems:** Why **two identity systems** (Clerk orgs + SDP orgs) with a mapping table (`auth_organization_identities`)? Is this a permanent design (multi-tenant SaaS) or a migration bridge? How should we think about "organization" in code vs UI?

3. **Web → API auth pattern:** Should the web dashboard talk to the API as **Clerk JWT (what we implemented)**, or was the intended pattern an **API key / service account** minted by the web backend? (This determines whether our `page.tsx` fix is "correct" or a local workaround.)

4. **Self-hosted vs managed boundary:** What behavior *actually* changes between `SDP_DEPLOYMENT_MODE=self_hosted` and `managed`? We see feature flags, custody provider gating, fee payment provider switching — is there a canonical matrix?

5. **`sdp-docs` role in local dev:** Is it just for reference, or does the web app link to it dynamically (e.g., API playground "View docs" links)?

### 5.2 Analytics & Databricks ★★★ (We're Stuck Here)

6. **Production analytics pipeline:** In production, what populates Databricks? Is `handleAnalyticsIngestion` the *real* pipeline, or is there an external/Airflow job? We had to fix the param-binding bug (#4) to make *any* write succeed — was that a known issue?

7. **Mainnet vs devnet for analytics:** The seeded `analytics_tokens` are mainnet mints (PYUSD/USDC/USDT/SOL) but local RPC is devnet, so they can't resolve. In production, does analytics run against **mainnet RPC (Helius/QuickNode)**? Do you have a mainnet RPC key we should use locally, or is devnet-with-our-mint the intended local behavior?

8. **`analytics_cache` pattern:** Is "compute in cron → serve from cache" the intended design? We see `cacheAgeSeconds` and `nextRefreshSeconds=300` — confirm this is the intended freshness model.

9. **History charts FAILED:** Our `holdersHistory`/`supplyHistory`/`geography` queries use `DATE_SUB(CURRENT_DATE(), INTERVAL n DAY)` and `DATE(...)`. Databricks returned `FAILED`. **What's the correct Databricks SQL** for those date functions, or are those queries not needed for the MVP?

10. **`token_holders` / `token_supply_snapshots` / `wallet_labels`:** Are these expected to be populated by our ingestion, or by a separate enrichment job (e.g., Helius Wallet Identity)? We got 0 holders for our devnet mint because `getProgramAccounts` returned nothing.

11. **`analytics_tokens` vs `issued_tokens`:** Should these be **merged**? The registry seeds mainnet mints while user tokens live in `issued_tokens` — is the registry meant to be curated/mainnet-only and `issued_tokens` the user scope?

### 5.3 Auth & the `user-analytics` 401 ★★★

12. **Was `user-analytics` *supposed* to be public or protected?** We found it had **no auth middleware at all** (unlike every other route). We added `unifiedAuthMiddleware`. Is that the intended fix, or was the route meant to be open?

13. **The `sdp-api` JWT template** (claims `org_id`, `org_role`, `org_slug`, `email`) — who owns it and is the claim set correct? We rely on `org_id` being present or the middleware throws.

14. **API-key auth in local dev:** How are API keys meant to be created in local dev (the `authMiddleware` needs `API_KEY_PEPPER` + a hashed key in KV/Postgres)? Is there a seed script we missed?

### 5.4 Custody, Wallets & Paid Features

15. **`local` custody = 1 wallet limit:** The `local` custody provider allows only 1 custody wallet (`supportsAdditionalWalletCreation: false`). Is that intended for self-hosted, or a config limitation? How do multi-wallet users work in managed mode (Fireblocks/Turnkey)?

16. **Paid-only features** (TRM/Chainalysis compliance, MoonPay/BVNK fiat ramps, multi-wallet custody) can't work locally without business accounts. For the demo, should these be **stubbed/disabled** or shown as "contact sales"? We've been clicking "Add it anyway?" for counterparty screening.

17. **Custody wallet funding:** Is the devnet SOL faucet the expected local setup, or should signing use a pre-funded account?

### 5.5 Concept Clarifications

18. **"Full analytics" vs "user analytics":** Full = market/stablecoin aggregate (Databricks), user = *your* issued tokens (Postgres + RPC). Confirm this split is correct and intended.

19. **`analytics_tokens` (registry) vs `issued_tokens`:** What's the canonical source of truth for "which tokens exist"? When a user deploys a token, does it get registered into `analytics_tokens` too, or stay only in `issued_tokens`?

20. **Self-hosted vs managed:** Concretely, what behavior changes between `SDP_DEPLOYMENT_MODE=self_hosted` and `managed`? (signing, custody, compliance, analytics.)

21. **Org→project→environment boundary:** We see `Default Sandbox` / `Default Production` projects. How does the "environment" (sandbox vs production) gate behavior (e.g., real vs fake funds, mainnet vs devnet)?

### 5.6 Things We Don't Know / Want to Clarify

22. **Codebase maturity:** Is our codebase at a known good commit, or a work-in-progress branch? Several issues (missing migration columns, missing auth middleware, Databricks param bug) feel like incomplete work — want to confirm we're not debugging a half-finished feature.

23. **Upstream contribution:** Should our fixes (#1–#6) be contributed back as PRs? The Databricks `:name` param fix and the `analytics_tokens` columns in particular look like they'd affect **production too**, not just local.

24. **Source of truth for local dev:** Is there a README/setup doc we should be following that we might have missed (env vars, migration order, seed scripts)?

25. **Svix relay:** Is forwarding Clerk webhooks through `play.svix.com` the intended local approach, or is there a simpler local webhook dev setup?

### 5.7 Strategic / Demo Scope

26. **Demo must-haves:** For "run it **as if it were the official hosted platform**," what's the **must-have feature set** for the demo vs what can be stubbed? (We've got auth, wallets, issuance, payments, analytics partially working.)

27. **External integrations priority:** Which **external integrations are non-negotiable** for the demo (Databricks analytics? Clerk? a real RPC?) vs which can be faked?

28. **Target environment:** Is there a **target environment** this needs to deploy to (Cloudflare Workers prod, a VPS, etc.) and any infra Waddah already provisioned that we should point at?

29. **Timeline/priority:** What's the single most important thing to get working next, so we focus effort correctly?

---

### 5.8 Suggested "Ask Waddah First" Shortlist (If Time Is Limited)

| Priority | Question | Why It Matters |
|----------|----------|----------------|
| 1 | **#6** (mainnet vs devnet RPC for analytics) | Determines our whole local analytics approach |
| 2 | **#5 / #8** (is Databricks ingestion the real pipeline + correct date SQL) | Unblocks the history charts |
| 3 | **#3 / #11** (web→API auth model + whether `user-analytics` should be protected) | Validates our two fixes |
| 4 | **#20** (are we on a half-finished branch?) | Reframes everything |
| 5 | **#24** (demo must-haves) | Focuses the remaining work |

---

## PART 6 — HOW TO USE THIS REPORT

1. **Hand this to Waddah** as a "state of the union" — it captures the full system, our fixes, and the exact questions that unblock us.
2. **For the team:** The architecture section (Part 2) serves as a reference for onboarding — request flow, auth chain, ingestion pipeline, custody model.
3. **For future work:** The gaps table (Part 4) and questions (Part 5) are the backlog. Prioritize by Waddah's answers.

---

*Report generated from full codebase exploration + this engagement's fixes. All file paths are absolute under `C:\Users\Johnnie\Documents\MLH_Fellowship_2026\solana-developer-platform\solana-developer-platform`.*