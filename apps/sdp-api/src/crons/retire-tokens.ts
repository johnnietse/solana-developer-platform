/**
 * Auto-Dead-Token Retirement Cron
 * 
 * Runs daily to:
 * 1. Retire tokens with 0 holders + 0 supply for 30+ days
 * 2. Flag rug pulls (99% supply drop in 1 hour)
 * 3. Flag stale tokens (no ingestion for 7 days)
 * 3. Update verification status
 */

import type { Env } from "@/types/env";
import { getDb } from "@/db";
import { queryDatabricks } from "@/lib/databricks-query";
import { resolveAnalyticsMints } from "@/lib/token-registry";

interface RetirementResult {
    retired: number;
    flaggedRug: number;
    flaggedStale: number;
    errors: string[];
}

interface TokenStatus {
    mint_address: string;
    symbol: string;
    holder_count: number;
    total_supply: number;
    last_ingested_at: string;
    last_ingested_at_db: string | null;
    supply_1h_ago: number | null;
    supply_24h_ago: number | null;
}

/**
 * Check token status from Databricks
 */
async function getTokenStatuses(env: Env): Promise<TokenStatus[]> {
    const mints = await resolveAnalyticsMints(env);
    if (mints.length === 0) return [];

    const placeholders = mints.map((_, i) => `:${i + 1}`).join(", ");
    
    // Get current holder count, supply, and last ingestion time
    const current = await queryDatabricks(env,
        `SELECT 
            mint_address,
            holder_count,
            total_supply,
            snapshot_at
         FROM workspace.default.token_holders_latest
         WHERE mint_address IN (${placeholders})`,
        mints
    );

    // Get supply 1 hour ago (for rug detection)
    const supply1h = await queryDatabricks(env,
        `SELECT mint_address, SUM(supply) as supply_1h_ago
         FROM workspace.default.token_supply_snapshots
         WHERE mint_address IN (${placeholders})
           AND snapshot_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
           AND snapshot_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE)
         GROUP BY mint_address`,
        mints
    );

    // Get supply 24h ago (for trend analysis)
    const supply24h = await queryDatabricks(env,
        `SELECT mint_address, SUM(supply) as supply_24h_ago
         FROM workspace.default.token_supply_snapshots
         WHERE mint_address IN (${placeholders})
           AND snapshot_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
           AND snapshot_at < DATE_SUB(NOW(), INTERVAL 1 HOUR)
         GROUP BY mint_address`,
        mints
    );

    // Get last ingestion time from analytics_cache
    const lastIngested = await queryDatabricks(env,
        `SELECT mint_address, MAX(snapshot_at) as last_ingested_at
         FROM workspace.default.analytics_cache
         WHERE mint_address IN (${placeholders})
         GROUP BY mint_address`,
        mints
    );

    // Merge data
    const supply1hMap = new Map(supply1h?.map((r: any) => [r[0], r[1]]) ?? []);
    const supply24hMap = new Map(supply24h?.map((r: any) => [r[0], r[1]]) ?? []);
    const lastIngestedMap = new Map(lastIngested?.map((r: any) => [r[0], r[1]]) ?? []);

    return (current ?? []).map((row: any) => ({
        mint_address: row[0],
        symbol: "", // Will be filled from registry
        holder_count: Number(row[1]) || 0,
        total_supply: Number(row[2]) || 0,
        last_ingested_at: row[3],
        supply_1h_ago: supply1hMap.get(row[0]) ? Number(supply1hMap.get(row[0])) : null,
        supply_24h_ago: supply24hMap.get(row[0]) ? Number(supply24hMap.get(row[0])) : null,
        last_ingested_at_db: lastIngestedMap.get(row[0]) ?? null,
    }));
}

/**
 * Check if token should be retired (0 holders + 0 supply for 30+ days)
 */
function shouldRetire(token: TokenStatus, retirementDays: number = 30): boolean {
    if (token.holder_count > 0) return false;
    if (token.total_supply > 0) return false;
    
    const lastIngested = token.last_ingested_at;
    if (!lastIngested) return false; // Never ingested, don't retire yet
    
    const daysSinceIngestion = (Date.now() - new Date(lastIngested).getTime()) / (1000 * 60 * 60 * 24);
    return daysSinceIngestion >= retirementDays;
}

/**
 * Check for rug pull (99% supply drop in 1 hour)
 */
function isRugPull(token: TokenStatus, threshold: number = 0.99): boolean {
    if (!token.supply_1h_ago || token.supply_1h_ago === 0) return false;
    if (token.total_supply === 0) return false;
    
    const dropRatio = 1 - (token.total_supply / token.supply_1h_ago);
    return dropRatio >= threshold;
}

/**
 * Check if token is stale (no ingestion for 7 days)
 */
function isStale(token: TokenStatus, staleDays: number = 7): boolean {
    const lastIngested = token.last_ingested_at;
    if (!lastIngested) return false;
    
    const daysSinceIngestion = (Date.now() - new Date(lastIngested).getTime()) / (1000 * 60 * 60 * 24);
    return daysSinceIngestion >= staleDays;
}

/**
 * Main retirement handler
 */
export async function handleTokenRetirement(env: Env): Promise<Response> {
    const startTime = Date.now();
    const result: RetirementResult = {
        retired: 0,
        flaggedRug: 0,
        flaggedStale: 0,
        errors: [],
    };

    try {
        const db = getDb(env);
        const tokens = await getTokenStatuses(env);
        
        // Get symbols from registry
        const registry = await db.queryMany<{ mint_address: string; symbol: string }>(
            `SELECT mint_address, symbol FROM analytics_tokens WHERE is_active = true`
        );
        const symbolMap = new Map(registry.map(r => [r.mint_address, r.symbol]));
        
        for (const token of tokens) {
            token.symbol = symbolMap.get(token.mint_address) ?? token.mint_address.slice(0, 8);
            
            try {
                // Check for rug pull
                if (isRugPull(token)) {
                    await flagRugPull(env, token);
                    result.flaggedRug++;
                    continue;
                }

                // Check for stale
                if (isStale(token)) {
                    await flagStale(env, token);
                    result.flaggedStale++;
                    continue;
                }

                // Check for retirement
                if (shouldRetire(token)) {
                    await retireToken(env, token);
                    result.retired++;
                }
            } catch (error) {
                result.errors.push(`${token.mint_address}: ${error}`);
            }
        }

        return new Response(JSON.stringify({
            success: true,
            result,
            durationMs: Date.now() - startTime,
            timestamp: new Date().toISOString(),
        }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    } catch (error) {
        return new Response(JSON.stringify({
            success: false,
            error: String(error),
            timestamp: new Date().toISOString(),
        }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
        });
    }
}

async function flagRugPull(env: Env, token: any): Promise<void> {
    const db = getDb(env);
    await db.execute(
        `UPDATE analytics_tokens SET
            verification_status = 'rug_flagged',
            verification_error = 'Rug pull detected: 99%+ supply drop in 1 hour',
            tags = array_cat(tags, ARRAY['rug-flagged']),
            updated_at = NOW()
         WHERE mint_address = $1`,
        [token.mint_address]
    );
    
    // Also log to audit table
    await logRetirementEvent(env, token.mint_address, 'rug_flagged', {
        supply_before: token.supply_1h_ago,
        supply_after: token.total_supply,
        drop_ratio: 1 - (token.total_supply / token.supply_1h_ago),
    });
}

async function flagStale(env: Env, token: any): Promise<void> {
    const db = getDb(env);
    await db.execute(
        `UPDATE analytics_tokens SET
            verification_status = 'stale',
            verification_error = 'No ingestion for 7+ days',
            tags = array_cat(tags, ARRAY['stale']),
            updated_at = NOW()
         WHERE mint_address = $1`,
        [token.mint_address]
    );
    
    await logRetirementEvent(env, token.mint_address, 'stale_flagged', {
        last_ingested: token.last_ingested_at_db,
    });
}

async function retireToken(env: Env, token: any): Promise<void> {
    const db = getDb(env);
    await db.execute(
        `UPDATE analytics_tokens SET
            is_active = false,
            verification_status = 'retired',
            verification_error = 'Retired: 0 holders + 0 supply for 30+ days',
            tags = array_cat(tags, ARRAY['retired']),
            updated_at = NOW()
         WHERE mint_address = $1`,
        [token.mint_address]
    );
    
    await logRetirementEvent(env, token.mint_address, 'retired', {
        last_ingested: token.last_ingested_at_db,
        days_inactive: (Date.now() - new Date(token.last_ingested_at_db).getTime()) / (1000 * 60 * 60 * 24),
    });
}

async function logRetirementEvent(env: Env, mintAddress: string, event: string, details: any): Promise<void> {
    const db = getDb(env);
    await db.execute(
        `INSERT INTO analytics_token_events (mint_address, event_type, details, created_at)
         VALUES ($1, $2, $3, NOW())`,
        [mintAddress, event, JSON.stringify(details)]
    );
}

export async function handleTokenRetirementScheduled(env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleTokenRetirement(env));
}