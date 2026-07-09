# Analytics Databricks Enrichment Design

**Date**: 2026-07-08
**Status**: Approved

## Overview

Build a real RPC-powered analytics pipeline that stores on-chain data in Databricks tables and serves it through the SDP API to the analytics dashboard. No synthetic data — geography and attribution remain "Unknown" until real enrichment sources are available.

## Architecture

```
Solana Devnet RPC
      │
      ▼
Ingestion Script ──► Databricks Tables ──► SDP API ──► Dashboard
(scripts/ingest-analytics.mjs)   │              │
                                 │              └── GET /v1/data-products/analytics
                                 │
                                 └── workspace.default.token_holders
                                     workspace.default.token_supply_snapshots
                                     workspace.default.analytics_cache
```

## Databricks Tables

All tables live in `workspace.default` schema.

### `token_holders`

Stores real wallet addresses and balances for USDC devnet holders.

| Column | Type | Description |
|--------|------|-------------|
| `mint_address` | STRING | USDC mint address |
| `wallet_address` | STRING | Token account owner address |
| `balance` | DOUBLE | Token balance (adjusted for decimals) |
| `slot` | BIGINT | Solana slot when snapshot was taken |
| `snapshot_at` | TIMESTAMP | When this record was ingested |

### `token_supply_snapshots`

Historical supply records.

| Column | Type | Description |
|--------|------|-------------|
| `mint_address` | STRING | USDC mint address |
| `supply` | DOUBLE | Total supply (adjusted for decimals) |
| `decimals` | INT | Token decimals |
| `slot` | BIGINT | Solana slot |
| `snapshot_at` | TIMESTAMP | When this snapshot was taken |

### `analytics_cache`

Pre-computed analytics response for fast API serving.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INT | Primary key |
| `response_json` | STRING | JSON-serialized AnalyticsResponse |
| `holder_count` | BIGINT | Denormalized for quick queries |
| `total_supply` | DOUBLE | Denormalized for quick queries |
| `snapshot_at` | TIMESTAMP | When this cache entry was created |

## Ingestion Script

`scripts/ingest-analytics.mjs` — Node.js script that:

1. Queries devnet RPC for USDC token accounts (`getProgramAccounts`)
2. Parses wallet addresses and balances
3. Queries `getTokenSupply` for current supply
4. Inserts/upserts into Databricks tables via the Databricks REST API
5. Computes and caches the analytics response

## SDP API Changes

Modify `apps/sdp-api/src/routes/data-products/analytics.ts`:

- Add Databricks query via REST API (using env-configured credentials)
- Query `analytics_cache` for the latest response
- Fall back to direct RPC query if Databricks is unavailable
- Geography: `[{ region: "Unknown", percentage: 100, holderCount }]`
- Attribution: `[{ category: "unknown", percentage: 100, holderCount }]`

## Data Freshness

- Ingestion runs on-demand or via cron
- `analytics_cache` is refreshed each ingestion cycle
- Dashboard shows `lastUpdated` timestamp from cache

## Future Phases

- **Phase 2b**: Real wallet labels from Helius/TRM/Chainalysis → populate geography + attribution
- **Phase 3**: Historical snapshots → real time-series data for holdersHistory + supplyHistory
- **Phase 4**: Automated cron-based ingestion