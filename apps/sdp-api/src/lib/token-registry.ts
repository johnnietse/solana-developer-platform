/**
 * Dynamic Token Registry with Hybrid Resolution & Reverification
 * 
 * Combines 4 sources:
 * 1. ENV_CONFIG - ANALYTICS_MINTS env var (backward compat, explicit control)
 * 2. DB_REGISTRY - analytics_tokens table (manual curation, priority, metadata)
 * 3. USER_DEPLOYMENTS - issued_tokens table (auto-track platform tokens)
 * 4. EXTERNAL_DISCOVERY - Jupiter, CoinGecko, RPC reverification
 * 
 * Reverification: Cross-references all sources, validates via RPC, updates status
 */

import type { Env } from "@/types/env";
import { getDb } from "@/db";
import { queryDatabricks } from "@/lib/databricks-query";
import { rpcCall } from "@/lib/rpc-utils";

export interface TokenRegistryEntry {
    mintAddress: string;
    symbol: string;
    name: string;
    decimals: number;
    
    // Source flags
    sourceEnv: boolean;
    sourceDb: boolean;
    sourceUserDeployment: boolean;
    sourceDiscovery: boolean;
    
    // Reverification
    verificationStatus: 'pending' | 'verified' | 'failed' | 'stale';
    lastVerifiedAt: string | null;
    verificationSources: string[];
    verificationError: string | null;
    holderCountAtVerification: number | null;
    supplyAtVerification: number | null;
    
    // Metadata
    logoUri: string | null;
    coingeckoId: string | null;
    jupiterVerified: boolean;
    tags: string[];
    
    // Operational
    isActive: boolean;
    priority: number;
    minHoldersThreshold: number;
    
    // Ingestion tracking
    lastIngestedAt: string | null;
    lastIngestionStatus: 'success' | 'failed' | null;
    lastIngestionError: string | null;
    holderCount: number | null;
    supply: number | null;
    lastSlot: number | null;
    
    // Timestamps
    addedAt: string;
    updatedAt: string;
}

export interface ResolvedMint {
    mintAddress: string;
    symbol: string;
    name: string;
    decimals: number;
    sources: string[];           // Which sources contributed
    verificationStatus: string;  // Overall verification status
    priority: number;
    minHoldersThreshold: number;
    tags: string[];
}

export interface TokenVerificationUpdate {
    lastIngestedAt?: string;
    lastIngestionStatus?: 'success' | 'failed';
    lastIngestionError?: string | null;
    holderCount?: number;
    supply?: number;
    decimals?: number;
    lastSlot?: number;
    lastVerifiedAt?: string;
    verificationStatus?: 'verified' | 'failed' | 'stale';
    verificationSources?: string[];
    verificationError?: string | null;
    holderCountAtVerification?: number;
    supplyAtVerification?: number;
}

/**
 * Hybrid resolution: merges all 4 sources with deduplication
 * Priority: ENV > DB > USER_DEPLOYMENT > DISCOVERY (for conflicts)
 */
export async function resolveAnalyticsMints(env: Env): Promise<ResolvedMint[]> {
    const db = getDb(env);
    
    // 1. ENV_CONFIG - Explicit control via ANALYTICS_MINTS
    const envMints = (env.ANALYTICS_MINTS ?? "")
        .split(",")
        .map(m => m.trim())
        .filter(m => m.length > 0);
    
    // 2. DB_REGISTRY - Curated tokens with metadata
    const dbTokens = await db.queryMany<{
        mint_address: string;
        symbol: string;
        name: string;
        decimals: number;
        source_env: boolean;
        source_db: boolean;
        source_user_deployment: boolean;
        source_discovery: boolean;
        verification_status: string;
        last_verified_at: string | null;
        verification_sources: string[];
        verification_error: string | null;
        holder_count_at_verification: number | null;
        supply_at_verification: number | null;
        logo_uri: string | null;
        coingecko_id: string | null;
        jupiter_verified: boolean;
        tags: string[];
        is_active: boolean;
        priority: number;
        min_holders_threshold: number;
    }>(
        `SELECT mint_address, symbol, name, decimals,
                source_env, source_db, source_user_deployment, source_discovery,
                verification_status, last_verified_at, verification_sources,
                verification_error, holder_count_at_verification, supply_at_verification,
                logo_uri, coingecko_id, jupiter_verified, tags,
                is_active, priority, min_holders_threshold
         FROM analytics_tokens
         WHERE is_active = true
         ORDER BY priority DESC, symbol ASC`
    );
    
    // 3. USER_DEPLOYMENTS - Auto-track platform tokens
    const userTokens = await db.queryMany<{ mint_address: string }>(
        `SELECT DISTINCT mint_address 
         FROM issued_tokens 
         WHERE status = 'deployed' AND mint_address IS NOT NULL`
    );
    
    // Merge all sources with deduplication
    const merged = new Map<string, ResolvedMint>();
    
    const upsert = (mint: string, source: string, data?: Partial<ResolvedMint>) => {
        const existing = merged.get(mint);
        const sources = existing ? [...existing.sources, source] : [source];
        
        merged.set(mint, {
            mintAddress: mint,
            symbol: data?.symbol ?? existing?.symbol ?? mint.slice(0, 8),
            name: data?.name ?? existing?.name ?? `Token ${mint.slice(0, 8)}`,
            decimals: data?.decimals ?? existing?.decimals ?? 9,
            sources: [...new Set(sources)], // deduplicate
            verificationStatus: data?.verificationStatus ?? existing?.verificationStatus ?? 'pending',
            priority: data?.priority ?? existing?.priority ?? 50,
            minHoldersThreshold: data?.minHoldersThreshold ?? existing?.minHoldersThreshold ?? 100,
            tags: [...new Set([...(existing?.tags ?? []), ...(data?.tags ?? [])])],
        });
    };
    
    // 1. ENV_CONFIG (highest priority for explicit control)
    for (const mint of envMints) {
        upsert(mint, 'env');
    }
    
    // 2. DB_REGISTRY (rich metadata)
    for (const token of dbTokens) {
        upsert(token.mint_address, 'db', {
            symbol: token.symbol,
            name: token.name,
            decimals: token.decimals,
            verificationStatus: token.verification_status,
            priority: token.priority,
            minHoldersThreshold: token.min_holders_threshold,
            tags: token.tags,
        });
    }
    
    // 3. USER_DEPLOYMENTS (auto-track platform tokens)
    for (const { mint_address } of userTokens) {
        upsert(mint_address, 'user_deployment');
    }
    
    // 4. DISCOVERY (already in DB with source_discovery=true)
    // Already included in dbTokens query above
    
    // Convert to array, sort by priority
    return Array.from(merged.values())
        .sort((a, b) => b.priority - a.priority);
}

/**
 * Get full registry entries for detailed operations
 */
export async function getTokenRegistry(env: Env): Promise<TokenRegistryEntry[]> {
    const db = getDb(env);
    return db.queryMany<TokenRegistryEntry>(
        `SELECT * FROM analytics_tokens WHERE is_active = true ORDER BY priority DESC, symbol ASC`
    );
}

/**
 * Get tokens needing reverification (stale > 24h, failed, or never verified)
 */
export async function getTokensNeedingReverification(env: Env): Promise<TokenRegistryEntry[]> {
    const db = getDb(env);
    return db.queryMany<TokenRegistryEntry>(
        `SELECT * FROM analytics_tokens 
         WHERE is_active = true 
           AND (verification_status IN ('pending', 'failed', 'stale')
                OR last_verified_at IS NULL
                OR last_verified_at < NOW() - INTERVAL '24 hours')
         ORDER BY priority DESC`
    );
}

/**
 * Get token metadata from registry (falls back to known mints)
 */
export async function getTokenMetadata(env: Env, mintAddress: string): Promise<{ symbol: string; name: string; decimals: number } | null> {
    const db = getDb(env);
    const token = await db.queryOne<{
        symbol: string;
        name: string;
        decimals: number;
    }>(
        `SELECT symbol, name, decimals FROM analytics_tokens WHERE mint_address = $1 AND is_active = true`,
        [mintAddress]
    );
    
    if (token) {
        return { symbol: token.symbol, name: token.name, decimals: token.decimals };
    }
    
    // Fallback to known mints
    const KNOWN_MINTS: Record<string, { symbol: string; name: string; decimals: number }> = {
        "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr": { symbol: "USDC", name: "USD Coin", decimals: 6 },
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": { symbol: "USDC", name: "USD Coin", decimals: 6 },
        "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": { symbol: "USDT", name: "Tether USD", decimals: 6 },
        "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPXg4gQzNBP": { symbol: "PYUSD", name: "PayPal USD", decimals: 6 },
        "So11111111111111111111111111111111111111112": { symbol: "SOL", name: "Wrapped SOL", decimals: 9 },
    };
    
    return KNOWN_MINTS[mintAddress] ?? null;
}

/**
 * Update token verification status after reverification
 */
export async function updateTokenVerification(
    env: Env,
    mintAddress: string,
    update: TokenVerificationUpdate
): Promise<void> {
    const db = getDb(env);
    
    const fields: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;
    
    if (update.lastIngestedAt !== undefined) {
        fields.push(`last_ingested_at = $${paramIndex++}`);
        params.push(update.lastIngestedAt);
    }
    if (update.lastIngestionStatus !== undefined) {
        fields.push(`last_ingestion_status = $${paramIndex++}`);
        params.push(update.lastIngestionStatus);
    }
    if (update.lastIngestionError !== undefined) {
        fields.push(`last_ingestion_error = $${paramIndex++}`);
        params.push(update.lastIngestionError);
    }
    if (update.holderCount !== undefined) {
        fields.push(`holder_count = $${paramIndex++}`);
        params.push(update.holderCount);
    }
    if (update.supply !== undefined) {
        fields.push(`supply = $${paramIndex++}`);
        params.push(update.supply);
    }
    if (update.decimals !== undefined) {
        fields.push(`decimals = $${paramIndex++}`);
        params.push(update.decimals);
    }
    if (update.lastSlot !== undefined) {
        fields.push(`last_slot = $${paramIndex++}`);
        params.push(update.lastSlot);
    }
    if (update.lastVerifiedAt !== undefined) {
        fields.push(`last_verified_at = $${paramIndex++}`);
        params.push(update.lastVerifiedAt);
    }
    if (update.verificationStatus !== undefined) {
        fields.push(`verification_status = $${paramIndex++}`);
        params.push(update.verificationStatus);
    }
    if (update.verificationSources !== undefined) {
        fields.push(`verification_sources = $${paramIndex++}`);
        params.push(update.verificationSources);
    }
    if (update.verificationError !== undefined) {
        fields.push(`verification_error = $${paramIndex++}`);
        params.push(update.verificationError);
    }
    if (update.holderCountAtVerification !== undefined) {
        fields.push(`holder_count_at_verification = $${paramIndex++}`);
        params.push(update.holderCountAtVerification);
    }
    if (update.supplyAtVerification !== undefined) {
        fields.push(`supply_at_verification = $${paramIndex++}`);
        params.push(update.supplyAtVerification);
    }
    
    if (fields.length === 0) return;
    
    fields.push(`updated_at = NOW()`);
    params.push(mintAddress);
    
    await db.execute(
        `UPDATE analytics_tokens SET ${fields.join(", ")} WHERE mint_address = $${paramIndex}`,
        params
    );
}

/**
 * Register or update token from user deployment
 */
export async function registerUserToken(
    env: Env,
    mintAddress: string,
    symbol?: string,
    name?: string,
    decimals?: number
): Promise<void> {
    const db = getDb(env);
    
    await db.execute(
        `INSERT INTO analytics_tokens (mint_address, symbol, name, decimals, source_user_deployment, is_active, priority, tags, verification_status)
         VALUES ($1, $2, $3, $4, true, true, 50, ARRAY['user-deployed'], 'pending')
         ON CONFLICT (mint_address) DO UPDATE SET
            source_user_deployment = true,
            is_active = true,
            symbol = COALESCE($2, analytics_tokens.symbol),
            name = COALESCE($3, analytics_tokens.name),
            decimals = COALESCE($4, analytics_tokens.decimals),
            updated_at = NOW()`,
        [mintAddress, symbol ?? null, name ?? null, decimals ?? null]
    );
}

/**
 * Register or update token from external discovery
 */
export async function registerDiscoveredToken(
    env: Env,
    mintAddress: string,
    symbol: string,
    name: string,
    decimals: number,
    source: 'jupiter' | 'coingecko' | 'rpc' | 'manual',
    metadata?: { logoUri?: string; coingeckoId?: string; tags?: string[] }
): Promise<void> {
    const db = getDb(env);
    
    await db.execute(
        `INSERT INTO analytics_tokens (mint_address, symbol, name, decimals, source_discovery, is_active, priority, tags, verification_status, logo_uri, coingecko_id, jupiter_verified)
         VALUES ($1, $2, $3, $4, true, true, 50, ARRAY['discovered'], 'pending', $5, $6, $7)
         ON CONFLICT (mint_address) DO UPDATE SET
            source_discovery = true,
            is_active = true,
            symbol = COALESCE($2, analytics_tokens.symbol),
            name = COALESCE($3, analytics_tokens.name),
            decimals = COALESCE($4, analytics_tokens.decimals),
            logo_uri = COALESCE($5, analytics_tokens.logo_uri),
            coingecko_id = COALESCE($6, analytics_tokens.coingecko_id),
            jupiter_verified = COALESCE($7, analytics_tokens.jupiter_verified),
            tags = array_cat(analytics_tokens.tags, ARRAY['discovered']),
            updated_at = NOW()`,
        [mintAddress, symbol, name, decimals, metadata?.logoUri ?? null, metadata?.coingeckoId ?? null, source === 'jupiter']
    );
}

/**
 * Get all active tokens for ingestion (used by analytics-ingestion cron)
 */
export async function getActiveMintsForIngestion(env: Env): Promise<string[]> {
    const mints = await resolveAnalyticsMints(env);
    return mints.map(m => m.mintAddress);
}

/**
 * Sync user-deployed tokens to registry (exported for cron)
 */
export async function syncUserDeployments(env: Env): Promise<{ added: number; updated: number }> {
    return syncUserDeployments(env);
}