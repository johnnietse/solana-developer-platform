/**
 * User Token Analytics — queries the user's own issued tokens from Postgres
 * and enriches them with live RPC holder data.
 *
 * Pipeline:
 *   Layer 1: Postgres → issued_tokens table (scoped by organization/project)
 *   Layer 2: Solana RPC → getTokenSupply, getProgramAccounts for each mint
 *   Layer 3: SDP API → GET /v1/data-products/user-analytics
 */

import { Hono } from "hono";
import type { Env } from "@/types/env";
import { getDb } from "@/db";
import { getTokenSupply, getHolderCount } from "@/lib/rpc-utils";

const userAnalytics = new Hono<{ Bindings: Env }>();

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface UserTokenEntry {
  tokenId: string;
  mintAddress: string | null;
  name: string;
  symbol: string;
  decimals: number;
  status: string;
  template: string;
  totalSupply: number;
  holderCount: number;
  medianBalance: number;
  deployedAt: string | null;
  createdAt: string;
}

interface UserAnalyticsResponse {
  tokens: UserTokenEntry[];
  summary: {
    totalTokens: number;
    totalSupply: number;
    totalHolders: number;
    deployedTokens: number;
    pendingTokens: number;
  };
  lastUpdated: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEVNET_RPC = "https://api.devnet.solana.com";

// ─────────────────────────────────────────────────────────────────────────────
// Route Handler
// ─────────────────────────────────────────────────────────────────────────────

userAnalytics.get("/", async (c) => {
  const requestId = c.get("requestId");

  // Resolve auth context — organizationId from API key, session, or Clerk auth
  const apiKey = c.get("apiKey");
  const session = c.get("session");
  const clerk = c.get("clerk");
  const orgId = apiKey?.organizationId ?? session?.organizationId ?? clerk?.organizationId;
  const projectId = apiKey?.projectId;

  if (!orgId) {
    return c.json(
      {
        data: { tokens: [], summary: { totalTokens: 0, totalSupply: 0, totalHolders: 0, deployedTokens: 0, pendingTokens: 0 }, lastUpdated: new Date().toISOString() },
        meta: { requestId, error: "Authentication required" },
      },
      401
    );
  }

  // Get DB connection
  let db: ReturnType<typeof getDb>;
  try {
    db = getDb(c.env);
  } catch (error) {
    return c.json(
      {
        data: { tokens: [], summary: { totalTokens: 0, totalSupply: 0, totalHolders: 0, deployedTokens: 0, pendingTokens: 0 }, lastUpdated: new Date().toISOString() },
        meta: { requestId, error: "Database connection failed" },
      },
      503
    );
  }

  // Query the user's tokens
  let rows: Array<Record<string, unknown>>;
  try {
    if (projectId) {
      rows = await db.queryMany<Record<string, unknown>>(
        "SELECT * FROM issued_tokens WHERE organization_id = ? AND project_id = ? ORDER BY created_at DESC",
        [orgId, projectId]
      );
    } else {
      rows = await db.queryMany<Record<string, unknown>>(
        "SELECT * FROM issued_tokens WHERE organization_id = ? ORDER BY created_at DESC",
        [orgId]
      );
    }
  } catch (error) {
    console.error("User analytics DB query failed:", error);
    return c.json(
      {
        data: { tokens: [], summary: { totalTokens: 0, totalSupply: 0, totalHolders: 0, deployedTokens: 0, pendingTokens: 0 }, lastUpdated: new Date().toISOString() },
        meta: { requestId, error: "Database query failed" },
      },
      500
    );
  }

  const rpcUrl = c.env.SOLANA_RPC_URL ?? DEVNET_RPC;

  // Enrich each token with RPC data
  const tokenEntries: UserTokenEntry[] = [];
  let totalSupply = 0;
  let totalHolders = 0;
  let deployedTokens = 0;
  let pendingTokens = 0;

  for (const row of rows) {
    const mintAddress = (row.mint_address as string | null | undefined) ?? null;
    const decimals = (row.decimals as number) ?? 0;
    const status = (row.status as string) ?? "unknown";

    let supply = 0;
    let holderCount = 0;

    if (mintAddress) {
      try {
        const [supplyResult, holders] = await Promise.all([
          getTokenSupply(rpcUrl, mintAddress),
          getHolderCount(rpcUrl, mintAddress),
        ]);
        supply = Number.parseFloat(supplyResult.amount) / 10 ** supplyResult.decimals;
        holderCount = holders;
      } catch (error) {
        // If RPC fails for a specific token, use 0 — don't fail the whole request
        console.error(`RPC query failed for mint ${mintAddress}:`, error);
      }
    }

    const tokenSupply = supply;
    totalSupply += tokenSupply;
    totalHolders += holderCount;

    if (status === "deployed" || status === "active") {
      deployedTokens++;
    } else {
      pendingTokens++;
    }

    tokenEntries.push({
      tokenId: row.id as string,
      mintAddress,
      name: row.name as string,
      symbol: row.symbol as string,
      decimals,
      status,
      template: (row.template as string) ?? "custom",
      totalSupply: tokenSupply,
      holderCount,
      medianBalance: holderCount > 0 ? Math.round(tokenSupply / holderCount) : 0,
      deployedAt: (row.deployed_at as string | null | undefined) ?? null,
      createdAt: row.created_at as string,
    });
  }

  const response: UserAnalyticsResponse = {
    tokens: tokenEntries,
    summary: {
      totalTokens: tokenEntries.length,
      totalSupply,
      totalHolders,
      deployedTokens,
      pendingTokens,
    },
    lastUpdated: new Date().toISOString(),
  };

  return c.json({ data: response, meta: { requestId, timestamp: new Date().toISOString() } });
});

export default userAnalytics;