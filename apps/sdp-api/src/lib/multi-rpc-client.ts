/**
 * Multi-RPC Failover Client with Automatic Failover & Health Checks
 * 
 * Features:
 * - Automatic failover chain (primary → secondary → tertiary)
 * - Health checks with latency tracking
 * - Rate limit detection & exponential backoff
 * - Priority-based request routing during rate limits
 * - Circuit breaker pattern for failed endpoints
 */

import type { Env } from "@/types/env";

export interface RPCEndpoint {
    url: string;
    name: string;
    weight: number;           // Priority weight (higher = preferred)
    maxRetries: number;
    timeoutMs: number;
    rateLimitBackoffMs: number;
}

export interface RPCHealth {
    url: string;
    name: string;
    healthy: boolean;
    latencyMs: number;
    lastCheck: string;
    consecutiveFailures: number;
    rateLimited: boolean;
    rateLimitResetAt: string | null;
}

export interface RPCRequestOptions {
    method: string;
    params: unknown[];
    priority?: number;        // Higher = more important (gets through during rate limits)
    timeoutMs?: number;
}

export interface RPCResponse<T = unknown> {
    success: boolean;
    data?: T;
    error?: string;
    endpointUsed: string;
    latencyMs: number;
    retries: number;
    fallbackUsed: boolean;
}

const DEFAULT_CHAIN: RPCEndpoint[] = [
    { 
        name: "primary", 
        weight: 100, 
        maxRetries: 3, 
        timeoutMs: 10000, 
        rateLimitBackoffMs: 1000,
        url: "" // Filled from env
    },
    { 
        name: "secondary", 
        weight: 50, 
        maxRetries: 2, 
        timeoutMs: 15000, 
        rateLimitBackoffMs: 2000,
        url: "" 
    },
    { 
        name: "tertiary", 
        weight: 10, 
        maxRetries: 1, 
        timeoutMs: 30000, 
        rateLimitBackoffMs: 5000,
        url: "https://api.mainnet.solana.com" 
    },
];

export class MultiRPCClient {
    private endpoints: RPCEndpoint[];
    private health: Map<string, RPCHealth> = new Map();
    private lastHealthCheck = 0;
    private readonly HEALTH_CHECK_INTERVAL = 60000; // 1 minute
    private readonly MAX_CONSECUTIVE_FAILURES = 3;
    private readonly RATE_LIMIT_RESET_WINDOW = 60000; // 1 minute

    constructor(env: Env) {
        this.endpoints = this.buildEndpointChain(env);
        this.initializeHealth();
    }

    private buildEndpointChain(env: Env): RPCEndpoint[] {
        const chain: RPCEndpoint[] = [];

        // Primary - from env (Helius/QuickNode/Triton via ANALYTICS_RPC_URL or SOLANA_RPC_HELIUS_URL)
        const primaryUrl = env.ANALYTICS_RPC_URL ?? env.SOLANA_RPC_HELIUS_URL ?? env.SOLANA_RPC_TRITON_URL ?? env.SOLANA_RPC_QUICKNODE_URL;
        if (primaryUrl) {
            chain.push({
                name: "primary",
                url: primaryUrl,
                weight: 100,
                maxRetries: 3,
                timeoutMs: 10000,
                rateLimitBackoffMs: 1000,
            });
        }

        // Secondary - from env (backup provider)
        const secondaryUrl = env.SOLANA_RPC_ALCHEMY_URL ?? env.SOLANA_RPC_QUICKNODE_URL ?? env.SOLANA_RPC_TRITON_URL;
        if (secondaryUrl && secondaryUrl !== chain[0]?.url) {
            chain.push({
                name: "secondary",
                url: secondaryUrl,
                weight: 50,
                maxRetries: 2,
                timeoutMs: 15000,
                rateLimitBackoffMs: 2000,
            });
        }

        // Tertiary - free public (always available)
        chain.push({
            name: "tertiary",
            url: env.ANALYTICS_RPC_URL ?? "https://api.mainnet.solana.com",
            weight: 10,
            maxRetries: 1,
            timeoutMs: 30000,
            rateLimitBackoffMs: 5000,
        });

        // Sort by weight (highest first)
        return chain.sort((a, b) => b.weight - a.weight);
    }

    private initializeHealth(): void {
        for (const ep of this.endpoints) {
            this.health.set(ep.url, {
                url: ep.url,
                name: ep.name,
                healthy: true,
                latencyMs: 0,
                lastCheck: new Date().toISOString(),
                consecutiveFailures: 0,
                rateLimited: false,
                rateLimitResetAt: null,
            });
        }
    }

    /**
     * Execute RPC call with automatic failover
     */
    async call<T = unknown>(method: string, params: unknown[], options: RPCRequestOptions = { method: "", params: [], priority: 50, timeoutMs: 10000 }): Promise<RPCResponse<T>> {
        const { priority = 50, timeoutMs } = options;
        const startTime = Date.now();
        let lastError: Error | null = null;
        let retries = 0;
        let fallbackUsed = false;

        // Sort endpoints by: healthy first, then by weight, then by latency
        const sortedEndpoints = this.getSortedEndpoints(priority);

        for (const endpoint of sortedEndpoints) {
            const health = this.health.get(endpoint.url)!;
            
            // Skip unhealthy endpoints unless it's the last resort
            if (!health.healthy && endpoint !== this.endpoints[this.endpoints.length - 1]) {
                continue;
            }

            // Skip rate-limited endpoints unless last resort
            if (health.rateLimited && health.rateLimitResetAt && new Date(health.rateLimitResetAt) > new Date()) {
                if (endpoint !== this.endpoints[this.endpoints.length - 1]) {
                    continue;
                }
            }

            for (let attempt = 1; attempt <= endpoint.maxRetries; attempt++) {
                try {
                    const result = await this.executeCall(endpoint, method, params, timeoutMs ?? endpoint.timeoutMs);
                    
                    // Success - update health
                    this.recordSuccess(endpoint.url, Date.now() - startTime);
                    
                    return {
                        success: true,
                        data: result as T,
                        endpointUsed: endpoint.name,
                        latencyMs: Date.now() - startTime,
                        retries,
                        fallbackUsed,
                    };
                } catch (error) {
                    lastError = error instanceof Error ? error : new Error(String(error));
                    retries++;
                    
                    // Check if rate limited
                    if (this.isRateLimitError(lastError)) {
                        this.recordRateLimit(endpoint.url);
                        break; // Try next endpoint immediately
                    }
                    
                    // Check if we should retry on this endpoint
                    if (attempt < endpoint.maxRetries) {
                        const backoff = endpoint.rateLimitBackoffMs * Math.pow(2, attempt - 1);
                        await this.sleep(Math.min(backoff, 10000));
                        continue;
                    }
                }
            }

            // All retries exhausted for this endpoint
            this.recordFailure(endpoint.url);
            fallbackUsed = true;
        }

        // All endpoints failed
        return {
            success: false,
            error: lastError?.message ?? "All RPC endpoints failed",
            endpointUsed: "none",
            latencyMs: Date.now() - startTime,
            retries,
            fallbackUsed: true,
        };
    }

    private getSortedEndpoints(priority: number): RPCEndpoint[] {
        return [...this.endpoints].sort((a, b) => {
            const healthA = this.health.get(a.url)!;
            const healthB = this.health.get(b.url)!;
            
            // Healthy endpoints first
            if (healthA.healthy !== healthB.healthy) {
                return healthA.healthy ? -1 : 1;
            }
            
            // During rate limits, prioritize by priority weight
            if (healthA.rateLimited || healthB.rateLimited) {
                return b.weight - a.weight;
            }
            
            // Otherwise by weight, then latency
            if (a.weight !== b.weight) {
                return b.weight - a.weight;
            }
            
            return healthA.latencyMs - healthB.latencyMs;
        });
    }

    private async executeCall(endpoint: RPCEndpoint, method: string, params: unknown[], timeoutMs: number): Promise<unknown> {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        
        try {
            const response = await fetch(endpoint.url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
                signal: controller.signal,
            });
            
            clearTimeout(timeoutId);
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            const data = await response.json();
            
            if (data.error) {
                throw new Error(data.error.message ?? "RPC error");
            }
            
            return data.result;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    private isRateLimitError(error: Error): boolean {
        const msg = error.message.toLowerCase();
        return msg.includes("429") || 
               msg.includes("rate limit") || 
               msg.includes("too many requests") ||
               msg.includes("rate limited");
    }

    private recordSuccess(url: string, latencyMs: number): void {
        const health = this.health.get(url)!;
        health.healthy = true;
        health.latencyMs = Math.round(health.latencyMs * 0.7 + latencyMs * 0.3); // EMA
        health.lastCheck = new Date().toISOString();
        health.consecutiveFailures = 0;
    }

    private recordFailure(url: string): void {
        const health = this.health.get(url)!;
        health.consecutiveFailures++;
        health.lastCheck = new Date().toISOString();
        
        if (health.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
            health.healthy = false;
        }
    }

    private recordRateLimit(url: string): void {
        const health = this.health.get(url)!;
        health.rateLimited = true;
        health.rateLimitResetAt = new Date(Date.now() + this.RATE_LIMIT_RESET_WINDOW).toISOString();
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Get health status for all endpoints
     */
    getHealthStatus(): RPCHealth[] {
        return Array.from(this.health.values());
    }

    /**
     * Periodic health check - call from cron
     */
    async runHealthChecks(): Promise<void> {
        const now = Date.now();
        if (now - this.lastHealthCheck < this.HEALTH_CHECK_INTERVAL) return;
        this.lastHealthCheck = now;

        for (const endpoint of this.endpoints) {
            try {
                const start = Date.now();
                await this.executeCall(
                    { ...endpoint, maxRetries: 1, timeoutMs: 5000 },
                    "getHealth",
                    [],
                    5000
                );
                this.recordSuccess(endpoint.url, Date.now() - start);
            } catch {
                this.recordFailure(endpoint.url);
            }
        }

        // Reset rate limits that have expired
        for (const health of this.health.values()) {
            if (health.rateLimited && health.rateLimitResetAt && new Date(health.rateLimitResetAt) < new Date()) {
                health.rateLimited = false;
                health.rateLimitResetAt = null;
            }
        }
    }

    /**
     * Get best available endpoint for a given priority
     */
    getBestEndpoint(priority: number): RPCEndpoint | null {
        const sorted = this.getSortedEndpoints(priority);
        return sorted.find(ep => this.health.get(ep.url)?.healthy) ?? null;
    }
}

/**
 * Factory function to create client from env
 */
export function createMultiRPCClient(env: Env): MultiRPCClient {
    return new MultiRPCClient(env);
}