-- ============================================================================
-- SDP Polars API — Databricks External Tables
-- ============================================================================
-- Run these in your Databricks workspace to create External Tables over the
-- Delta Lake data written to S3 by the Polars API ingestion pipeline.
--
-- After creating these tables, you can query them with standard SQL:
--   SELECT * FROM sdp.stablecoins ORDER BY scraped_at DESC;
--
-- Delta paths follow the convention:
--   s3://tmp-sdp-data/dev/mlh/sdp_data/{table_name}/
-- ============================================================================

-- ── 1. Create schema ────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS sdp;
USE sdp;

-- ── 2. Create external tables over Delta Lake paths ────────────────────

-- Stablecoin supply snapshots (USDC, PYUSD on devnet)
CREATE OR REPLACE TABLE sdp.stablecoins
USING delta
LOCATION 's3://tmp-sdp-data/dev/mlh/sdp_data/stablecoins/';

-- Network metrics (TPS, SOL supply, epoch, slot, etc.)
CREATE OR REPLACE TABLE sdp.network
USING delta
LOCATION 's3://tmp-sdp-data/dev/mlh/sdp_data/network/';

-- Token holder snapshots (top holders per mint)
CREATE OR REPLACE TABLE sdp.holders
USING delta
LOCATION 's3://tmp-sdp-data/dev/mlh/sdp_data/holders/';

-- SOL whales (largest accounts, via validators proxy on devnet)
CREATE OR REPLACE TABLE sdp.whales
USING delta
LOCATION 's3://tmp-sdp-data/dev/mlh/sdp_data/whales/';

-- Validator set (current + delinquent with stake, commission, votes)
CREATE OR REPLACE TABLE sdp.validators
USING delta
LOCATION 's3://tmp-sdp-data/dev/mlh/sdp_data/validators/';

-- WebSocket real-time events (token transfers, account changes)
CREATE OR REPLACE TABLE sdp.events
USING delta
LOCATION 's3://tmp-sdp-data/dev/mlh/sdp_data/events/';


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
SELECT mint,
  MAX(CASE WHEN rank = 1 THEN ui_amount END) AS top1_balance,
  SUM(CASE WHEN rank <= 10 THEN ui_amount END) AS top10_total,
  COUNT(*) AS holder_count
FROM sdp.holders
GROUP BY mint
ORDER BY top1_balance DESC
LIMIT 20;


-- 3f. SOL whale ranking (largest staked validators / accounts)
SELECT address, ui_balance, source, scraped_at
FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY source ORDER BY ui_balance DESC) AS rn
  FROM sdp.whales
)
WHERE rn = 1
ORDER BY ui_balance DESC;


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
UNION ALL
SELECT 'whales', MAX(scraped_at) FROM sdp.whales
UNION ALL
SELECT 'validators', MAX(scraped_at) FROM sdp.validators
UNION ALL
SELECT 'events', MAX(scraped_at) FROM sdp.events
ORDER BY last_updated DESC;
