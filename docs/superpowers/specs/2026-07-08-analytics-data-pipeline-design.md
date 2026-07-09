# Analytics Data Pipeline Design

**Date:** 2026-07-08
**Status:** Draft
**Author:** Development Agent

## Overview

Integrate real-time Solana on-chain analytics into the Solana Developer Platform (SDP)
with two views: (1) market-wide stablecoin analytics and (2) per-user token analytics.
All data is real — no mock data, no Math.random() — sourced from Solana RPC, cached in
Databricks, and served through the SDP API with clear freshness indicators.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                    Cron Trigger (every 5 min)                         │
│  wrangler.toml: crons = ["*/5 * * * *"] (analytics-specific)        │
└──────────────────────────┬───────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    Analytics Ingestion Handler                        │
│  apps/sdp-api/src/crons/analytics-ingestion.ts                      │
│                                                                      │
│  1. For each mint in ANALYTICS_MINTS env var:                       │
│     a. RPC: getTokenSupply(mint)                                    │
│     b. RPC: getProgramAccounts(mint) → holders                      │
│     c. Databricks: INSERT INTO token_supply_snapshots               │
│     d. Databricks: INSERT INTO token_holders (batch)                │
│     e. Databricks: UPSERT wallet_labels                             │
│     f. Databricks: INSERT INTO analytics_cache                      │
└──────────────────────────┬───────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    SDP API — GET /v1/data-products/analytics         │
│  apps/sdp-api/src/routes/data-products/analytics.ts                 │
│                                                                      │
│  1. Read latest analytics_cache from Databricks                     │
│  2. Query token_supply_snapshots → supplyHistory (30d)              │
│  3. Query token_holders → holderCount per snapshot → holdersHistory │
│  4. Query wallet_labels → geography + attribution                   │
│  5. Return { data, meta: { freshness: { cacheAge, nextRefresh } } } │
│                                                                      │
│  NO mock data. NO RPC fallback at request time.                     │
│  If Databricks unreachable → HTTP 503                               │
└──────────────────────────┬───────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    Dashboard (Next.js SSR)                           │
│  apps/sdp-web/src/app/dashboard/analytics/page.tsx                  │
│                                                                      │
│  1. Fetch from SDP API (no fallback to mock)                        │
│  2. If API fails → error state with retry button                    │
│  3. LiveDot shows freshness from meta.freshness.cacheAge            │
│  4. Charts render real data or empty state                          │
└──────────────────────────────────────────────────────────────────────┘
```

## Data Flow

### Ingestion (Cron — every 5 minutes)

1. Worker cron trigger fires
2. `analytics-ingestion.ts` reads `ANALYTICS_MINTS` env var (comma-separated mint addresses)
3. For each mint:
   - Call `getTokenSupply(mint)` via RPC
   - Call `getProgramAccounts(mint)` via RPC to get holders
   - Write supply snapshot to `token_supply_snapshots`
   - Write holders to `token_holders` (batched)
   - Upsert wallet addresses into `wallet_labels`
   - Compute analytics response and write to `analytics_cache`
4. If RPC fails for a mint, retry 3 times with backoff, skip if all fail

### Serving (API Request)

1. User loads dashboard → Next.js calls `GET /v1/data-products/analytics?mints=...`
2. API handler:
   - Reads latest `analytics_cache` row → gets cached stablecoin entries
   - Queries `token_supply_snapshots` → `SELECT DATE(snapshot_at), SUM(supply) GROUP BY DATE(snapshot_at), mint_address` → builds `supplyHistory`
   - Queries `token_holders` → `SELECT DATE(snapshot_at), COUNT(DISTINCT wallet_address) GROUP BY DATE(snapshot_at)` → builds `holdersHistory`
   - Queries `wallet_labels` → geography distribution + attribution breakdown
   - Returns combined response with `snapshot_at` as `lastUpdated`
3. If Databricks is unreachable → HTTP 503 with `{ error: "Data temporarily unavailable" }`

### User Token Analytics (No Changes)

`GET /v1/data-products/user-analytics` already works correctly:
- Queries Postgres `issued_tokens` for the authenticated user's tokens
- Enriches each token with live RPC `getTokenSupply` + `getHolderCount`
- Returns per-token entries + summary stats
- No mock data, no hardcoded values

---

## Components

### 1. Cron Trigger Configuration

**File:** `apps/sdp-api/wrangler.toml`

Add a second cron trigger for analytics:
```toml
[triggers]
crons = [
  "* * * * *",       # Existing: transfer reconciliation
  "*/5 * * * *",     # New: analytics ingestion
]
```

**New env vars:**
- `ANALYTICS_MINTS` — comma-separated mint addresses to track
- `ANALYTICS_ENABLED` — feature flag to enable/disable ingestion

### 2. Analytics Ingestion Handler (New)

**File:** `apps/sdp-api/src/crons/analytics-ingestion.ts`

A dedicated handler called by the cron trigger. Contains:
- `runAnalyticsIngestion(env)` — main entry point
- `ingestMint(env, mint)` — per-mint ingestion with retry logic
- Reuses `rpcCall` from `src/lib/rpc-utils.ts`
- Reuses `databricksQuery` helper from analytics route

### 3. Analytics Route Refactored

**File:** `apps/sdp-api/src/routes/data-products/analytics.ts`

**Removed:**
- `getMockResponse()` — entire function deleted
- `generateHolderHistory()` — deleted
- `generateSupplyHistory()` — deleted
- `?mock=true` query param — removed
- RPC fallback path — removed
- Hardcoded `KNOWN_MINTS` map — replaced with `ANALYTICS_MINTS` env var

**Kept/Refactored:**
- `queryDatabricks(sql)` helper — kept (used for all Databricks reads)
- `enrichGeography(totalHolders)` — kept (queries wallet_labels)
- Cache read logic — refactored to also query history tables

**Added:**
- `queryHoldersHistory(days)` — builds `holdersHistory` from `token_holders`
- `querySupplyHistory(days)` — builds `supplyHistory` from `token_supply_snapshots`
- `computeFreshness(snapshotAt)` — returns `cacheAge` and `nextRefreshIn`

### 4. Dashboard Page Refactored

**File:** `apps/sdp-web/src/app/dashboard/analytics/page.tsx`

**Removed:**
- `generateHolderHistory()` — deleted
- `generateSupplyHistory()` — deleted
- `mockData` — deleted
- `mockUserData` — deleted
- All fallback-to-mock logic — deleted

**Kept:**
- Auth check (`clerk auth`)
- Parallel fetch to both API endpoints
- Error state when API fails

### 5. Dashboard Workspace (No Changes)

**File:** `apps/sdp-web/src/app/dashboard/analytics/analytics-workspace.tsx`

No structural changes. Already handles:
- Loading state (null data)
- Error state (error string)
- Empty state (empty arrays)
- Real data rendering

The `LiveDot` component already shows freshness from `lastUpdated`.

---

## Database Schema (Databricks)

### Existing Tables (No Schema Changes)

| Table | Purpose | Columns |
|-------|---------|---------|
| `token_supply_snapshots` | Historical supply per mint per snapshot | `mint_address, supply, decimals, slot, snapshot_at` |
| `token_holders` | Historical holder balances per snapshot | `mint_address, wallet_address, balance, slot, snapshot_at` |
| `analytics_cache` | Pre-computed API response | `response_json, holder_count, total_supply, snapshot_at` |
| `wallet_labels` | Wallet enrichment data | `wallet_address, geography, attribution_category, source, updated_at` |

### New Queries for History

**holdersHistory:**
```sql
SELECT DATE(snapshot_at) as date, 
       COUNT(DISTINCT wallet_address) as value
FROM token_holders
WHERE snapshot_at >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
GROUP BY DATE(snapshot_at)
ORDER BY date
```

**supplyHistory:**
```sql
SELECT DATE(snapshot_at) as date, 
       mint_address, 
       SUM(supply) as supply
FROM token_supply_snapshots
WHERE snapshot_at >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
GROUP BY DATE(snapshot_at), mint_address
ORDER BY date
```

---

## Response Shape

```typescript
interface AnalyticsResponse {
  stablecoins: StablecoinEntry[];
  holders: {
    totalHolders: number;
    geography: GeographyEntry[];      // From wallet_labels (real)
    attribution: AttributionEntry[];  // From wallet_labels (real)
  };
  holdersHistory: TimeSeriesEntry[];  // From token_holders (real)
  supplyHistory: Array<{              // From token_supply_snapshots (real)
    date: string;
    [symbol: string]: string | number;
  }>;
  lastUpdated: string;                // snapshot_at from cache
}

// Meta now includes freshness info
interface ResponseMeta {
  requestId: string;
  timestamp: string;
  freshness?: {
    cacheAgeSeconds: number;    // seconds since last cache write
    nextRefreshSeconds: number; // seconds until next cron run
    source: "cache";
  };
}
```

## Migration Path

### Phase 1 — Remove Mock Data (This Sprint)
1. Delete mock data generators from `analytics.ts` and `page.tsx`
2. Refactor API to only read from Databricks
3. Add cron trigger + ingestion handler
4. Configure `ANALYTICS_MINTS` env var

### Phase 2 — Historical Data Accumulation (Ongoing)
1. Each cron run appends to `token_supply_snapshots` and `token_holders`
2. Over days/weeks, real `holdersHistory` and `supplyHistory` build up
3. Dashboard charts become meaningful over time

### Phase 3 — Wallet Label Enrichment (Future)
1. Connect to a wallet labeling service
2. Update `wallet_labels` with real geography and attribution
3. Geography donut chart becomes meaningful

## Removed Files & Code

### Deleted (No Longer Needed)
- `getMockResponse()` in `analytics.ts`
- `generateHolderHistory()` in both `analytics.ts` and `page.tsx`
- `generateSupplyHistory()` in both `analytics.ts` and `page.tsx`
- `mockData` and `mockUserData` in `page.tsx`
- `?mock=true` query param
- `KNOWN_MINTS` hardcoded map

### Files to Create
- `apps/sdp-api/src/crons/analytics-ingestion.ts`

### Files to Modify
- `apps/sdp-api/wrangler.toml` — add cron trigger
- `apps/sdp-api/src/routes/data-products/analytics.ts` — remove mock, refactor to DB-only reads
- `apps/sdp-web/src/app/dashboard/analytics/page.tsx` — remove mock, error-only fallback
- `apps/sdp-web/src/app/dashboard/analytics/analytics-types.ts` — add `freshness` to meta
