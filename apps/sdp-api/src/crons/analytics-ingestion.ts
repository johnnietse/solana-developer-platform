/**
 * Analytics Ingestion Cron Handler
 *
 * Called every 5 minutes by Cloudflare Workers cron trigger.
 * For each configured mint:
 *   1. Query RPC for token supply + holders
 *   2. Write snapshots to Databricks token_supply_snapshots + token_holders
 *   3. Upsert wallet addresses into wallet_labels
 *   4. Compute and cache analytics response in analytics_cache
 */

import type { Env } from "@/types/env";
import { queryDatabricks } from "@/lib/databricks-query";
import { rpcCall } from "@/lib/rpc-utils";

const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

interface MintMeta {
  symbol: string;
  name: string;
}

// Known mints for display metadata (lightweight — no RPC needed)
const KNOWN_MINTS: Record<string, MintMeta> = {
  "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr": { symbol: "USDC", name: "USD Coin" },
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": { symbol: "USDC", name: "USD Coin" },
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": { symbol: "USDT", name: "Tether USD" },
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPXg4gQzNBP": { symbol: "PYUSD", name: "PayPal USD" },
};

async function ingestMint(env: Env, mint: string): Promise<void> {
  const rpcUrl = env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
  const now = new Date().toISOString();
  const meta = KNOWN_MINTS[mint] ?? { symbol: mint.slice(0, 8), name: `Token ${mint.slice(0, 8)}` };

  // 1. Get token supply (with retry)
  let supplyResult: any;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      supplyResult = await rpcCall(rpcUrl, "getTokenSupply", [mint]);
      break;
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }

  const { amount, decimals } = supplyResult.value;
  const supplyAdjusted = Number.parseFloat(amount) / 10 ** decimals;

  // 2. Get holders via getProgramAccounts (with retry)
  let accounts: any[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      accounts = (await rpcCall(rpcUrl, "getProgramAccounts", [
        TOKEN_PROGRAM_ID,
        {
          encoding: "jsonParsed",
          filters: [
            { dataSize: 165 },
            { memcmp: { offset: 0, bytes: mint } },
          ],
        },
      ])) as any[];
      break;
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }

  const holders: Array<{ walletAddress: string; balance: number }> = (accounts || []).map((acct: any) => {
    const info = acct.account?.data?.parsed?.info;
    return {
      walletAddress: info?.owner || acct.pubkey,
      balance: info?.tokenAmount?.uiAmount || 0,
    };
  });

  const slot = supplyResult.context?.slot ?? 0;

  // 3. Write supply snapshot
  await queryDatabricks(env,
    `INSERT INTO workspace.default.token_supply_snapshots
     (mint_address, supply, decimals, slot, snapshot_at)
     VALUES ('${mint}', ${supplyAdjusted}, ${decimals}, ${slot}, '${now}')`,
    "30s"
  );

  // 4. Write holders (batch of 100)
  if (holders.length > 0) {
    const batchSize = 100;
    for (let i = 0; i < holders.length; i += batchSize) {
      const batch = holders.slice(i, i + batchSize);
      const values = batch.map(h =>
        `('${mint}', '${h.walletAddress}', ${h.balance}, ${slot}, '${now}')`
      ).join(",\n");
      await queryDatabricks(env,
        `INSERT INTO workspace.default.token_holders
         (mint_address, wallet_address, balance, slot, snapshot_at)
         VALUES ${values}`,
        "30s"
      );
    }
  }

  // 5. Upsert wallet labels
  const uniqueWallets = [...new Set(holders.map(h => h.walletAddress))];
  if (uniqueWallets.length > 0) {
    const labelValues = uniqueWallets.map(w =>
      `('${w}', 'Unknown', 'unknown', 'sdp-analytics', '${now}')`
    ).join(",\n");
    await queryDatabricks(env,
      `INSERT INTO workspace.default.wallet_labels
       (wallet_address, geography, attribution_category, source, updated_at)
       VALUES ${labelValues}`,
      "30s"
    );
  }

  // 6. Compute and cache analytics response
  const totalHolders = holders.length;
  const totalBalance = holders.reduce((s: number, h: any) => s + h.balance, 0);
  const medianBalance = totalHolders > 0 ? Math.round(totalBalance / totalHolders) : 0;

  const cachePayload = {
    stablecoins: [{
      mintAddress: mint,
      symbol: meta.symbol,
      name: meta.name,
      totalSupply: supplyAdjusted,
      circulatingSupply: supplyAdjusted,
      holderCount: totalHolders,
      medianBalance,
      priceUsd: 1,
      marketCapUsd: supplyAdjusted,
      percentChange24h: 0,
    }],
    holders: {
      totalHolders,
      geography: [{ region: "Unknown", percentage: 100, holderCount: totalHolders }],
      attribution: [{ category: "unknown", percentage: 100, holderCount: totalHolders }],
    },
    lastUpdated: now,
  };

  await queryDatabricks(env,
    `INSERT INTO workspace.default.analytics_cache
     (response_json, holder_count, total_supply, snapshot_at)
     VALUES ('${JSON.stringify(cachePayload).replace(/'/g, "''")}', ${totalHolders}, ${supplyAdjusted}, '${now}')`,
    "30s"
  );
}

export async function handleAnalyticsIngestion(env: Env, ctx: ExecutionContext): Promise<Response> {
  if (env.ANALYTICS_ENABLED !== "true") {
    return new Response("Analytics ingestion disabled", { status: 200 });
  }

  const mints = (env.ANALYTICS_MINTS ?? "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr")
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m.length > 0);

  const results: Array<{ mint: string; success: boolean; error?: string }> = [];

  for (const mint of mints) {
    try {
      await ingestMint(env, mint);
      results.push({ mint, success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Analytics ingestion failed for ${mint}:`, message);
      results.push({ mint, success: false, error: message });
    }
  }

  const failed = results.filter((r) => !r.success);
  const status = failed.length === 0 ? 200 : failed.length === results.length ? 500 : 207;

  return new Response(JSON.stringify({ results, timestamp: new Date().toISOString() }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
