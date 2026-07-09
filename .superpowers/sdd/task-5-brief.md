# Task 5: Refactor analytics.ts — remove mock data, add history queries, add freshness

**Files:**
- Modify: `apps/sdp-api/src/routes/data-products/analytics.ts`

**Responsibility:** Remove all mock data generators, refactor the route handler to read exclusively from Databricks, add history queries from snapshot tables, add freshness info to the response meta.

**Changes:**

1. **Replace import** (line 18):
   - From: `import { getTokenSupply, getHolderCount } from "@/lib/rpc-utils";`
   - To: `import { queryDatabricks } from "@/lib/databricks-query";`

2. **Delete the entire "Mock Data Generators" section** (lines 82-158) — removes `generateHolderHistory()`, `generateSupplyHistory()`, `getMockResponse()`

3. **Add history query helpers** after the `KNOWN_MINTS` block (around line 80):
   - `queryHoldersHistory(env, days = 30): Promise<TimeSeriesEntry[]>`
   - `querySupplyHistory(env, days = 30): Promise<Array<{ date: string; [symbol: string]: string | number }>>`

4. **Replace the route handler** (from `analytics.get("/", async (c) => {` to the final `})`) with the new Databricks-only version that:
   - Reads latest `analytics_cache` row
   - Enriches with `wallet_labels` via `enrichGeography(env, totalHolders)`
   - Queries real history from `token_holders` and `token_supply_snapshots`
   - Returns response with `meta.freshness`

5. **Update `enrichGeography` signature** to take `env` as first param

**Verification:**
- `pnpm --filter @sdp/api typecheck 2>&1 | Select-String "analytics.ts"` — Expected: no output

**Context:**
- `queryDatabricks(env, sql, timeout?)` is at `@/lib/databricks-query`
- `Env` type has `DATABRICKS_HOST`, `DATABRICKS_TOKEN`, `DATABRICKS_WAREHOUSE_ID`, `ANALYTICS_MINTS`
- The current file is 338 lines — you'll be replacing a large portion of it
- The `enrichGeography` function currently uses closure variables `dbHost`, `dbToken`, `dbWarehouseId` — change it to use `env` param instead
- The `queryDatabricks` helper inside the route handler should be removed (use the imported one)