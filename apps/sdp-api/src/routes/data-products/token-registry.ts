/**
 * Token Registry Observability API (Read-Only)
 * 
 * Provides visibility into the automatic token registry
 * No write operations - everything is automatic
 * Useful for debugging, monitoring, and dashboards
 */

import { Hono } from "hono";
import type { Env } from "@/types/env";
import { getDb } from "@/db";
import { resolveAnalyticsMints, getTokenRegistry, getTokensNeedingReverification, getTokenMetadata } from "@/lib/token-registry";

const tokenRegistry = new Hono<{ Bindings: Env }>();

// GET /v1/data-products/tokens - List all tracked tokens with status
tokenRegistry.get("/", async (c) => {
    const requestId = c.get("requestId");
    const env = c.env;
    const db = getDb(env);

    try {
        // Query parameters
        const status = c.req.query("status"); // verified, pending, failed, stale, rug_flagged, retired
        const source = c.req.query("source"); // env, db, user_deployment, discovery
        const limit = parseInt(c.req.query("limit") ?? "100");
        const offset = parseInt(c.req.query("offset") ?? "0");
        const sort = c.req.query("sort") ?? "priority"; // priority, symbol, last_verified_at
        const order = c.req.query("order") ?? "desc";

        let whereClause = "WHERE is_active = true";
        const params: unknown[] = [];

        if (status) {
            params.push(status);
            whereClause += ` AND verification_status = $${params.length}`;
        }
        if (source) {
            const sourceCol = `source_${source}`;
            whereClause += ` AND ${sourceCol} = true`;
        }

        const orderBy = `${sort} ${order.toUpperCase()}`;
        params.push(limit, offset);

        const tokens = await db.queryMany<{
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
            last_ingested_at: string | null;
            last_ingestion_status: string | null;
            last_ingestion_error: string | null;
            holder_count: number | null;
            supply: number | null;
            last_slot: number | null;
            added_at: string;
            updated_at: string;
        }>(
            `SELECT * FROM analytics_tokens ${whereClause} ORDER BY ${sort} ${order.toUpperCase()} LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
        );

        const total = await db.queryOne<{ count: number }>(
            `SELECT COUNT(*) as count FROM analytics_tokens ${whereClause}`,
            params.slice(0, -2)
        );

        return c.json({
            data: tokens,
            meta: {
                requestId,
                timestamp: new Date().toISOString(),
                pagination: {
                    total: total?.count ?? 0,
                    limit,
                    offset,
                },
            },
        });
    } catch (error) {
        return c.json({
            data: null,
            meta: { requestId, timestamp: new Date().toISOString(), error: String(error) },
        }, 500);
    }
});

// GET /v1/data-products/tokens/:mint - Get single token details
tokenRegistry.get("/:mint", async (c) => {
    const requestId = c.get("requestId");
    const mint = c.req.param("mint");
    const env = c.env;
    const db = getDb(env);

    try {
        const token = await db.queryOne<{
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
            last_ingested_at: string | null;
            last_ingestion_status: string | null;
            last_ingestion_error: string | null;
            holder_count: number | null;
            supply: number | null;
            last_slot: number | null;
            added_at: string;
            updated_at: string;
        }>(
            `SELECT * FROM analytics_tokens WHERE mint_address = $1`,
            [mint]
        );

        if (!token) {
            return c.json({
                data: null,
                meta: { requestId, timestamp: new Date().toISOString(), error: "Token not found" },
            }, 404);
        }

        // Get recent ingestion history
        const history = await getDb(c.env).queryMany<{
            snapshot_at: string;
            holder_count: number;
            total_supply: number;
            last_ingestion_status: string;
            last_ingestion_error: string | null;
        }>(
            `SELECT snapshot_at, holder_count, total_supply, last_ingestion_status, last_ingestion_error
             FROM analytics_token_history
             WHERE mint_address = $1
             ORDER BY snapshot_at DESC
             LIMIT 50`,
            [mint]
        );

        return c.json({
            data: { ...token, history },
            meta: { requestId, timestamp: new Date().toISOString() },
        });
    } catch (error) {
        return c.json({
            data: null,
            meta: { requestId, timestamp: new Date().toISOString(), error: String(error) },
        }, 500);
    }
});

// GET /v1/data-products/tokens/stats/summary - Registry summary stats
tokenRegistry.get("/stats/summary", async (c) => {
    const requestId = c.get("requestId");
    const db = getDb(c.env);

    try {
        const stats = await db.queryOne<{
            total: number;
            active: number;
            verified: number;
            pending: number;
            failed: number;
            stale: number;
            rug_flagged: number;
            retired: number;
            retired_30d: number;
            by_source_env: number;
            by_source_db: number;
            by_source_user: number;
            by_source_discovery: number;
        }>(
            `SELECT 
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE is_active) as active,
                COUNT(*) FILTER (WHERE is_active AND verification_status = 'verified') as verified,
                COUNT(*) FILTER (WHERE is_active AND verification_status = 'pending') as pending,
                COUNT(*) FILTER (WHERE is_active AND verification_status = 'failed') as failed,
                COUNT(*) FILTER (WHERE is_active AND verification_status = 'stale') as stale,
                COUNT(*) FILTER (WHERE verification_status = 'rug_flagged') as rug_flagged,
                COUNT(*) FILTER (WHERE verification_status = 'retired') as retired,
                COUNT(*) FILTER (WHERE verification_status = 'retired' AND updated_at > NOW() - INTERVAL '30 days') as retired_30d,
                COUNT(*) FILTER (WHERE source_env) as by_source_env,
                COUNT(*) FILTER (WHERE source_db) as by_source_db,
                COUNT(*) FILTER (WHERE source_user_deployment) as by_source_user,
                COUNT(*) FILTER (WHERE source_discovery) as by_source_discovery
             FROM analytics_tokens`
        );

        // Get recent events
        const recentEvents = await getDb(c.env).queryMany<{
            mint_address: string;
            event_type: string;
            details: string;
            created_at: string;
        }>(
            `SELECT mint_address, event_type, details, created_at
             FROM analytics_token_events
             ORDER BY created_at DESC
             LIMIT 20`
        );

        return c.json({
            data: {
                overview: stats,
                recentEvents,
            },
            meta: { requestId, timestamp: new Date().toISOString() },
        });
    } catch (error) {
        return c.json({
            data: null,
            meta: { requestId, timestamp: new Date().toISOString(), error: String(error) },
        }, 500);
    }
});

// GET /v1/data-products/tokens/needing-reverification - Tokens needing attention
tokenRegistry.get("/needing-reverification", async (c) => {
    const requestId = c.get("requestId");
    const limit = parseInt(c.req.query("limit") ?? "50");
    const db = getDb(c.env);

    try {
        const tokens = await db.queryMany<{
            mint_address: string;
            symbol: string;
            name: string;
            verification_status: string;
            last_verified_at: string | null;
            verification_sources: string[];
            verification_error: string | null;
            priority: number;
        }>(
            `SELECT mint_address, symbol, name, verification_status, last_verified_at, verification_sources, verification_error, priority
             FROM analytics_tokens
             WHERE is_active = true
               AND (verification_status IN ('pending', 'failed', 'stale')
                    OR last_verified_at IS NULL
                    OR last_verified_at < NOW() - INTERVAL '24 hours')
             ORDER BY priority DESC
             LIMIT $1`,
            [limit]
        );

        return c.json({
            data: tokens,
            meta: { requestId, timestamp: new Date().toISOString() },
        });
    } catch (error) {
        return c.json({
            data: null,
            meta: { requestId, timestamp: new Date().toISOString(), error: String(error) },
        }, 500);
    }
});

// DEV: Retirement events require analytics_token_events table which
// needs a separate migration. Gracefully return empty for now.
// GET /v1/data-products/tokens/retirement/events - Retirement events log
tokenRegistry.get("/retirement/events", async (c) => {
    const requestId = c.get("requestId");
    const limit = parseInt(c.req.query("limit") ?? "50");
    const db = getDb(c.env);

    try {
        // DEV: Use analytics_tokens to provide basic retirement info instead
        const events = await db.queryMany<{
            mint_address: string;
            event_type: string;
            details: string;
            created_at: string;
        }>(
            `SELECT 
                mint_address, 
                verification_status as event_type,
                COALESCE(verification_error, '') as details,
                updated_at::text as created_at
             FROM analytics_tokens
             WHERE verification_status IN ('retired', 'rug_flagged', 'stale')
             ORDER BY updated_at DESC
             LIMIT $1`,
            [limit]
        );

        return c.json({
            data: events,
            meta: { requestId, timestamp: new Date().toISOString() },
        });
    } catch (error) {
        return c.json({
            data: null,
            meta: { requestId, timestamp: new Date().toISOString(), error: String(error) },
        }, 500);
    }
});

export default tokenRegistry;