/**
 * Token Discovery Cron Handler
 * 
 * Runs daily to discover new tokens from external sources:
 * 1. Jupiter token list (verified tokens)
 * 2. CoinGecko trending/popular tokens
 * 3. RPC reverification of existing tokens
 * 4. Cross-references all sources for reverification
 */

import type { Env } from "@/types/env";
import { getDb } from "@/db";
import { rpcCall } from "@/lib/rpc-utils";
import { 
    resolveAnalyticsMints, 
    getTokensNeedingReverification, 
    updateTokenVerification,
    registerDiscoveredToken,
    getTokenMetadata 
} from "@/lib/token-registry";

const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

interface JupiterToken {
    address: string;
    symbol: string;
    name: string;
    decimals: number;
    logoURI?: string;
    tags?: string[];
    verified?: boolean;
}

interface CoinGeckoToken {
    id: string;
    symbol: string;
    name: string;
    platforms: { solana?: string };
}

interface DiscoveryResult {
    mintAddress: string;
    symbol: string;
    name: string;
    decimals: number;
    source: 'jupiter' | 'coingecko' | 'rpc_reverification';
    metadata?: {
        logoUri?: string;
        coingeckoId?: string;
        tags?: string[];
        jupiterVerified?: boolean;
    };
    rpcVerified: boolean;
    holderCount?: number;
    supply?: number;
}

/**
 * Fetch Jupiter token list (verified tokens)
 */
async function fetchJupiterTokens(): Promise<JupiterToken[]> {
    try {
        const response = await fetch("https://token.jup.ag/all", {
            headers: { "Accept": "application/json" },
            signal: AbortSignal.timeout(30000)
        });
        if (!response.ok) throw new Error(`Jupiter API: ${response.status}`);
        return response.json();
    } catch (error) {
        console.warn("Failed to fetch Jupiter tokens:", error);
        return [];
    }
}

/**
 * Fetch CoinGecko trending tokens on Solana
 */
async function fetchCoinGeckoTokens(): Promise<CoinGeckoToken[]> {
    try {
        const response = await fetch("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=solana-ecosystem&order=market_cap_desc&per_page=100&page=1", {
            headers: { "Accept": "application/json" },
            signal: AbortSignal.timeout(30000)
        });
        if (!response.ok) throw new Error(`CoinGecko API: ${response.status}`);
        return response.json();
    } catch (error) {
        console.warn("Failed to fetch CoinGecko tokens:", error);
        return [];
    }
}

/**
 * Verify token exists on-chain via RPC
 */
async function verifyTokenOnChain(env: Env, mintAddress: string): Promise<{ verified: boolean; decimals?: number; supply?: number; holderCount?: number }> {
    const rpcUrl = env.ANALYTICS_RPC_URL ?? env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
    
    try {
        // Check token supply
        const supplyResult = await rpcCall(env.ANALYTICS_RPC_URL ?? env.SOLANA_RPC_URL ?? "https://api.mainnet.solana.com", "getTokenSupply", [mintAddress]) as { value: { decimals: number; amount: string } };
        const decimals = supplyResult.value.decimals;
        const supply = Number.parseFloat(supplyResult.value.amount) / 10 ** decimals;
        
        // Quick holder count check (sample)
        const accounts = await rpcCall(env.ANALYTICS_RPC_URL ?? env.SOLANA_RPC_URL ?? "https://api.mainnet.solana.com", "getProgramAccounts", [
            "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
            {
                encoding: "jsonParsed",
                filters: [
                    { dataSize: 165 },
                    { memcmp: { offset: 0, bytes: mintAddress } },
                ],
            },
        ]);
        
        return {
            verified: true,
            decimals: supplyResult.value.decimals,
            supply: Number.parseFloat(supplyResult.value.amount) / 10 ** supplyResult.value.decimals,
            holderCount: (accounts as any[]).length,
        };
    } catch (error) {
        return { verified: false };
    }
}

/**
 * Discover tokens from Jupiter
 */
async function discoverFromJupiter(env: Env): Promise<DiscoveryResult[]> {
    const jupiterTokens = await fetchJupiterTokens();
    const results: DiscoveryResult[] = [];
    
    for (const token of jupiterTokens) {
        // Only process Solana tokens
        if (!token.address || token.address.length !== 44) continue;
        
        // Verify on-chain
        const rpcResult = await verifyTokenOnChain(env, token.address);
        
        results.push({
            mintAddress: token.address,
            symbol: token.symbol,
            name: token.name,
            decimals: token.decimals,
            source: 'jupiter',
            metadata: {
                logoUri: token.logoURI,
                tags: token.tags,
                jupiterVerified: token.verified ?? false,
            },
            rpcVerified: rpcResult.verified,
            holderCount: rpcResult.holderCount,
            supply: rpcResult.supply,
        });
    }
    
    return results;
}

/**
 * Discover tokens from CoinGecko
 */
async function discoverFromCoinGecko(env: Env): Promise<DiscoveryResult[]> {
    const cgTokens = await fetchCoinGeckoTokens();
    const results: DiscoveryResult[] = [];
    
    for (const token of cgTokens) {
        const solanaAddress = token.platforms?.solana;
        if (!solanaAddress || solanaAddress.length !== 44) continue;
        
        const rpcResult = await verifyTokenOnChain(env, solanaAddress);
        
        results.push({
            mintAddress: solanaAddress,
            symbol: token.symbol.toUpperCase(),
            name: token.name,
            decimals: 9, // Will be verified on-chain
            source: 'coingecko',
            metadata: {
                coingeckoId: token.id,
                tags: ['coingecko-trending'],
            },
            rpcVerified: rpcResult.verified,
            holderCount: rpcResult.holderCount,
            supply: rpcResult.supply,
        });
    }
    
    return results;
}

/**
 * Reverification: Cross-reference all sources and validate via RPC
 */
async function reverifyExistingTokens(env: Env): Promise<{ verified: number; failed: number; stale: number }> {
    const db = getDb(env);
    const tokensNeedingReverify = await db.queryMany<{
        mint_address: string;
        symbol: string;
        name: string;
        decimals: number;
        verification_status: string;
        last_verified_at: string | null;
        verification_sources: string[];
    }>(
        `SELECT mint_address, symbol, name, decimals, verification_status, last_verified_at, verification_sources
         FROM analytics_tokens 
         WHERE is_active = true 
           AND (verification_status IN ('pending', 'failed', 'stale')
                OR last_verified_at IS NULL
                OR last_verified_at < NOW() - INTERVAL '24 hours')
         ORDER BY priority DESC`
    );
    
    let verified = 0, failed = 0, stale = 0;
    
    for (const token of tokensNeedingReverify) {
        try {
            const rpcResult = await verifyTokenOnChain(env, token.mint_address);
            
            if (rpcResult.verified) {
                // Update with reverification results
                const sources = [...new Set([...token.verification_sources, 'rpc_reverification'])];
                await db.execute(
                    `UPDATE analytics_tokens SET
                        verification_status = 'verified',
                        last_verified_at = NOW(),
                        verification_sources = $1,
                        verification_error = NULL,
                        holder_count_at_verification = $2,
                        supply_at_verification = $3,
                        decimals = COALESCE($4, decimals),
                        updated_at = NOW()
                     WHERE mint_address = $5`,
                    [sources, rpcResult.holderCount ?? 0, rpcResult.supply ?? 0, rpcResult.decimals ?? 9, token.mint_address]
                );
                verified++;
            } else {
                await db.execute(
                    `UPDATE analytics_tokens SET
                        verification_status = 'failed',
                        verification_error = 'RPC verification failed',
                        updated_at = NOW()
                     WHERE mint_address = $1`,
                    [token.mint_address]
                );
                failed++;
            }
        } catch (error) {
            console.error(`Reverification failed for ${token.mint_address}:`, error);
            failed++;
        }
    }
    
    return { verified, failed, stale };
}

/**
 * Main discovery handler
 */
export async function handleTokenDiscovery(env: Env, ctx: ExecutionContext): Promise<Response> {
    const startTime = Date.now();
    const results = {
        jupiter: { discovered: 0, registered: 0, errors: 0 },
        coingecko: { discovered: 0, registered: 0, errors: 0 },
        reverification: { verified: 0, failed: 0, stale: 0 },
        totalTimeMs: 0,
    };
    
    try {
        // 1. Discover from Jupiter
        console.log("Starting Jupiter token discovery...");
        const jupiterResults = await discoverFromJupiter(env);
        results.jupiter.discovered = jupiterResults.length;
        
        for (const result of jupiterResults) {
            try {
                if (result.rpcVerified) {
                    await registerDiscoveredToken(env, result.mintAddress, result.symbol, result.name, result.decimals, 'jupiter', result.metadata);
                    results.jupiter.registered++;
                }
            } catch (error) {
                console.error(`Failed to register Jupiter token ${result.mintAddress}:`, error);
                results.jupiter.errors++;
            }
        }
        
        // 2. Discover from CoinGecko
        console.log("Starting CoinGecko token discovery...");
        const cgResults = await discoverFromCoinGecko(env);
        results.coingecko.discovered = cgResults.length;
        
        for (const result of cgResults) {
            try {
                if (result.rpcVerified) {
                    await registerDiscoveredToken(env, result.mintAddress, result.symbol, result.name, result.decimals, 'coingecko', result.metadata);
                    results.coingecko.registered++;
                }
            } catch (error) {
                console.error(`Failed to register CoinGecko token ${result.mintAddress}:`, error);
                results.coingecko.errors++;
            }
        }
        
        // 3. Reverification of existing tokens
        console.log("Starting token reverification...");
        const reverifyResults = await reverifyExistingTokens(env);
        results.reverification = reverifyResults;
        
    } catch (error) {
        console.error("Token discovery failed:", error);
        return new Response(JSON.stringify({ error: String(error), results }), { 
            status: 500,
            headers: { "Content-Type": "application/json" }
        });
    }
    
    results.totalTimeMs = Date.now() - startTime;
    
    return new Response(JSON.stringify({ 
        success: true, 
        results,
        timestamp: new Date().toISOString()
    }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
    });
}

export async function handleTokenDiscoveryScheduled(env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleTokenDiscovery(env, ctx));
}