#!/usr/bin/env node
/**
 * Analytics Data Ingestion Script
 *
 * Pulls real on-chain data from Solana RPC for a given token mint and
 * stores it in Databricks tables. Run on-demand or via cron.
 *
 * Usage:
 *   node scripts/ingest-analytics.mjs Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr
 *
 * Arguments:
 *   <mint>  — Solana token mint address (base58). Defaults to USDC devnet.
 *
 * Environment variables:
 *   DATABRICKS_HOST        - Databricks workspace URL (e.g. dbc-xxx.cloud.databricks.com)
 *   DATABRICKS_TOKEN       - Databricks personal access token
 *   DATABRICKS_WAREHOUSE_ID - SQL warehouse ID
 *   SOLANA_RPC_URL         - Solana RPC URL (default: https://api.devnet.solana.com)
 *   TOKEN_SYMBOL           - Override display symbol (auto-detected for known mints)
 *   TOKEN_NAME             - Override display name (auto-detected for known mints)
 */

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

// ── Known mint lookup ──────────────────────────────────────────────────────
// Extend this map as new tokens are added. Falls back to mint address suffix.
const KNOWN_MINTS = {
  "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr": { symbol: "USDC", name: "USD Coin" },
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": { symbol: "USDC", name: "USD Coin" },
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": { symbol: "USDT", name: "Tether USD" },
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPXg4gQzNBP": { symbol: "PYUSD", name: "PayPal USD" },
};

// ── Parse CLI arguments ────────────────────────────────────────────────────
const MINT = process.argv[2] || "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr";
const mintMeta = KNOWN_MINTS[MINT] || {};
const SYMBOL = process.env.TOKEN_SYMBOL || mintMeta.symbol || MINT.slice(0, 8);
const NAME = process.env.TOKEN_NAME || mintMeta.name || `Token ${MINT.slice(0, 8)}`;

const DATABRICKS_HOST = process.env.DATABRICKS_HOST;
const DATABRICKS_TOKEN = process.env.DATABRICKS_TOKEN;
const DATABRICKS_WAREHOUSE_ID = process.env.DATABRICKS_WAREHOUSE_ID;

let id = 1;

async function rpcCall(method, params = [], retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
      });
      const json = await res.json();
      if (json.error) {
        if (json.error.message?.includes("Too many requests") && i < retries - 1) {
          await new Promise(r => setTimeout(r, 1000 * (i + 1)));
          continue;
        }
        throw new Error(json.error.message);
      }
      return json.result;
    } catch (e) {
      if (i < retries - 1) {
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        continue;
      }
      throw e;
    }
  }
}

async function databricksQuery(sql) {
  if (!DATABRICKS_HOST || !DATABRICKS_TOKEN || !DATABRICKS_WAREHOUSE_ID) {
    console.warn("Databricks credentials not configured, skipping DB write");
    return null;
  }

  const url = `https://${DATABRICKS_HOST}/api/2.0/sql/statements`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${DATABRICKS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      warehouse_id: DATABRICKS_WAREHOUSE_ID,
      catalog: "workspace",
      schema: "default",
      statement: sql,
      wait_timeout: "30s",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Databricks query failed (${res.status}): ${body}`);
  }

  return res.json();
}

async function main() {
  console.log("\n=== Analytics Data Ingestion ===\n");
  const now = new Date().toISOString();

  console.log(`Ingesting data for ${SYMBOL} (${NAME}) — mint: ${MINT}\n`);

  // 1. Get token supply
  console.log("1. Querying token supply...");
  const supplyResult = await rpcCall("getTokenSupply", [MINT]);
  const { amount, decimals } = supplyResult.value;
  const supplyAdjusted = Number.parseFloat(amount) / 10 ** decimals;
  console.log(`   Supply: ${supplyAdjusted.toLocaleString()} ${SYMBOL}`);

  // 2. Get holder count and wallet addresses
  console.log("2. Querying token holders...");
  const accounts = await rpcCall("getProgramAccounts", [
    TOKEN_PROGRAM_ID,
    {
      encoding: "jsonParsed",
      filters: [
        { dataSize: 165 },
        { memcmp: { offset: 0, bytes: MINT } },
      ],
    },
  ]);

  const holders = (accounts || []).map(acct => {
    const info = acct.account?.data?.parsed?.info;
    return {
      walletAddress: info?.owner || acct.pubkey,
      balance: info?.tokenAmount?.uiAmount || 0,
    };
  });

  console.log(`   Found ${holders.length} holders`);

  // 3. Get recent signatures (activity proxy)
  console.log("3. Querying recent activity...");
  let recentTxCount = 0;
  try {
    const sigs = await rpcCall("getSignaturesForAddress", [MINT, { limit: 1000 }]);
    recentTxCount = sigs.length;
    console.log(`   ${recentTxCount} recent signatures`);
  } catch (e) {
    console.log(`   Skipped: ${e.message}`);
  }

  // 4. Write to Databricks
  console.log("\n4. Writing to Databricks...");

  // 4a. Insert token supply snapshot
  const supplySql = `INSERT INTO workspace.default.token_supply_snapshots
    (mint_address, supply, decimals, slot, snapshot_at)
  VALUES ('${MINT}', ${supplyAdjusted}, ${decimals}, ${supplyResult.context?.slot || 0}, '${now}')`;
  await databricksQuery(supplySql);
  console.log("   Supply snapshot written");

  // 4b. Insert holders (batch insert)
  if (holders.length > 0) {
    const batchSize = 100;
    for (let i = 0; i < holders.length; i += batchSize) {
      const batch = holders.slice(i, i + batchSize);
      const values = batch.map(h =>
        `('${MINT}', '${h.walletAddress}', ${h.balance}, ${supplyResult.context?.slot || 0}, '${now}')`
      ).join(",\n");
      const insertSql = `INSERT INTO workspace.default.token_holders
        (mint_address, wallet_address, balance, slot, snapshot_at)
        VALUES ${values}`;
      await databricksQuery(insertSql);
    }
    console.log(`   ${holders.length} holders written (${Math.ceil(holders.length / batchSize)} batches)`);
  }

  // 4c. Populate wallet_labels (upsert new wallet addresses)
  if (holders.length > 0) {
    const uniqueHolders = [...new Set(holders.map(h => h.walletAddress))];
    // Quote-safe: wallet addresses are base58, no special chars
    const labelValues = uniqueHolders.map(w =>
      `('${w}', 'Unknown', 'unknown', 'sdp-analytics', '${now}')`
    ).join(",\n");
    const labelSql = `INSERT INTO workspace.default.wallet_labels
      (wallet_address, geography, attribution_category, source, updated_at)
      VALUES ${labelValues}`;
    await databricksQuery(labelSql);
    console.log(`   ${uniqueHolders.length} wallet labels upserted`);
  }

  // 4d. Compute and cache analytics response
  const totalHolders = holders.length;
  const totalBalance = holders.reduce((s, h) => s + h.balance, 0);
  const medianBalance = totalHolders > 0 ? Math.round(totalBalance / totalHolders) : 0;

  const cachePayload = {
    stablecoins: [{
      mintAddress: MINT,
      symbol: SYMBOL,
      name: NAME,
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
    holdersHistory: [],
    supplyHistory: [],
    lastUpdated: now,
  };

  const cacheSql = `INSERT INTO workspace.default.analytics_cache
    (response_json, holder_count, total_supply, snapshot_at)
    VALUES ('${JSON.stringify(cachePayload).replace(/'/g, "''")}', ${totalHolders}, ${supplyAdjusted}, '${now}')`;
  await databricksQuery(cacheSql);
  console.log("   Analytics cache written");

  console.log(`\n=== Ingestion Complete: ${SYMBOL} (${MINT}) ===`);
}

main().catch(e => {
  console.error("Fatal:", e.message);
  process.exit(1);
});