# Task Context: Analytics Expansion — Multi-Token + User Token Analytics

Session ID: 2026-07-08-analytics-expansion
Created: 2026-07-09T00:40:00Z
Status: in_progress

## Current Request
Expand the analytics pipeline to support:
- **Workstream A**: Multiple stablecoins (not just USDC) — make the data product query configurable mints
- **Workstream B**: User-scoped token analytics — pull the user's own tokens from SDP Postgres, enrich with RPC holder data
- **Workstream C**: Create `wallet_labels` enrichment table in Databricks (foundation for geography + attribution)
- Wire both views into the dashboard with tabs/toggle

## Context Files (Standards to Follow)
- `solana-developer-platform/AGENTS.md` — repo layout, public/internal surfaces, preferred checks
- `solana-developer-platform/CONTEXT.md` — domain terminology
- `solana-developer-platform/biome.json` — code quality (2-space indent, 100 char width, double quotes)
- `solana-developer-platform/tsconfig.json` — TS strict mode, ES2022
- `solana-developer-platform/.superpowers/sdd/progress.md` — prior task completion ledger
- `solana-developer-platform/docs/superpowers/specs/2026-07-08-analytics-databricks-enrichment-design.md` — approved design spec

## Reference Files (Source Material)
- `apps/sdp-api/src/routes/data-products/analytics.ts` — current analytics handler (RPC → Databricks → mock)
- `apps/sdp-api/src/app.ts` — route registration at `/v1/data-products/analytics`
- `apps/sdp-api/src/db/client.ts` — Postgres DatabaseClient (getDb, queryMany, etc.)
- `apps/sdp-api/src/db/index.ts` — DB exports
- `apps/sdp-api/src/db/repositories/token.repository.ts` — TokenRepository interface (listByProject)
- `apps/sdp-api/src/db/repositories/token.repository.postgres.ts` — Postgres impl
- `apps/sdp-api/src/db/migrations/postgres/0001_initial_schema.sql` — full schema: issued_tokens, issuance_transactions, projects, etc.
- `apps/sdp-web/src/app/dashboard/analytics/page.tsx` — current dashboard page
- `apps/sdp-web/src/app/dashboard/analytics/analytics-types.ts` — shared type definitions
- `apps/sdp-web/src/app/dashboard/analytics/analytics-workspace.tsx` — client-side workspace
- `scripts/ingest-analytics.mjs` — RPC ingestion script

## External Docs Fetched
- Databricks workspace: workspace catalog → `workspace.default` schema
- Tables exist: `token_holders`, `token_supply_snapshots`, `analytics_cache`
- No existing label/enrichment tables — need to create `wallet_labels`
- Metastore: `126b15ed-3cde-4299-809e-78ce5a5e2c9b`, workspace: `7474654380456508`

## Components

### A: Multi-Token Stablecoin Analytics
- Refactor `analytics.ts` to accept `?mints` query param or iterate a known list
- Break out the per-token RPC logic into a reusable function
- Support array of stablecoin mints → return array of stablecoin entries
- Keep Databricks cache layer (already queries `analytics_cache`)

### B: User Token Analytics Endpoint
- New route: `GET /v1/data-products/user-analytics` — scoped to user's project
- Query SDP Postgres for user's tokens (via `tokens.repository` or direct DB query)
- For each token: lookup RPC for holders, supply
- Return per-token + aggregate metrics
- Auth-gated to the user's own project

### C: Databricks `wallet_labels` Table
- Create `workspace.default.wallet_labels` — wallet → geography + attribution mapping
- Columns: wallet_address (STRING), geography (STRING), attribution_category (STRING), source (STRING), updated_at (TIMESTAMP)
- Populate with "Unknown" defaults initially
- Joinable with `token_holders` for enrichment

### D: Dashboard Wiring
- Add tabs/view toggle: "Stablecoin Analytics" vs "My Tokens"
- Stablecoin view: existing chart workspace
- My Tokens view: table of user's tokens with per-token metrics

## Constraints
- Must work within existing SDP architecture (Hono, Cloudflare Workers, Postgres)
- RPC calls are devnet only (USDC devnet mint is `Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr`)
- Databricks auth via env vars: `DATABRICKS_HOST`, `DATABRICKS_TOKEN`, `DATABRICKS_WAREHOUSE_ID`
- SDP Postgres auth via `DATABASE_URL` env var / Hyperdrive binding
- Code patterns: SDP uses `pg` raw queries, no ORM, custom DatabaseClient abstraction
- Follow biome.json standards: 2-space indent, double quotes, no explicit any

## Exit Criteria
- [ ] Stablecoin analytics handler supports multiple mints (not hardcoded to USDC)
- [ ] `wallet_labels` table exists in Databricks with geography + attribution columns
- [ ] User token analytics endpoint exists — queries SDP DB + RPC for user-scoped data
- [ ] Dashboard shows both views with toggle
- [ ] All TypeScript checks pass (`pnpm typecheck`)
- [ ] End-to-end verification: RPC returns real holder data for queried tokens
