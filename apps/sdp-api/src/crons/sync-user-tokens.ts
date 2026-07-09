/**
 * User Token Sync Cron Handler
 * 
 * Runs periodically to sync user-deployed tokens to the analytics registry.
 * This ensures any token deployed via the platform is automatically tracked.
 */

import type { Env } from "@/types/env";
import { getDb } from "@/db";
import { registerUserToken, syncUserDeployments } from "@/lib/token-registry";

/**
 * Sync user-deployed tokens to analytics registry
 * Runs every hour to catch newly deployed tokens
 */
export async function handleUserTokenSync(env: Env, ctx: ExecutionContext): Promise<Response> {
    const startTime = Date.now();
    
    try {
        const result = await syncUserDeployments(env);
        
        return new Response(JSON.stringify({ 
            success: true, 
            result,
            timestamp: new Date().toISOString(),
            durationMs: Date.now() - startTime
        }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
        });
    } catch (error) {
        console.error("User token sync failed:", error);
        return new Response(JSON.stringify({ 
            success: false, 
            error: String(error),
            timestamp: new Date().toISOString(),
            durationMs: Date.now() - startTime
        }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
        });
    }
}

export async function handleUserTokenSyncScheduled(env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleUserTokenSync(env, ctx));
}