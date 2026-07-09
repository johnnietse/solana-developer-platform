-- Analytics Token Registry with Reverification Support
-- Combines: env config, DB registry, user deployments, external discovery
-- Includes reverification fields for cross-source validation

CREATE TABLE IF NOT EXISTS analytics_tokens (
    mint_address TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    name TEXT NOT NULL,
    decimals INTEGER DEFAULT 9,
    
    -- Source tracking (which approach added this token)
    source_env BOOLEAN DEFAULT false,           -- From ANALYTICS_MINTS env var
    source_db BOOLEAN DEFAULT false,            -- Manually added to DB
    source_user_deployment BOOLEAN DEFAULT false, -- From issued_tokens
    source_discovery BOOLEAN DEFAULT false,     -- From external discovery (Jupiter, etc.)
    
    -- Reverification tracking (cross-source validation)
    last_verified_at TIMESTAMPTZ,
    verification_sources TEXT[] DEFAULT '{}',   -- Which sources confirmed this token
    verification_status TEXT DEFAULT 'pending', -- 'pending', 'verified', 'failed', 'stale'
    verification_error TEXT,
    holder_count_at_verification BIGINT,
    supply_at_verification NUMERIC,
    
    -- Token metadata
    logo_uri TEXT,
    coingecko_id TEXT,
    jupiter_verified BOOLEAN DEFAULT false,
    tags TEXT[] DEFAULT '{}',                   -- 'stablecoin', 'wrapped', 'governance', etc.
    
    -- Operational
    is_active BOOLEAN DEFAULT true,
    priority INTEGER DEFAULT 50,                -- Higher = ingest first (rate limit protection)
    min_holders_threshold INTEGER DEFAULT 100,  -- Skip if below this
    
    -- Timestamps
    added_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    last_ingested_at TIMESTAMPTZ
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_analytics_tokens_active ON analytics_tokens (is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_analytics_tokens_priority ON analytics_tokens (priority DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_tokens_verification ON analytics_tokens (verification_status);
CREATE INDEX IF NOT EXISTS idx_analytics_tokens_source ON analytics_tokens (source_env, source_db, source_user_deployment, source_discovery);

-- Trigger for updated_at
CREATE TRIGGER update_analytics_tokens_updated_at
    BEFORE UPDATE ON analytics_tokens
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Seed with known stablecoins (Option B defaults + major tokens)
INSERT INTO analytics_tokens (mint_address, symbol, name, decimals, source_env, source_db, is_active, priority, tags, verification_status) VALUES
    ('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPXg4gQzNBP', 'PYUSD', 'PayPal USD', 6, true, true, true, 100, ARRAY['stablecoin'], 'verified'),
    ('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'USDC', 'USD Coin', 6, false, true, true, 100, ARRAY['stablecoin'], 'verified'),
    ('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'USDT', 'Tether USD', 6, false, true, true, 90, ARRAY['stablecoin'], 'verified'),
    ('So11111111111111111111111111111111111111112', 'SOL', 'Wrapped SOL', 9, false, true, true, 80, ARRAY['wrapped', 'native'], 'verified')
ON CONFLICT (mint_address) DO UPDATE SET
    source_env = EXCLUDED.source_env,
    source_db = EXCLUDED.source_db,
    updated_at = NOW();

-- View for easy querying of active tokens with reverification status
CREATE OR REPLACE VIEW analytics_tokens_active AS
SELECT 
    mint_address,
    symbol,
    name,
    decimals,
    source_env,
    source_db,
    source_user_deployment,
    source_discovery,
    verification_status,
    last_verified_at,
    verification_sources,
    holder_count_at_verification,
    supply_at_verification,
    priority,
    min_holders_threshold,
    tags,
    jupiter_verified,
    last_ingested_at
FROM analytics_tokens
WHERE is_active = true
ORDER BY priority DESC, symbol ASC;

-- View for tokens needing reverification (stale > 24h or failed)
CREATE OR REPLACE VIEW analytics_tokens_needing_reverification AS
SELECT *
FROM analytics_tokens
WHERE is_active = true
  AND (
    verification_status IN ('pending', 'failed', 'stale')
    OR last_verified_at IS NULL
    OR last_verified_at < NOW() - INTERVAL '24 hours'
  )
ORDER BY priority DESC;