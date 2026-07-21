-- ============================================================================
-- SDP Polars API — Databricks SQL Queries
-- ============================================================================
-- These queries read the Parquet data written to s3://tmp-sdp-data/ by the
-- Polars API ingestion pipeline. Run them directly in your Databricks
-- workspace using the "delta" format reader.
--
-- Usage:
--   CREATE EXTERNAL TABLE IF NOT EXISTS sdp.stablecoins
--     USING delta
--     LOCATION 's3://tmp-sdp-data/stablecoins/';
--
--   Or query directly:
--     SELECT * FROM delta.`s3://tmp-sdp-data/stablecoins/`;
-- ============================================================================

-- ── 1. Create external schemas ────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS sdp;
USE sdp;

-- ── 2. Create external tables over S3 Parquet data ────────────────────────

-- Stablecoin supply snapshots
CREATE OR REPLACE TABLE sdp.stablecoins
USING delta
LOCATION 's3://tmp-sdp-data/stablecoins/'
AS SELECT * FROM delta.`s3://tmp-sdp-data/stablecoins/`;

-- Network metrics snapshots
CREATE OR REPLACE TABLE sdp.network
USING delta
LOCATION 's3://tmp-sdp-data/network/'
AS SELECT * FROM delta.`s3://tmp-sdp-data/network/`;

-- Token registry (UUID mappings)
CREATE OR REPLACE TABLE sdp.token_registry
USING delta
LOCATION 's3://tmp-sdp-data/token-registry/'
AS SELECT * FROM delta.`s3://tmp-sdp-data/token-registry/`;

-- Token holder snapshots
CREATE OR REPLACE TABLE sdp.holders
USING delta
LOCATION 's3://tmp-sdp-data/holders/'
AS SELECT * FROM delta.`s3://tmp-sdp-data/holders/`;

-- RPC cached transfers
CREATE OR REPLACE TABLE sdp.rpc_cache
USING delta
LOCATION 's3://tmp-sdp-data/rpc-cache/'
AS SELECT * FROM delta.`s3://tmp-sdp-data/rpc-cache/`;

-- Inserted data
CREATE OR REPLACE TABLE sdp.insert_data
USING delta
LOCATION 's3://tmp-sdp-data/insert/'
AS SELECT * FROM delta.`s3://tmp-sdp-data/insert/`;


-- ── 3. Analytics Queries ──────────────────────────────────────────────────

-- 3a. Latest stablecoin supplies (most recent snapshot per token)
SELECT symbol, mint, ui_supply, date, scraped_at
FROM (
  SELECT *,
    ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY scraped_at DESC) AS rn
  FROM sdp.stablecoins
)
WHERE rn = 1
ORDER BY ui_supply DESC;


-- 3b. Daily average stablecoin supply (useful for trend analysis)
SELECT symbol, date, AVG(ui_supply) AS avg_supply
FROM sdp.stablecoins
GROUP BY symbol, date
ORDER BY symbol, date;


-- 3c. Stablecoin supply with 7-day rolling median (using Polars-style logic)
-- Databricks doesn't have MEDIAN as an aggregate, but PERCENTILE works:
SELECT symbol, date,
  PERCENTILE(ui_supply, 0.5) AS median_supply,
  AVG(ui_supply) AS mean_supply,
  MIN(ui_supply) AS min_supply,
  MAX(ui_supply) AS max_supply
FROM sdp.stablecoins
GROUP BY symbol, date
ORDER BY symbol, date;


-- 3d. Network metrics trend
SELECT date,
  MAX(total_sol_supply) AS sol_supply,
  MAX(circulating_sol_supply) AS circulating,
  AVG(tps) AS avg_tps,
  MAX(transaction_count) AS total_tx,
  MAX(epoch) AS current_epoch
FROM sdp.network
GROUP BY date
ORDER BY date DESC;


-- 3e. Token holder concentration
SELECT h.mint, t.symbol, t.name,
  MAX(CASE WHEN h.rank = 1 THEN h.percentage END) AS top1_pct,
  SUM(CASE WHEN h.rank <= 10 THEN h.percentage END) AS top10_pct,
  COUNT(*) AS holder_count
FROM sdp.holders h
LEFT JOIN sdp.token_registry t ON h.mint = t.mint
GROUP BY h.mint, t.symbol, t.name
ORDER BY top1_pct DESC;


-- 3f. Token transfer summary (most active token addresses)
SELECT mint, COUNT(*) AS transfer_count
FROM sdp.rpc_cache
GROUP BY mint
ORDER BY transfer_count DESC
LIMIT 20;


-- 3g. Combined dashboard view — latest metrics per token
WITH latest_supply AS (
  SELECT symbol, mint, ui_supply, scraped_at
  FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY scraped_at DESC) AS rn
    FROM sdp.stablecoins
  )
  WHERE rn = 1
),
network_latest AS (
  SELECT date, total_sol_supply, tps
  FROM (
    SELECT *, ROW_NUMBER() OVER (ORDER BY scraped_at DESC) AS rn
    FROM sdp.network
  )
  WHERE rn = 1
)
SELECT
  ls.symbol, ls.mint, ls.ui_supply,
  nl.total_sol_supply, nl.tps,
  ls.scraped_at
FROM latest_supply ls
CROSS JOIN network_latest nl
ORDER BY ls.ui_supply DESC;


-- 3h. Data freshness check (when was each table last updated?)
SELECT 'stablecoins' AS table_name, MAX(scraped_at) AS last_updated FROM sdp.stablecoins
UNION ALL
SELECT 'network', MAX(scraped_at) FROM sdp.network
UNION ALL
SELECT 'holders', MAX(scraped_at) FROM sdp.holders
ORDER BY last_updated DESC;
