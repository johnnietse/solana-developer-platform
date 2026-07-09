# Task 4: Create analytics ingestion cron handler

**Files:**
- Create: `apps/sdp-api/src/crons/analytics-ingestion.ts`

**Responsibility:** Cron-triggered ingestion: for each configured mint, query RPC for token supply + holders, write snapshots to Databricks, upsert wallet_labels, compute and cache analytics response.

**Interface — Consumes:**
- `queryDatabricks` from `@/lib/databricks-query`
- `rpcCall` from `@/lib/rpc-utils` (signature: `rpcCall(url: string, method: string, params: unknown[]): Promise<unknown>`)

**Interface — Produces:**
- `handleAnalyticsIngestion(env: Env, ctx: ExecutionContext): Promise<Response>` — exported handler called by cron trigger

**Implementation details (from plan):**
- Read `ANALYTICS_ENABLED` and `ANALYTICS_MINTS` from env
- For each mint: getTokenSupply, getProgramAccounts for holders, write to token_supply_snapshots, token_holders, wallet_labels, analytics_cache
- Retry logic: 3 retries with backoff for RPC calls
- Batch holder inserts (100 per batch)
- Return JSON response with results per mint

**Verification:**
- `pnpm --filter @sdp/api typecheck 2>&1 | Select-String "analytics-ingestion"` — Expected: no output

**Context:**
- `Env` type has `DATABRICKS_HOST`, `DATABRICKS_TOKEN`, `DATABRICKS_WAREHOUSE_ID`, `SOLANA_RPC_URL`, `ANALYTICS_ENABLED`, `ANALYTICS_MINTS`
- `rpcCall` is at `apps/sdp-api/src/lib/rpc-utils.ts` line 21
- `queryDatabricks` is at `apps/sdp-api/src/lib/databricks-query.ts`
- The cron trigger in `wrangler.toml` is `*/5 * * * *`
- The main Worker entrypoint is `apps/sdp-api/src/index.ts` — it has a `scheduled` handler that calls other cron functions. You'll need to import and call `handleAnalyticsIngestion` from there.