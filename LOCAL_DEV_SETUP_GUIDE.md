# SDP Local Development Setup — Complete Step-by-Step Guide (From Zero to Running)

> **Audience:** New developer joining the project.  
> **Goal:** Get the **entire Solana Developer Platform** running locally — API, Dashboard, Docs, Postgres, Redis, Databricks analytics, Clerk auth, Svix webhook relay — exactly as we have it running now.  
> **Prerequisites:** Windows 10/11, admin rights, ~15 GB free disk, ~30 min.

---

## 0. Prerequisites (Install Once)

| Tool | Version | Install Command / Link |
|------|---------|------------------------|
| **Git** | ≥ 2.40 | `winget install Git.Git` |
| **Node.js** | **22.12.0** (exact — see `.nvmrc` / `engines` in `package.json`) | `nvm install 22.12.0 && nvm use 22.12.0` |
| **pnpm** | **10.16.0** (pinned in `package.json`) | `corepack enable && corepack prepare pnpm@10.16.0 --activate` |
| **Docker Desktop** | Latest | <https://www.docker.com/products/docker-desktop/> (enable WSL 2 backend) |
| **VS Code** (recommended) | Latest | `winget install Microsoft.VisualStudioCode` |
| **Doppler CLI** (optional, for managed secrets) | Latest | `winget install Doppler.DopplerCLI` |

> **Verify:** Open a **new** PowerShell window and run:
> ```powershell
> node --version   # → v22.12.0
> pnpm --version   # → 10.16.0
> docker version   # → Client/Server both show
> ```

---

## 1. Clone & Install Dependencies

```powershell
# 1. Clone the repo (use the exact path we use)
cd C:\Users\$env:USERNAME\Documents
git clone https://github.com/solana-foundation/solana-developer-platform.git
cd solana-developer-platform\solana-developer-platform

# 2. Install all workspace deps (takes 2–3 min)
pnpm install
```

> **Note:** `pnpm` uses a global store; first run downloads ~1.5 GB.

---

## 2. Start Infrastructure (Postgres + Redis)

We use **dedicated containers** so the API and Dashboard never fight over ports.

```powershell
# From repo root
docker compose -f docker-compose.yml up -d postgres redis
# Wait ~10 s for health checks
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

**Expected output:**
```
NAMES               STATUS                    PORTS
sdp-postgres        Up 5 seconds (healthy)    0.0.0.0:5433->5432/tcp
sdp-redis           Up 5 seconds (healthy)    0.0.0.0:6379->6379/tcp
```

> **Ports:** Postgres **5433** (not 5432!), Redis **6379**.  
> The API reads `DATABASE_URL=postgresql://postgres:sdp@localhost:5433/sdp` and `REDIS_URL=redis://localhost:6379`.

---

## 3. Bootstrap the Database (Migrations + Seed)

```powershell
# From repo root
pnpm --filter @sdp/api db:postgres:bootstrap
# This runs: node scripts/migrate-postgres.mjs  (creates schema_migrations + runs all 0001–0025)
# Then seeds a test user/org/project + a dev API key (sk_test_...)
```

**Verify:**
```powershell
$env:PGPASSWORD="your-postgres-password"
psql -h localhost -p 5433 -U postgres -d sdp -c "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 5;"
# Should show 0025_analytics_tokens_ingestion_columns.sql as latest
```

---

## 4. Clerk Setup (Auth + Org + JWT Template)

> **You need a Clerk account.** If you don't have one, sign up at <https://clerk.com> (free tier is fine).

### 4.1 Create Application
1. Dashboard → **Applications** → **Create application** → name it **"SDP Local Dev"**.
2. Choose **Next.js** (for the web app) + **Custom** (for the API).
3. Copy **Publishable Key** (`pk_test_...`) and **Secret Key** (`sk_test_...`).

### 4.2 Configure JWT Template
1. In the Clerk dashboard → **JWT Templates** → **New template** → name **`sdp-api`**.
2. Claims (all **required**):
   ```json
   {
     "org_id": "{{org.id}}",
     "org_role": "{{org.role}}",
     "org_slug": "{{org.slug}}",
     "email": "{{user.primary_email_address.email_address}}"
   }
   ```
4. Save.

### 4.3 Webhook for Org Linking
1. **Webhooks** → **Add endpoint** → URL: `https://play.svix.com/in/c_rbkLhZ7YRc/` (our Svix relay target).
2. Events: **`organization.created`**, **`organization.updated`**, **`organization.deleted`**, **`organizationMembership.created`**, **`organizationMembership.updated`**, **`organizationMembership.deleted`**.
3. Save → copy **Signing Secret** (`whsec_...`).

---

## 5. Databricks (Free Trial) — Analytics Warehouse

> **Only needed for the Analytics tab.** If you skip this, the "Stablecoin Analytics" tab will show "Analytics unavailable" but the rest of the platform works.

1. Sign up at <https://www.databricks.com/try-databricks> (14-day free trial, AWS or Azure).
2. After login → **Compute** → **Create SQL Warehouse**:
   - Name: `sdp-analytics`
   - Size: `2X-Small` (free tier)
   - Auto-stop: `10 min`
3. Copy **Warehouse ID** (e.g., `b93fd37f80a01180`).
4. **User Settings** → **Developer** → **Access Tokens** → **Generate new token** → name `sdp-local` → copy token (`dapi...`).
5. **Settings** → **General** → copy **Host** (e.g., `dbc-9f712491-51a1.cloud.databricks.com`).

### 5.1 Create Tables (Run Once)
In Databricks **SQL Editor**, run:
```sql
CREATE CATALOG IF NOT EXISTS workspace;
USE CATALOG workspace;
CREATE SCHEMA IF NOT EXISTS default;

CREATE TABLE IF NOT EXISTS analytics_cache (
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  response_json STRING,
  holder_count BIGINT,
  total_supply DECIMAL(38,18),
  snapshot_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS token_holders (
  mint_address STRING,
  wallet_address STRING,
  balance DECIMAL(38,18),
  slot BIGINT,
  snapshot_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS token_supply_snapshots (
  mint_address STRING,
  supply DECIMAL(38,18),
  decimals INT,
  slot BIGINT,
  snapshot_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wallet_labels (
  wallet_address STRING,
  geography STRING,
  attribution_category STRING,
  source STRING,
  updated_at TIMESTAMP
);
```

---

## 6. Configure `.dev.vars` (All Local Secrets)

```powershell
cd apps\sdp-api
copy .dev.vars.example .dev.vars
```

Open `apps\sdp-api\.dev.vars` in your editor and **fill every value**:

```ini
# ─── Database ──────────────────────────────────────────────
DATABASE_URL=postgresql://postgres:sdp@localhost:5433/sdp
REDIS_URL=redis://localhost:6379

# ─── Core ──────────────────────────────────────────────────
ENVIRONMENT=development
API_VERSION=v1
SDP_DEPLOYMENT_MODE=self_hosted
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_NETWORK=devnet

# ─── Clerk ─────────────────────────────────────────────────
CLERK_ISSUER=https://charming-filly-19.clerk.accounts.dev
CLERK_SECRET_KEY=sk_test_...           # from Clerk dashboard
CLERK_WEBHOOK_SECRET=whsec_...         # from Clerk webhook
CLERK_JWT_TEMPLATE=sdp-api             # exact template name

# ─── Self-hosted signing / custody ─────────────────────────
SIGNING_PROVIDER=local
CUSTODY_PRIVATE_KEY=<your-base58-encoded-keypair-here>
CUSTODY_ENCRYPTION_KEY=CUSTODY_ENCRYPTION_KEY=<your-base64-encoded-encryption-key-here>
FEE_PAYMENT_PROVIDER=native
FEE_PAYER_PRIVATE_KEY=<your-base58-encoded-keypair-here>

# ─── Databricks (analytics) ────────────────────────────────
DATABRICKS_HOST=dbc-XXXXXXXX-XXXX.cloud.databricks.com
DATABRICKS_TOKEN=dapi...
DATABRICKS_WAREHOUSE_ID=XXXXXXXXXXXXXXXX

# ─── Analytics ingestion ───────────────────────────────────
ANALYTICS_ENABLED=true
ANALYTICS_MINTS=9fxDZ7rBCNdHureibbAVa6J73srhCYWoKYZWwegXe72Z
# ANALYTICS_RPC_URL=  (optional; defaults to SOLANA_RPC_URL)

# ─── Email (optional, for invites) ─────────────────────────
EMAIL_FROM=noreply@yourdomain.com
RESEND_API_KEY=re_...

# ─── Feature flags ─────────────────────────────────────────
PAYMENTS_RECURRING_ENABLED=false
PAYMENTS_RECURRING_COLLECTION_ENABLED=false
```

> **Important:** The `CUSTODY_PRIVATE_KEY` / `FEE_PAYER_PRIVATE_KEY` above are **dev-only** throwaway keys. **Never use them on mainnet.**

---

## 7. Configure Web App (`.env.local`)

```powershell
cd ..\sdp-web
copy .env.local.example .env.local
```

Edit `apps\sdp-web\.env.local`:

```ini
# Clerk
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
CLERK_JWT_TEMPLATE=sdp-api

# API base (must match API port)
NEXT_PUBLIC_SDP_API_BASE_URL=http://127.0.0.1:8787

# Feature flags
NEXT_PUBLIC_PAYMENTS_RECURRING_ENABLED=false
NEXT_PUBLIC_ENABLE_NETWORK_DEBUG=true

# Docs proxy (optional)
NEXT_PUBLIC_SDP_DOCS_URL=http://localhost:3001
```

---

## 8. Run Database Migrations (Apply Our Fixes)

```powershell
cd ..\sdp-api
$env:DATABASE_URL="postgresql://postgres:sdp@localhost:5433/sdp"
pnpm db:migrate:dev
# Should say "Postgres migrations are up to date." (includes our 0025)
```

---

## 9. Start Svix Webhook Relay (Clerk → Local API)

```powershell
# Install Svix CLI once
npm install -g svix-cli

# Run in a **separate** terminal (keep it open)
svix listen -t c_rbkLhZ7YRc http://127.0.0.1:8787/webhooks/clerk/link-orgs
```

> **Keep this terminal open.** It forwards Clerk org events to your local API so org linking works.

---

## 10. Start Everything (3 Terminals)

### Terminal 1 — API (Node mode)
```powershell
cd apps\sdp-api
pnpm dev:node
# → "sdp-api listening on :8787"
```

### Terminal 2 — Web Dashboard
```powershell
cd apps\sdp-web
pnpm dev
# → "Ready on http://localhost:3000"
```

### Terminal 3 — Docs (optional)
```powershell
cd apps\sdp-docs
pnpm dev
# → "Ready on http://localhost:3001"
```

---

## 11. Verify Everything Works

| Check | Command / URL | Expected |
|-------|---------------|----------|
| API health | `curl http://127.0.0.1:8787/health` | `{"status":"ok",...}` |
| API deep health | `curl http://127.0.0.1:8787/health-check` | `databricks: pass`, `ingestion: pass` |
| Full analytics | `curl http://127.0.0.1:8787/v1/data-products/analytics` | `200` + JSON with our mint |
| User analytics | `curl -H "Authorization: Bearer <clerk-token>" http://127.0.0.1:8787/v1/data-products/user-analytics` | `200` with our token |
| Dashboard | Open `http://localhost:3000` | Sign in → see **Analytics** tab with data |
| Svix relay | Check terminal | `connected` + `forwarding` |

### Get a Clerk Token for Manual `curl` (Optional)
1. Open `http://localhost:3000` → sign in.
2. Open DevTools → **Application** → **Cookies** → `http://localhost:3000` → `__session` → copy value.
3. In another terminal:
   ```powershell
   $token = "<__session_cookie_value>"
   curl -H "Authorization: Bearer $token" http://127.0.0.1:8787/v1/data-products/user-analytics
   ```

---

## 12. Deploy a Test Token (End-to-End Issuance)

1. Dashboard → **Issuance** → **Create Token** → Template **Stablecoin** → fill name/symbol/decimals/URI → **Create**.
2. Click the token → **Deploy** → **Confirm** (custodial deploy).
3. Wait ~30 s → status → **Active** → copy **Mint Address**.
4. Verify in Analytics tab: your token appears under **My Tokens** with supply/holder data.

---

## 13. Common Issues & Fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| `EADDRINUSE 8787` | Stale API process | `taskkill /F /IM node.exe` (or kill via PID) then restart API |
| `connect ECONNREFUSED 5433` | Postgres not up | `docker start sdp-postgres` |
| `Clerk token missing org_id` | JWT template missing `org_id` claim | Verify Clerk JWT template `sdp-api` has `org_id` claim |
| `Databricks FAILED` on history charts | `DATE_SUB`/`DATE()` syntax | Use `DATEADD(day, -n, CURRENT_DATE())` in Databricks SQL |
| `getProgramAccounts` returns 0 holders | Devnet RPC doesn't index new token yet | Expected for fresh tokens; wait or use Helius/QuickNode |
| `Svix relay` disconnects | Network / firewall | Restart `svix listen ...`; ensure port 8787 reachable |
| `pnpm install` fails | Node version mismatch | `nvm use 22.12.0` (exact version) |

---

## 14. Useful Commands Cheat Sheet

```powershell
# Restart API only
cd apps\sdp-api; pnpm dev:node

# Re-run migrations after pulling new code
cd apps\sdp-api; $env:DATABASE_URL="postgresql://postgres:sdp@localhost:5433/sdp"; pnpm db:migrate:dev

# Re-seed dev data (test user/org/project/api-key)
cd apps\sdp-api; pnpm db:seed:local

# Regenerate OpenAPI + docs + AI resources
cd apps\sdp-api; pnpm openapi:generate
cd apps\sdp-docs; pnpm generate:api; pnpm generate:ai

# Run unit tests (API)
cd apps\sdp-api; pnpm test:node

# Run integration tests (needs Kora + Solana RPC)
pnpm test:integration

# View API logs (if running via docker compose)
docker logs -f sdp-api
```

---

## 15. What's *Not* Working Locally (By Design)

| Feature | Reason | Workaround |
|---------|--------|------------|
| **Mainnet projects** | UI locked to sandbox | Only sandbox projects work |
| **Recurring payments** | Feature flag off | Set `NEXT_PUBLIC_PAYMENTS_RECURRING_ENABLED=true` + enable in API |
| **TRM / Chainalysis screening** | Paid accounts only | Click "Add it anyway?" in UI |
| **MoonPay / BVNK ramps** | Paid accounts only | Use sandbox simulation endpoints |
| **Multi-wallet custody (Fireblocks, Turnkey, etc.)** | Paid accounts only | Use `local` custody (1 wallet) |
| **Analytics history charts** | Databricks date syntax | Fix SQL in `analytics.ts` (`DATEADD` instead of `DATE_SUB`) |

---

## 16. Next Steps for a New Dev

1. **Read the architecture report** (`SDP_COMPLETE_ARCHITECTURE_AND_WADDAH_QUESTIONS.md`) — it explains the whole system.
2. **Run the integration tests** (`pnpm test:integration`) to see the full flow.
3. **Pick a feature** from the "Known Gaps" table and fix it — that's how you learn the codebase.
4. **Talk to Waddah** with the questions in `SDP_COMPLETE_ARCHITECTURE_AND_WADDAH_QUESTIONS.md` — he knows the product intent.

---

## Appendix: File Tree (Key Paths)

```
solana-developer-platform/
├── apps/
│   ├── sdp-api/                 # Hono API (CF Workers + Node)
│   │   ├── src/
│   │   │   ├── app.ts           # Hono factory + global middleware
│   │   │   ├── index.ts         # CF Workers entry
│   │   │   ├── server.ts        # Node entry (dev:node)
│   │   │   ├── routes/          # All API route groups
│   │   │   ├── middleware/      # auth, rate-limit, kv, clerk, etc.
│   │   │   ├── lib/             # db, clerk-token, databricks-query, token-registry, etc.
│   │   │   ├── cron/            # ingestion, reconciliation, retirement, etc.
│   │   │   └── db/migrations/postgres/   # 0001–0025
│   │   ├── .dev.vars            # ← YOUR LOCAL SECRETS
│   │   └── wrangler.toml
│   ├── sdp-web/                 # Next.js dashboard
│   │   ├── src/app/
│   │   │   ├── dashboard/       # all dashboard pages
│   │   │   └── api/dashboard/   # server-side proxies to API
│   │   ├── src/lib/sdp-api.ts   # typed API client
│   │   └── .env.local           # ← YOUR WEB SECRETS
│   └── sdp-docs/                # Fumadocs site
├── packages/
│   ├── sdp-types/               # shared types + site constants
│   ├── sdp-rpc/                 # RPC client config
│   ├── sdp-solana/              # Solana helpers + Token-2022
│   ├── sdp-env-config/          # self-host configurator
│   ├── sdp-custody/             # custody provider adapters
│   ├── sdp-payments/            # fee payment + ramp clients
│   └── sdp-api-integration/     # integration test harness
├── infra/
│   ├── self-hosted/             # install.sh, compose.yml, .env.example
│   └── postgres/                # local postgres compose
├── scripts/                     # migrate, seed, ramp-rails, secret-keys, etc.
├── docker-compose.yml           # local infra (postgres, redis, api, web, docs)
├── pnpm-workspace.yaml
├── turbo.json
├── SDP_COMPLETE_ARCHITECTURE_AND_WADDAH_QUESTIONS.md  ← our big report
└── README.md
```

---

## 🎉 You're Done!

You now have a **fully functional local SDP stack** identical to the hosted platform (minus paid integrations). Open `http://localhost:3000`, sign in with Clerk, and start building on Solana.

**Welcome to the team!** 🚀
