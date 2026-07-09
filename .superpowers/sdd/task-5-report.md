# Task 5 Report — Analytics Real Data Pipeline

**Status:** DONE

## Summary

Refactored `apps/sdp-api/src/routes/data-products/analytics.ts` to remove all mock/RPC
code paths and serve analytics exclusively from the Databricks `analytics_cache` plus
real history queries.

## Changes Applied

1. **Import swap (line 18):** Replaced
   `import { getTokenSupply, getHolderCount } from "@/lib/rpc-utils";`
   with `import { queryDatabricks } from "@/lib/databricks-query";`.

2. **Deleted Mock Data Generators (old lines 82–158):** Removed
   `generateHolderHistory()`, `generateSupplyHistory()`, and `getMockResponse()`.

3. **Added history query helpers** after the `KNOWN_MINTS` block:
   - `queryHoldersHistory(env: Env, days = 30): Promise<TimeSeriesEntry[]>` — queries
     `token_holders` for daily distinct-holder counts.
   - `querySupplyHistory(env: Env, days = 30): Promise<Array<{ date: string; [symbol: string]: string | number }>>` —
     queries `token_supply_snapshots` and pivots rows into per-symbol daily entries.

4. **Replaced route handler** with a Databricks-only version that:
   - Parses `?mints=` (falls back to `ANALYTICS_MINTS` env var, then devnet USDC).
   - Returns **503** when Databricks credentials are missing.
   - Returns **503** when no `analytics_cache` row exists.
   - Enriches `holders` via `enrichGeography(env, totalHolders)`.
   - Queries real `holdersHistory` / `supplyHistory` from Databricks.
   - Returns `meta.freshness` with `cacheAgeSeconds`, `nextRefreshSeconds`, and
     `source: "cache"`.

5. **Updated `enrichGeography` signature** to take `env: Env` as its first parameter
   (now uses the shared `queryDatabricks(env, sql)` helper).

## Typecheck Result

```
pnpm --filter @sdp/api typecheck 2>&1 | Select-String "analytics.ts"
```

**Result:** No output — `analytics.ts` produces zero type errors.

The only type errors present are pre-existing and unrelated to this task (in
`payments`, `custody`, `amount`, `app.ts`, and test files), consistent with the
expected baseline.
