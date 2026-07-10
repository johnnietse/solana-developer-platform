/**
 * Health & Self-Reporting Endpoint
 * 
 * Provides comprehensive health status for monitoring/alerting
 * Zero human intervention needed - self-reports all issues
 */

import type { Env } from "@/types/env";
import { getDb } from "@/db";
import { resolveAnalyticsMints } from "@/lib/token-registry";
import { queryDatabricks } from "@/lib/databricks-query";

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

export async function handleHealthCheck(env: Env): Promise<Response> {
    const startTime = Date.now();
    const checks = await runAllChecks(env);
    const metrics = await gatherMetrics(env);
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

    return new Response(JSON.stringify(health, null, 2), {
        status: statusCode,
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-cache, no-store, must-revalidate",
        },
    });
}

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

async function checkDatabase(env: Env): Promise<CheckResult> {
    const start = Date.now();
    try {
        const db = getDb(env);
        await db.queryOne("SELECT 1 as health");
        return { status: "pass", message: "Database connected", latencyMs: Date.now() - start };
    } catch (error) {
        return { status: "fail", message: `Database error: ${error}`, latencyMs: Date.now() - start };
    }
}

async function checkDatabricks(env: Env): Promise<CheckResult> {
    const start = Date.now();
    try {
        const result = await queryDatabricks(env, "SELECT 1 as health", [], "10s");
        return { status: "pass", message: "Databricks connected", latencyMs: Date.now() - start };
    } catch (error) {
        return { status: "fail", message: `Databricks error: ${error}`, latencyMs: Date.now() - start };
    }
}

async function checkRPC(env: Env): Promise<CheckResult> {
    const start = Date.now();
    try {
        const { rpcCall } = await import("@/lib/rpc-utils");
        const rpcUrl = env.ANALYTICS_RPC_URL ?? env.SOLANA_RPC_URL ?? "https://api.mainnet.solana.com";
        await rpcCall(rpcUrl, "getHealth", []);
        return { status: "pass", message: "RPC healthy", latencyMs: Date.now() - start };
    } catch (error) {
        return { status: "fail", message: `RPC error: ${error}`, latencyMs: Date.now() - start };
    }
}

async function checkIngestion(env: Env): Promise<CheckResult> {
    const start = Date.now();
    try {
        const db = getDb(env);
        const result = await db.queryOne<{ last_ingested: string; failed_count: number }>(
            `SELECT 
                MAX(snapshot_at) as last_ingested,
                COUNT(*) FILTER (WHERE last_ingestion_status = 'failed') as failed_count
             FROM analytics_tokens 
             WHERE is_active = true`
        );

        if (!result?.last_ingested) {
            return { status: "warn", message: "No ingestion recorded yet", latencyMs: Date.now() - start };
        }

        const lastIngested = new Date(result.last_ingested).getTime();
        const hoursSinceIngestion = (Date.now() - lastIngested) / (1000 * 60 * 60);

        let status: "pass" | "warn" | "fail" = "pass";
        let message = `Last ingestion ${hoursSinceIngestion.toFixed(1)}h ago`;

        if (hoursSinceIngestion > 2) status = "warn";
        if (hoursSinceIngestion > 6) status = "fail";

        if (result.failed_count > 0) {
            status = "warn";
            message += `, ${result.failed_count} failed in 24h`;
        }

        return { status, message, latencyMs: Date.now() - start, details: { lastIngested: result.last_ingested, failed24h: result.failed_count } };
    } catch (error) {
        return { status: "fail", message: `Ingestion check failed: ${error}`, latencyMs: Date.now() - start };
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
        return { status: "fail", message: `Token check failed: ${error}`, latencyMs: Date.now() - start };
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

        return {
            status: "pass" as const,
            message: `Retirement: ${stats?.retired_30d ?? 0} retired (30d), ${stats?.rug_flagged ?? 0} rug-flagged, ${stats?.stale_flagged ?? 0} stale`,
            latencyMs: Date.now() - start,
            details: stats ?? { retired_30d: 0, rug_flagged: 0, stale_flagged: 0 },
        };
    } catch (error) {
        return { status: "fail" as const, message: `Retirement check failed: ${error}`, latencyMs: Date.now() - start };
    }
}

async function gatherMetrics(env: Env) {
    const db = getDb(env);
    
    const [tokenStats, ingestionStats, retirementStats, latencyStats] = await Promise.all([
        db.queryOne<{ active: number }>(
            `SELECT COUNT(*) as active FROM analytics_tokens WHERE is_active = true AND verification_status = 'verified'`
        ),
        db.queryOne<{ last: string; failed: number }>(
            `SELECT MAX(snapshot_at) as last, COUNT(*) FILTER (WHERE last_ingestion_status = 'failed') as failed 
             FROM analytics_tokens WHERE is_active = true`
        ),
        db.queryOne<{ retired: number; rug: number; stale: number }>(
            `SELECT 
                COUNT(*) FILTER (WHERE verification_status = 'retired' AND updated_at > NOW() - INTERVAL '30 days') as retired,
                COUNT(*) FILTER (WHERE verification_status = 'rug_flagged') as rug,
                COUNT(*) FILTER (WHERE verification_status = 'stale') as stale
             FROM analytics_tokens`
        ),
        db.queryOne<{ avg_latency: number }>(
            `SELECT AVG(EXTRACT(EPOCH FROM (updated_at - last_ingested_at)) * 1000) as avg_latency
             FROM analytics_tokens 
             WHERE last_ingested_at IS NOT NULL AND last_ingestion_status = 'success' 
             AND updated_at > NOW() - INTERVAL '24 hours'`
        ),
    ]);

    return {
        activeTokens: tokenStats?.active ?? 0,
        lastIngestion: ingestionStats?.last ?? null,
        failedIngestions24h: ingestionStats?.failed ?? 0,
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
        alerts.push({ severity: "critical", source: "databricks", message: "Databricks connection failed", timestamp: new Date().toISOString() });
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

export async function handleHealthCheckScheduled(env: Env, ctx: ExecutionContext): Promise<void> {
    // Health check doesn't need waitUntil - it's a quick check
    await handleHealthCheck(env);
}