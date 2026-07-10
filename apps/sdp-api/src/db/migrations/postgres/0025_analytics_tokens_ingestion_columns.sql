-- Analytics ingestion metadata columns + devnet-local registry tuning
--
-- 1. Adds the ingestion-tracking columns that updateTokenVerification()
--    writes but migration 0024 omitted. Without these, every ingestion run
--    crashes with "column ... of relation analytics_tokens does not exist".
-- 2. Deactivates the mainnet seed mints (PYUSD/USDC/USDT/SOL) which cannot
--    be resolved against the local devnet RPC, and activates the devnet USDC
--    mint we actually deployed so local analytics ingestion succeeds.

-- ── 1. Missing ingestion columns ───────────────────────────────────────────
ALTER TABLE analytics_tokens ADD COLUMN IF NOT EXISTS last_ingestion_status TEXT;
ALTER TABLE analytics_tokens ADD COLUMN IF NOT EXISTS last_ingestion_error TEXT;
ALTER TABLE analytics_tokens ADD COLUMN IF NOT EXISTS holder_count BIGINT;
ALTER TABLE analytics_tokens ADD COLUMN IF NOT EXISTS supply NUMERIC;
ALTER TABLE analytics_tokens ADD COLUMN IF NOT EXISTS decimals INTEGER;
ALTER TABLE analytics_tokens ADD COLUMN IF NOT EXISTS last_slot BIGINT;

-- ── 2. Registry tuning for local devnet ───────────────────────────────────
-- Mainnet mints can't be resolved on devnet RPC; stop ingesting them locally.
UPDATE analytics_tokens
SET is_active = false, updated_at = NOW()
WHERE mint_address IN (
    '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPXg4gQzNBP', -- PYUSD (mainnet)
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', -- USDC (mainnet)
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', -- USDT (mainnet)
    'So11111111111111111111111111111111111111112'  -- SOL (mainnet)
);

-- Activate the devnet USDC mint we deployed so local ingestion has a
-- devnet-resolvable target and populates analytics_cache.
INSERT INTO analytics_tokens (
    mint_address, symbol, name, decimals,
    source_env, source_db, is_active, priority, tags, verification_status
) VALUES (
    '9fxDZ7rBCNdHureibbAVa6J73srhCYWoKYZWwegXe72Z',
    'USDC', 'USD Coin', 6,
    true, true, true, 100, ARRAY['stablecoin'], 'verified'
)
ON CONFLICT (mint_address) DO UPDATE SET
    is_active = true,
    source_env = true,
    source_db = true,
    symbol = COALESCE(EXCLUDED.symbol, analytics_tokens.symbol),
    name = COALESCE(EXCLUDED.name, analytics_tokens.name),
    priority = GREATEST(EXCLUDED.priority, analytics_tokens.priority),
    updated_at = NOW();
