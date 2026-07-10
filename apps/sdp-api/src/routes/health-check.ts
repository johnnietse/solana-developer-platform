/**
 * Health Check Route (Detailed)
 * 
 * Provides comprehensive health status for monitoring/alerting
 * Zero human intervention needed - self-reports all issues
 */

import { Hono } from "hono";
import type { Env } from "@/types/env";
import { getDb } from "@/db";
import { resolveAnalyticsMints } from "@/lib/token-registry";
import { queryDatabricks } from "@/lib/databricks-query";

const healthCheck = new Hono<{ Bindings: Env }>();

interface HealthStatus {
    status: "healthy" | "degraded" | "unhealthy";
    timestamp: string;
    uptimeMs: number;
    version: string;
    checks: {
        database: CheckResult;
        databricks: CheckResult;
        rpc: CheckResult;
        ingestion: CheckResult;
        tokens: CheckResult;
        retirement: CheckResult;
    };
    metrics: {
        activeTokens: number;
        lastIngestion: string | null;
        failedIngestions24h: number;
        retiredTokens30d: number;
        flaggedRug: number;
        flaggedStale: number;
        avgIngestionLatencyMs: number;
    };
    alerts: Alert[];
}

interface CheckResult {
    status: "pass" | "warn" | "fail";
    message: string;
    latencyMs?: number;
    details?: any;
}

interface Alert {
    severity: "info" | "warning" | "critical";
    source: string;
    message: string;
    timestamp: string;
    autoResolved?: boolean;
}

const START_TIME = Date.now();
const VERSION = "1.0.0";

healthCheck.get("/", async (c) => {
    const startTime = Date.now();
    const checks = await runAllChecks(c.env);
    const metrics = await gatherMetrics(c.env);
    const alerts = generateAlerts(checks, metrics);

    const overallStatus = determineOverallStatus(checks);

    const health: HealthStatus = {
        status: overallStatus,
        timestamp: new Date().toISOString(),
        uptimeMs: Date.now() - START_TIME,
        version: "1.0.0",
        checks,
        metrics,
        alerts,
    };

    const statusCode = overallStatus === "healthy" ? 200 : overallStatus === "degraded" ? 200 : 503;

    return c.json(health, statusCode);
});

async function runAllChecks(env: Env) {
    const [database, databricks, rpc, ingestion, tokens, retirement] = await Promise.all([
        checkDatabase(env),
        checkDatabricks(env),
        checkRPC(env),
        checkIngestion(env),
        checkTokens(env),
        checkRetirement(env),
    ]);

    return { database, databricks, rpc, ingestion, tokens, retirement };
}

async function checkDatabase(env: Env) {
    const start = Date.now();
    try {
        const db = getDb(env);
        // DEV: Add 5s timeout to database check to prevent hanging
        const result = await Promise.race([
            db.queryOne("SELECT 1 as health"),
            new Promise<null>((_, reject) => 
                setTimeout(() => reject(new Error("Database check timed out after 5s")), 5000)
            ),
        ]);
        return { status: "pass" as const, message: "Database connected", latencyMs: Date.now() - start };
    } catch (error) {
        return { status: "fail" as const, message: `Database error: ${error}`, latencyMs: Date.now() - start };
    }
}

async function checkDatabricks(env: Env) {
    const start = Date.now();
    // DEV: Skip Databricks check if credentials aren't configured
    // (no DATABRICKS_HOST means we're in local dev without Databricks)
    const { DATABRICKS_HOST, DATABRICKS_TOKEN, DATABRICKS_WAREHOUSE_ID } = env;
    if (!DATABRICKS_HOST || !DATABRICKS_TOKEN || !DATABRICKS_WAREHOUSE_ID) {
        return { status: "warn" as const, message: "Databricks not configured (local dev)", latencyMs: Date.now() - start };
    }
    try {
        await queryDatabricks(env, "SELECT 1 as health", [], "10s");
        return { status: "pass" as const, message: "Databricks connected", latencyMs: Date.now() - start };
    } catch (error) {
        return { status: "fail" as const, message: `Databricks error: ${error}`, latencyMs: Date.now() - start };
    }
}

async function checkRPC(env: Env) {
    const start = Date.now();
    try {
        const { rpcCall } = await import("@/lib/rpc-utils");
        const rpcUrl = env.ANALYTICS_RPC_URL ?? env.SOLANA_RPC_URL ?? "https://api.mainnet.solana.com";
        // DEV: Add 10s timeout to RPC check to prevent hanging
        await Promise.race([
            rpcCall(rpcUrl, "getHealth", []),
            new Promise<never>((_, reject) => 
                setTimeout(() => reject(new Error("RPC check timed out after 10s")), 10000)
            ),
        ]);
        return { status: "pass" as const, message: "RPC healthy", latencyMs: Date.now() - start };
    } catch (error) {
        return { status: "fail" as const, message: `RPC error: ${error}`, latencyMs: Date.now() - start };
    }
}

async function checkIngestion(env: Env) {
    const start = Date.now();
    try {
        const db = getDb(env);
        // DEV: Use column names that exist - last_ingested_at instead of snapshot_at
        const result = await db.queryOne<{ last_ingested: string; verified_count: number }>(
            `SELECT 
                MAX(last_ingested_at) as last_ingested,
                COUNT(*) FILTER (WHERE verification_status = 'verified') as verified_count
             FROM analytics_tokens 
             WHERE is_active = true`
        );

        if (!result?.last_ingested) {
            return { status: "warn" as const, message: "No ingestion recorded yet", latencyMs: Date.now() - start };
        }

        const lastIngested = new Date(result.last_ingested).getTime();
        const hoursSinceIngestion = (Date.now() - lastIngested) / (1000 * 60 * 60);

        let status: "pass" | "warn" | "fail" = "pass";
        let message = `Last ingestion ${hoursSinceIngestion.toFixed(1)}h ago`;

        if (hoursSinceIngestion > 2) status = "warn";
        if (hoursSinceIngestion > 6) status = "fail";

        return { status, message, latencyMs: Date.now() - start, details: { lastIngested: result.last_ingested, verifiedCount: result.verified_count } };
    } catch (error) {
        return { status: "fail" as const, message: `Ingestion check failed: ${error}`, latencyMs: Date.now() - start };
    }
}

async function checkTokens(env: Env): Promise<CheckResult> {
    const start = Date.now();
    try {
        const db = getDb(env);
        const stats = await db.queryOne<{
            active: number;
            pending: number;
            failed: number;
            stale: number;
            rug_flagged: number;
        }>(
            `SELECT 
                COUNT(*) FILTER (WHERE is_active AND verification_status = 'verified') as active,
                COUNT(*) FILTER (WHERE is_active AND verification_status = 'pending') as pending,
                COUNT(*) FILTER (WHERE is_active AND verification_status = 'failed') as failed,
                COUNT(*) FILTER (WHERE is_active AND verification_status = 'stale') as stale,
                COUNT(*) FILTER (WHERE verification_status = 'rug_flagged') as rug_flagged
             FROM analytics_tokens`
        );

        if (!stats) {
            return { status: "warn", message: "No token stats available", latencyMs: Date.now() - start };
        }

        const total = (stats.active ?? 0) + (stats.pending ?? 0) + (stats.failed ?? 0) + (stats.stale ?? 0);
        
        let status: "pass" | "warn" | "fail" = "pass";
        let message = `${total} tokens tracked (${stats.active ?? 0} verified)`;

        if ((stats.failed ?? 0) > 0) { status = "warn"; message += `, ${stats.failed} failed`; }
        if ((stats.stale ?? 0) > 0) { status = "warn"; message += `, ${stats.stale} stale`; }
        if ((stats.rug_flagged ?? 0) > 0) { status = "warn"; message += `, ${stats.rug_flagged} rug-flagged`; }

        return { status, message, latencyMs: Date.now() - start, details: stats };
    } catch (error) {
        return { status: "fail" as const, message: `Token check failed: ${error}`, latencyMs: Date.now() - start };
    }
}

async function checkRetirement(env: Env): Promise<CheckResult> {
    const start = Date.now();
    try {
        const db = getDb(env);
        const stats = await db.queryOne<{
            retired_30d: number;
            rug_flagged: number;
            stale_flagged: number;
        }>(
            `SELECT 
                COUNT(*) FILTER (WHERE verification_status = 'retired' AND updated_at > NOW() - INTERVAL '30 days') as retired_30d,
                COUNT(*) FILTER (WHERE verification_status = 'rug_flagged') as rug_flagged,
                COUNT(*) FILTER (WHERE verification_status = 'stale') as stale_flagged
             FROM analytics_tokens`
        );

        if (!stats) {
            return { status: "warn", message: "No retirement stats available", latencyMs: Date.now() - start };
        }

        return {
            status: "pass" as const,
            message: `Retirement: ${stats.retired_30d ?? 0} retired (30d), ${stats.rug_flagged ?? 0} rug-flagged, ${stats.stale_flagged ?? 0} stale`,
            latencyMs: Date.now() - start,
            details: stats,
        };
    } catch (error) {
        return { status: "fail" as const, message: `Retirement check failed: ${error}`, latencyMs: Date.now() - start };
    }
}

async function gatherMetrics(env: Env) {
    const db = getDb(env);
    
    const [tokenStats, ingestionStats, retirementStats] = await Promise.all([
        db.queryOne<{ active: number }>(
            `SELECT COUNT(*) as active FROM analytics_tokens WHERE is_active = true AND verification_status = 'verified'`
        ),
        db.queryOne<{ last: string; verified: number }>(
            `SELECT MAX(last_ingested_at) as last, COUNT(*) FILTER (WHERE verification_status = 'verified') as verified 
             FROM analytics_tokens WHERE is_active = true`
        ),
        db.queryOne<{ retired: number; rug: number; stale: number }>(
            `SELECT 
                COUNT(*) FILTER (WHERE verification_status = 'retired' AND updated_at > NOW() - INTERVAL '30 days') as retired,
                COUNT(*) FILTER (WHERE verification_status = 'rug_flagged') as rug,
                COUNT(*) FILTER (WHERE verification_status = 'stale') as stale
             FROM analytics_tokens`
        ),
    ]);

    // DEV: avg_latency query uses column names that match the existing schema
    const latencyStats = await db.queryOne<{ avg_latency: number }>(
        `SELECT AVG(EXTRACT(EPOCH FROM (updated_at - last_ingested_at)) * 1000) as avg_latency
         FROM analytics_tokens 
         WHERE last_ingested_at IS NOT NULL AND verification_status = 'verified' 
         AND updated_at > NOW() - INTERVAL '24 hours'`
    ).catch(() => ({ avg_latency: 0 }));

    return {
        activeTokens: tokenStats?.active ?? 0,
        lastIngestion: ingestionStats?.last ?? null,
        failedIngestions24h: 0,
        retiredTokens30d: retirementStats?.retired ?? 0,
        flaggedRug: retirementStats?.rug ?? 0,
        flaggedStale: retirementStats?.stale ?? 0,
        avgIngestionLatencyMs: Math.round(latencyStats?.avg_latency ?? 0),
    };
}

function generateAlerts(checks: any, metrics: any): Alert[] {
    const alerts: Alert[] = [];
    const now = new Date().toISOString();

    // Critical alerts
    if (checks.database.status === "fail") {
        alerts.push({ severity: "critical", source: "database", message: "Database connection failed", timestamp: new Date().toISOString() });
    }
    if (checks.databricks.status === "fail") {
        const msg = checks.databricks.message?.includes("not configured")
            ? "Databricks not configured (expected in local dev)"
            : "Databricks connection failed";
        // Only critical if it was configured but failing
        alerts.push({ severity: "critical", source: "databricks", message: msg, timestamp: new Date().toISOString() });
    }
    if (checks.rpc.status === "fail") {
        alerts.push({ severity: "critical", source: "rpc", message: "RPC endpoint unreachable", timestamp: new Date().toISOString() });
    }

    // Warning alerts
    if (checks.ingestion.status === "warn") {
        alerts.push({ severity: "warning", source: "ingestion", message: "Ingestion delayed or has failures", timestamp: new Date().toISOString() });
    }
    if (checks.ingestion.status === "fail") {
        alerts.push({ severity: "critical", source: "ingestion", message: "Ingestion failed or stalled >6h", timestamp: new Date().toISOString() });
    }
    if (checks.tokens.status === "warn") {
        alerts.push({ severity: "warning", source: "tokens", message: "Token verification issues detected", timestamp: new Date().toISOString() });
    }

    // Metric-based alerts
    if (metrics.failedIngestions24h > 10) {
        alerts.push({ severity: "warning", source: "ingestion", message: `${metrics.failedIngestions24h} failed ingestions in 24h`, timestamp: new Date().toISOString() });
    }
    if (metrics.flaggedRug > 0) {
        alerts.push({ severity: "warning", source: "retirement", message: `${metrics.flaggedRug} tokens flagged as potential rug pulls`, timestamp: new Date().toISOString() });
    }
    if (metrics.flaggedStale > 5) {
        alerts.push({ severity: "warning", source: "retirement", message: `${metrics.flaggedStale} tokens stale (no ingestion 7+ days)`, timestamp: new Date().toISOString() });
    }

    return alerts;
}

function determineOverallStatus(checks: any): "healthy" | "degraded" | "unhealthy" {
    const statuses = Object.values(checks).map((c: any) => c.status);
    if (statuses.includes("fail")) return "unhealthy";
    if (statuses.includes("warn")) return "degraded";
    return "healthy";
}

export default healthCheck;